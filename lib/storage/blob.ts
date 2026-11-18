/**
 * Reference Dataset Blob Storage Adapter (Step 10a.2).
 *
 * Mirrors the 3-tier adapter design of `lib/storage/store.ts`:
 *   1. Vercel Blob REST API — used when `BLOB_READ_WRITE_TOKEN` is set
 *   2. Local filesystem (`.data/blobs/<referenceId>.json`) — local dev (`NODE_ENV !== 'test'`)
 *   3. In-memory (`MemoryBlobStore`) — unit tests & serverless fallback
 *
 * Every stored reference dataset has `{ meta, rows }` where `meta.sha256` is the
 * SHA-256 digest of the canonical rows JSON. Built-in reference datasets
 * (`ascore_v1_dev855`) are read-only and cannot be overwritten.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { recordBlobRead, recordBlobWrite } from './store';
import type { ReferenceDatasetMeta } from '../types';
import ascoreV1Dev855 from '../../data/reference/ascore_v1_dev855.json';
import { registerReferenceDataset } from '../reference';

export type BlobStoreKind = 'vercel-blob' | 'file' | 'memory';

export interface ReferenceDatasetBlob {
  meta: ReferenceDatasetMeta;
  rows: Record<string, string | number | null | undefined>[];
}

export interface ReferenceBlobStore {
  kind: BlobStoreKind;
  persistent: boolean;
  get(referenceId: string): Promise<ReferenceDatasetBlob | null>;
  put(referenceId: string, blob: ReferenceDatasetBlob): Promise<void>;
  del(referenceId: string): Promise<void>;
  list(): Promise<ReferenceDatasetMeta[]>;
  peekSync?(referenceId: string): ReferenceDatasetBlob | null;
  putSync?(referenceId: string, blob: ReferenceDatasetBlob): void;
  saveRunDetail?(runId: string, detail: unknown): Promise<string>;
  loadRunDetail?(runId: string): Promise<unknown | null>;
  delRunDetail?(runId: string): Promise<void>;
}

export const BUILT_IN_REFERENCE_IDS = new Set<string>(['ascore_v1_dev855']);

const BUILT_IN_BLOBS: Record<string, ReferenceDatasetBlob> = {
  ascore_v1_dev855: ascoreV1Dev855 as unknown as ReferenceDatasetBlob,
};

export function isBuiltInReferenceId(referenceId: string): boolean {
  return BUILT_IN_REFERENCE_IDS.has(referenceId);
}

/** Deterministic SHA-256 hex digest of reference rows. */
export function computeRowsSha256(
  rows: Record<string, unknown>[],
  columns?: string[],
): string {
  const cols =
    columns && columns.length > 0
      ? [...columns]
      : rows.length > 0
        ? Object.keys(rows[0]).sort()
        : [];
  const canonical = rows.map(r => {
    const obj: Record<string, unknown> = {};
    for (const c of cols) obj[c] = r[c] ?? null;
    return obj;
  });
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// ─── 1. Vercel Blob REST Adapter ─────────────────────────────────────────────
export function getBlobAccess(): 'private' | 'public' {
  const envAccess = process.env.BLOB_ACCESS?.trim().toLowerCase();
  return envAccess === 'public' ? 'public' : 'private';
}

export async function extractErrorSnippet(res: Response, token?: string): Promise<string> {
  try {
    let text = await res.text();
    if (!text) return '';
    if (token && token.length > 5) {
      text = text.replaceAll(token, '[REDACTED_TOKEN]');
    }
    text = text.replace(/vercel_blob_[a-zA-Z0-9_\-]+/g, '[REDACTED_TOKEN]');
    text = text.replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED_TOKEN]');
    const clean = text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return clean.length > 300 ? clean.slice(0, 300) : clean;
  } catch {
    return '';
  }
}

export class VercelBlobStore implements ReferenceBlobStore {
  kind: BlobStoreKind = 'vercel-blob';
  persistent = true;
  private baseUrl = 'https://blob.vercel-storage.com';

  constructor(private token: string) {}

  private blobPath(referenceId: string): string {
    return `references/${referenceId}.json`;
  }

  async put(referenceId: string, blob: ReferenceDatasetBlob): Promise<void> {
    const pathname = this.blobPath(referenceId);
    const access = getBlobAccess();
    const res = await fetch(`${this.baseUrl}/${pathname}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'x-add-random-suffix': '0',
        'x-cache-control-max-age': '60',
        'x-vercel-blob-access': access,
      },
      body: JSON.stringify(blob),
      cache: 'no-store',
    });
    if (!res.ok) {
      const snippet = await extractErrorSnippet(res, this.token);
      throw new Error(
        `Vercel Blob PUT "${referenceId}" failed: HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`,
      );
    }
  }

  async get(referenceId: string): Promise<ReferenceDatasetBlob | null> {
    const prefix = this.blobPath(referenceId);
    const listRes = await fetch(
      `${this.baseUrl}?prefix=${encodeURIComponent(prefix)}&limit=1`,
      {
        headers: { Authorization: `Bearer ${this.token}` },
        cache: 'no-store',
      },
    );
    if (!listRes.ok) {
      if (listRes.status === 404) return null;
      const snippet = await extractErrorSnippet(listRes, this.token);
      throw new Error(
        `Vercel Blob GET "${referenceId}" list failed: HTTP ${listRes.status}${snippet ? `: ${snippet}` : ''}`,
      );
    }
    const listBody = (await listRes.json()) as {
      blobs?: { pathname: string; url: string; downloadUrl?: string }[];
    };
    const match = listBody.blobs?.find(b => b.pathname === prefix);
    if (!match) return null;

    const dlUrl = match.downloadUrl || match.url;
    const dlRes = await fetch(dlUrl, {
      headers: { Authorization: `Bearer ${this.token}` },
      cache: 'no-store',
    });
    if (!dlRes.ok) {
      if (dlRes.status === 404) return null;
      const snippet = await extractErrorSnippet(dlRes, this.token);
      throw new Error(
        `Vercel Blob GET "${referenceId}" download failed: HTTP ${dlRes.status}${snippet ? `: ${snippet}` : ''}`,
      );
    }
    return (await dlRes.json()) as ReferenceDatasetBlob;
  }

  async del(referenceId: string): Promise<void> {
    const prefix = this.blobPath(referenceId);
    const listRes = await fetch(
      `${this.baseUrl}?prefix=${encodeURIComponent(prefix)}&limit=5`,
      {
        headers: { Authorization: `Bearer ${this.token}` },
        cache: 'no-store',
      },
    );
    if (!listRes.ok) {
      if (listRes.status === 404) return;
      const snippet = await extractErrorSnippet(listRes, this.token);
      throw new Error(
        `Vercel Blob DELETE "${referenceId}" list failed: HTTP ${listRes.status}${snippet ? `: ${snippet}` : ''}`,
      );
    }
    const listBody = (await listRes.json()) as { blobs?: { url: string }[] };
    const urls = (listBody.blobs ?? []).map(b => b.url);
    if (urls.length === 0) return;
    const delRes = await fetch(`${this.baseUrl}/delete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ urls }),
      cache: 'no-store',
    });
    if (!delRes.ok) {
      const snippet = await extractErrorSnippet(delRes, this.token);
      throw new Error(
        `Vercel Blob DELETE "${referenceId}" failed: HTTP ${delRes.status}${snippet ? `: ${snippet}` : ''}`,
      );
    }
  }

  async saveRunDetail(runId: string, detail: unknown): Promise<string> {
    const pathname = `run-details/${runId}.json`;
    const res = await fetch(`${this.baseUrl}/${pathname}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'x-add-random-suffix': '0',
        'x-cache-control-max-age': '60',
        'x-vercel-blob-access': 'private',
      },
      body: JSON.stringify(detail),
      cache: 'no-store',
    });
    if (!res.ok) {
      const snippet = await extractErrorSnippet(res, this.token);
      throw new Error(
        `Vercel Blob PUT run detail "${runId}" failed: HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`,
      );
    }
    const data = (await res.json().catch(() => null)) as { url?: string } | null;
    return data?.url || `${this.baseUrl}/${pathname}`;
  }

  async loadRunDetail(runId: string): Promise<unknown | null> {
    const prefix = `run-details/${runId}.json`;
    const listRes = await fetch(
      `${this.baseUrl}?prefix=${encodeURIComponent(prefix)}&limit=1`,
      {
        headers: { Authorization: `Bearer ${this.token}` },
        cache: 'no-store',
      },
    );
    if (!listRes.ok) return null;
    const listBody = (await listRes.json()) as {
      blobs?: { pathname: string; url: string; downloadUrl?: string }[];
    };
    const match = listBody.blobs?.find(b => b.pathname === prefix);
    if (!match) return null;

    const dlUrl = match.downloadUrl || match.url;
    const dlRes = await fetch(dlUrl, {
      headers: { Authorization: `Bearer ${this.token}` },
      cache: 'no-store',
    });
    if (!dlRes.ok) return null;
    return (await dlRes.json()) as unknown;
  }

  async delRunDetail(runId: string): Promise<void> {
    const prefix = `run-details/${runId}.json`;
    const listRes = await fetch(
      `${this.baseUrl}?prefix=${encodeURIComponent(prefix)}&limit=1`,
      {
        headers: { Authorization: `Bearer ${this.token}` },
        cache: 'no-store',
      },
    );
    if (!listRes.ok) return;
    const listBody = (await listRes.json()) as {
      blobs?: { url: string }[];
    };
    const match = listBody.blobs?.[0];
    if (!match) return;

    await fetch(`${this.baseUrl}/delete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ urls: [match.url] }),
      cache: 'no-store',
    });
  }

  async list(): Promise<ReferenceDatasetMeta[]> {
    const listRes = await fetch(`${this.baseUrl}?prefix=references/&limit=100`, {
      headers: { Authorization: `Bearer ${this.token}` },
      cache: 'no-store',
    });
    if (!listRes.ok) {
      if (listRes.status === 404) return [];
      const snippet = await extractErrorSnippet(listRes, this.token);
      throw new Error(
        `Vercel Blob LIST failed: HTTP ${listRes.status}${snippet ? `: ${snippet}` : ''}`,
      );
    }
    const listBody = (await listRes.json()) as {
      blobs?: { url: string; downloadUrl?: string }[];
    };
    const metas: ReferenceDatasetMeta[] = [];
    for (const b of listBody.blobs ?? []) {
      try {
        const dlUrl = b.downloadUrl || b.url;
        const r = await fetch(dlUrl, {
          headers: { Authorization: `Bearer ${this.token}` },
          cache: 'no-store',
        });
        if (r.ok) {
          const parsed = (await r.json()) as ReferenceDatasetBlob;
          if (parsed?.meta) metas.push(parsed.meta);
        }
      } catch {
        // skip unreadable blob
      }
    }
    return metas;
  }
}

// ─── 2. Memory & File Blob Adapters ──────────────────────────────────────────
class MemoryBlobStore implements ReferenceBlobStore {
  kind: BlobStoreKind = 'memory';
  persistent = false;
  protected blobs = new Map<string, ReferenceDatasetBlob>();
  protected runDetails = new Map<string, unknown>();

  async get(referenceId: string): Promise<ReferenceDatasetBlob | null> {
    const b = this.blobs.get(referenceId);
    return b ? structuredClone(b) : null;
  }

  async put(referenceId: string, blob: ReferenceDatasetBlob): Promise<void> {
    this.blobs.set(referenceId, structuredClone(blob));
  }

  async del(referenceId: string): Promise<void> {
    this.blobs.delete(referenceId);
  }

  async list(): Promise<ReferenceDatasetMeta[]> {
    return [...this.blobs.values()].map(b => structuredClone(b.meta));
  }

  peekSync(referenceId: string): ReferenceDatasetBlob | null {
    const b = this.blobs.get(referenceId);
    return b ? structuredClone(b) : null;
  }

  putSync(referenceId: string, blob: ReferenceDatasetBlob): void {
    this.blobs.set(referenceId, structuredClone(blob));
  }

  async saveRunDetail(runId: string, detail: unknown): Promise<string> {
    this.runDetails.set(runId, structuredClone(detail));
    return `memory://run-details/${runId}.json`;
  }

  async loadRunDetail(runId: string): Promise<unknown | null> {
    const hit = this.runDetails.get(runId);
    return hit ? structuredClone(hit) : null;
  }

  async delRunDetail(runId: string): Promise<void> {
    this.runDetails.delete(runId);
  }
}

class FileBlobStore extends MemoryBlobStore {
  kind: BlobStoreKind = 'file';
  persistent = true;

  constructor(private dir: string) {
    super();
    this.loadExisting();
  }

  private filePath(referenceId: string): string {
    const safe = referenceId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  private loadExisting() {
    try {
      if (!fs.existsSync(this.dir)) return;
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(
            fs.readFileSync(path.join(this.dir, f), 'utf8'),
          ) as ReferenceDatasetBlob;
          if (parsed?.meta?.referenceId && Array.isArray(parsed.rows)) {
            this.blobs.set(parsed.meta.referenceId, parsed);
          }
        } catch {
          // ignore invalid file
        }
      }
    } catch {
      // ignore missing directory
    }
  }

  private writeDisk(referenceId: string, blob: ReferenceDatasetBlob) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.filePath(referenceId), JSON.stringify(blob, null, 2));
  }

  override async put(referenceId: string, blob: ReferenceDatasetBlob): Promise<void> {
    await super.put(referenceId, blob);
    this.writeDisk(referenceId, blob);
  }

  override putSync(referenceId: string, blob: ReferenceDatasetBlob): void {
    super.putSync(referenceId, blob);
    this.writeDisk(referenceId, blob);
  }

  override async del(referenceId: string): Promise<void> {
    await super.del(referenceId);
    try {
      fs.unlinkSync(this.filePath(referenceId));
    } catch {
      // ignore if absent
    }
  }

  private runDetailPath(runId: string): string {
    const safe = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dir, 'run_details', `${safe}.json`);
  }

  override async saveRunDetail(runId: string, detail: unknown): Promise<string> {
    await super.saveRunDetail(runId, detail);
    const fp = this.runDetailPath(runId);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(detail, null, 2));
    return `file://${fp}`;
  }

  override async loadRunDetail(runId: string): Promise<unknown | null> {
    const mem = await super.loadRunDetail(runId);
    if (mem) return mem;
    const fp = this.runDetailPath(runId);
    if (fs.existsSync(fp)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
        await super.saveRunDetail(runId, parsed);
        return parsed;
      } catch {
        return null;
      }
    }
    return null;
  }

  override async delRunDetail(runId: string): Promise<void> {
    await super.delRunDetail(runId);
    const fp = this.runDetailPath(runId);
    try {
      fs.unlinkSync(fp);
    } catch {
      // ignore if absent
    }
  }
}

// ─── Factory & High-level helpers ────────────────────────────────────────────
const g = globalThis as unknown as { __crmBlobStore?: ReferenceBlobStore };

function wrapBlobStoreWithTracker(baseStore: ReferenceBlobStore): ReferenceBlobStore {
  return new Proxy(baseStore, {
    get(target, prop) {
      const orig = (target as any)[prop];
      if (typeof orig === 'function') {
        return function (this: any, ...args: any[]) {
          if (prop === 'get' || prop === 'has' || prop === 'head') {
            recordBlobRead();
          } else if (prop === 'put' || prop === 'del' || prop === 'delete') {
            recordBlobWrite();
          }
          return orig.apply(target, args);
        };
      }
      return orig;
    },
  });
}

export function getBlobStore(): ReferenceBlobStore {
  let rawStore: ReferenceBlobStore;
  if (g.__crmBlobStore) {
    rawStore = g.__crmBlobStore;
  } else {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (token) {
      g.__crmBlobStore = new VercelBlobStore(token);
    } else if (!process.env.VERCEL && process.env.NODE_ENV !== 'test') {
      g.__crmBlobStore = new FileBlobStore(path.join(process.cwd(), '.data', 'blobs'));
    } else {
      g.__crmBlobStore = new MemoryBlobStore();
    }
    rawStore = g.__crmBlobStore;
  }
  return wrapBlobStoreWithTracker(rawStore);
}

export function setBlobStore(store: ReferenceBlobStore | undefined): void {
  g.__crmBlobStore = store;
}

export function createMemoryBlobStore(): ReferenceBlobStore {
  return new MemoryBlobStore();
}

export function blobStorageInfo() {
  const s = getBlobStore();
  return { kind: s.kind, persistent: s.persistent };
}

/**
 * Saves a reference dataset `{ meta, rows }` to blob storage and registers it
 * in the in-memory `lib/reference.ts` registry for fast access.
 * Built-in reference datasets (`ascore_v1_dev855`) cannot be overwritten.
 */
export async function saveReferenceDatasetBlob(
  blob: ReferenceDatasetBlob,
): Promise<ReferenceDatasetBlob> {
  const refId = blob.meta.referenceId;
  if (isBuiltInReferenceId(refId)) {
    throw new Error(`ไม่สามารถแก้ไขหรือเขียนทับ Reference Dataset มาตรฐาน (Built-in) "${refId}" ได้`);
  }
  const sha256 = computeRowsSha256(blob.rows, blob.meta.columns);
  const normalized: ReferenceDatasetBlob = {
    meta: {
      ...blob.meta,
      rowCount: blob.rows.length,
      sha256,
    },
    rows: blob.rows.map(r => ({ ...r })),
  };
  await getBlobStore().put(refId, normalized);
  registerReferenceDataset(normalized.meta, normalized.rows);
  return normalized;
}

/**
 * Loads a reference dataset `{ meta, rows }` from blob storage or built-in bundle.
 */
export async function loadReferenceDatasetBlob(
  referenceId: string,
): Promise<ReferenceDatasetBlob | null> {
  if (isBuiltInReferenceId(referenceId)) {
    const builtIn = BUILT_IN_BLOBS[referenceId];
    return builtIn ? structuredClone(builtIn) : null;
  }
  const hit = await getBlobStore().get(referenceId);
  if (hit) {
    registerReferenceDataset(hit.meta, hit.rows);
    return hit;
  }
  return null;
}

export async function saveRunDetailBlob(runId: string, detail: unknown): Promise<string> {
  const store = getBlobStore();
  if (store.saveRunDetail) {
    return store.saveRunDetail(runId, detail);
  }
  throw new Error('Blob store does not support saveRunDetail');
}

export async function loadRunDetailBlob(runIdOrUrl: string): Promise<unknown | null> {
  const store = getBlobStore();
  const runId = runIdOrUrl
    .replace(/^.*\/run-details\//, '')
    .replace(/\.json.*$/, '')
    .replace(/^memory:\/\/run-details\//, '')
    .replace(/^file:\/\/.*\/run_details\//, '');
  if (store.loadRunDetail) {
    return store.loadRunDetail(runId);
  }
  return null;
}

export async function deleteRunDetailBlob(runIdOrUrl: string): Promise<void> {
  const store = getBlobStore();
  const runId = runIdOrUrl
    .replace(/^.*\/run-details\//, '')
    .replace(/\.json.*$/, '')
    .replace(/^memory:\/\/run-details\//, '')
    .replace(/^file:\/\/.*\/run_details\//, '');
  if (store.delRunDetail) {
    await store.delRunDetail(runId);
  }
}

