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
class VercelBlobStore implements ReferenceBlobStore {
  kind: BlobStoreKind = 'vercel-blob';
  persistent = true;
  private baseUrl = 'https://blob.vercel-storage.com';

  constructor(private token: string) {}

  private blobPath(referenceId: string): string {
    return `references/${referenceId}.json`;
  }

  async put(referenceId: string, blob: ReferenceDatasetBlob): Promise<void> {
    const pathname = this.blobPath(referenceId);
    const res = await fetch(`${this.baseUrl}/${pathname}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'x-add-random-suffix': '0',
        'x-cache-control-max-age': '60',
      },
      body: JSON.stringify(blob),
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`Vercel Blob PUT "${referenceId}" failed: HTTP ${res.status}`);
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
    if (!listRes.ok) return null;
    const listBody = (await listRes.json()) as {
      blobs?: { pathname: string; url: string; downloadUrl?: string }[];
    };
    const match = listBody.blobs?.find(b => b.pathname === prefix);
    if (!match) return null;

    const dlRes = await fetch(match.downloadUrl || match.url, {
      headers: { Authorization: `Bearer ${this.token}` },
      cache: 'no-store',
    });
    if (!dlRes.ok) return null;
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
    if (!listRes.ok) return;
    const listBody = (await listRes.json()) as { blobs?: { url: string }[] };
    const urls = (listBody.blobs ?? []).map(b => b.url);
    if (urls.length === 0) return;
    await fetch(`${this.baseUrl}/delete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ urls }),
      cache: 'no-store',
    });
  }

  async list(): Promise<ReferenceDatasetMeta[]> {
    const listRes = await fetch(`${this.baseUrl}?prefix=references/&limit=100`, {
      headers: { Authorization: `Bearer ${this.token}` },
      cache: 'no-store',
    });
    if (!listRes.ok) return [];
    const listBody = (await listRes.json()) as { blobs?: { url: string }[] };
    const metas: ReferenceDatasetMeta[] = [];
    for (const b of listBody.blobs ?? []) {
      try {
        const r = await fetch(b.url, {
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
}

// ─── Factory & High-level helpers ────────────────────────────────────────────
const g = globalThis as unknown as { __crmBlobStore?: ReferenceBlobStore };

export function getBlobStore(): ReferenceBlobStore {
  if (g.__crmBlobStore) return g.__crmBlobStore;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    g.__crmBlobStore = new VercelBlobStore(token);
  } else if (!process.env.VERCEL && process.env.NODE_ENV !== 'test') {
    g.__crmBlobStore = new FileBlobStore(path.join(process.cwd(), '.data', 'blobs'));
  } else {
    g.__crmBlobStore = new MemoryBlobStore();
  }
  return g.__crmBlobStore;
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
