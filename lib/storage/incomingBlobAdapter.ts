/**
 * Adapter interface and implementations for Blob incoming files (Step 14 / งาน C)
 *
 * Provides a clean abstraction over Vercel Blob storage:
 * - VercelIncomingBlobAdapter: uses Vercel Blob REST API with BLOB_READ_WRITE_TOKEN
 * - MemoryIncomingBlobAdapter: typed in-memory adapter for unit tests (zero `as any`)
 */

export interface IncomingBlobItem {
  pathname: string;
  size: number;
  uploadedAt: string; // ISO 8601 string
  url: string;
  downloadUrl?: string;
  etag?: string;
}

/**
 * Deterministic unique key representing a file's state for deduplication.
 * Format: pathname:size:uploadedAt (or pathname:etag if etag is available).
 * If file content/metadata changes, the key changes.
 */
export function computeBlobFileKey(item: IncomingBlobItem): string {
  if (item.etag && item.etag.trim() !== '') {
    return `${item.pathname}:${item.etag}`;
  }
  return `${item.pathname}:${item.size}:${item.uploadedAt}`;
}

export interface IncomingBlobAdapter {
  list(prefix: string): Promise<IncomingBlobItem[]>;
  get(item: IncomingBlobItem): Promise<string>;
}

/**
 * Production adapter communicating directly with Vercel Blob REST API.
 */
export class VercelIncomingBlobAdapter implements IncomingBlobAdapter {
  private baseUrl = 'https://blob.vercel-storage.com';

  constructor(private token: string) {}

  async list(prefix: string): Promise<IncomingBlobItem[]> {
    const res = await fetch(`${this.baseUrl}?prefix=${encodeURIComponent(prefix)}&limit=100`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      throw new Error(`Vercel Blob list failed: HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      blobs?: Array<{
        pathname: string;
        size: number;
        uploadedAt: string;
        url: string;
        downloadUrl?: string;
        etag?: string;
      }>;
    };

    const blobs = data.blobs || [];
    return blobs.map(b => ({
      pathname: b.pathname,
      size: b.size,
      uploadedAt: b.uploadedAt,
      url: b.url,
      downloadUrl: b.downloadUrl,
      etag: b.etag,
    }));
  }

  async get(item: IncomingBlobItem): Promise<string> {
    const targetUrl = item.downloadUrl || item.url;
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      throw new Error(`Vercel Blob download failed for "${item.pathname}": HTTP ${res.status}`);
    }

    return await res.text();
  }
}

/**
 * In-memory adapter for unit testing and local development.
 */
export class MemoryIncomingBlobAdapter implements IncomingBlobAdapter {
  private blobs = new Map<string, { item: IncomingBlobItem; content: string }>();

  putFile(
    pathname: string,
    content: string,
    uploadedAt?: string,
    size?: number,
    etag?: string,
  ): IncomingBlobItem {
    const computedSize = size ?? Buffer.byteLength(content, 'utf8');
    const timestamp = uploadedAt || new Date().toISOString();
    const item: IncomingBlobItem = {
      pathname,
      size: computedSize,
      uploadedAt: timestamp,
      url: `memory://${pathname}`,
      etag,
    };
    this.blobs.set(pathname, { item, content });
    return item;
  }

  deleteFile(pathname: string): void {
    this.blobs.delete(pathname);
  }

  clear(): void {
    this.blobs.clear();
  }

  async list(prefix: string): Promise<IncomingBlobItem[]> {
    const matches: IncomingBlobItem[] = [];
    for (const [key, entry] of this.blobs.entries()) {
      if (key.startsWith(prefix)) {
        matches.push(entry.item);
      }
    }
    // Return sorted by uploadedAt ascending
    return matches.sort(
      (a, b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime(),
    );
  }

  async get(item: IncomingBlobItem): Promise<string> {
    const entry = this.blobs.get(item.pathname);
    if (!entry) {
      throw new Error(`Blob not found: ${item.pathname}`);
    }
    return entry.content;
  }
}

let activeIncomingAdapter: IncomingBlobAdapter | null = null;

export function getIncomingBlobAdapter(): IncomingBlobAdapter {
  if (activeIncomingAdapter) return activeIncomingAdapter;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    return new VercelIncomingBlobAdapter(token);
  }
  return new MemoryIncomingBlobAdapter();
}

export function setIncomingBlobAdapter(adapter: IncomingBlobAdapter | null): void {
  activeIncomingAdapter = adapter;
}
