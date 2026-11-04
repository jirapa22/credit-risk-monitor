/**
 * Persistence adapter.
 *
 * Vercel serverless functions have a read-only filesystem, so anything that
 * must survive between requests goes to a key-value store:
 *
 *   1. Upstash Redis (REST)  — used when env vars are present:
 *        KV_REST_API_URL + KV_REST_API_TOKEN        (Vercel KV / Upstash integration)
 *        or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *   2. Local JSON file (.data/store.json) — local `npm run dev` only
 *   3. In-memory — last resort (data lost on cold start; UI shows a warning)
 *
 * No SDK dependency: Upstash REST accepts a JSON command array via fetch.
 */
import fs from 'fs';
import path from 'path';

export type StoreKind = 'upstash' | 'file' | 'memory';

export interface KeyValueStore {
  kind: StoreKind;
  persistent: boolean;
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /** prepend to a list and keep at most `max` items */
  listPush(key: string, value: unknown, max: number): Promise<void>;
  listRange<T>(key: string, limit: number): Promise<T[]>;
}

// ─── Upstash ────────────────────────────────────────────────────────────────
class UpstashStore implements KeyValueStore {
  kind = 'upstash' as const;
  persistent = true;
  constructor(private url: string, private token: string) {}

  private async cmd<T>(...args: (string | number)[]): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      cache: 'no-store',
    });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(`Upstash ${args[0]} failed: ${body.error ?? res.status}`);
    return body.result as T;
  }
  private async pipeline(cmds: (string | number)[][]) {
    const res = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Upstash pipeline failed: ${res.status}`);
  }
  async get<T>(key: string) {
    const v = await this.cmd<string | null>('GET', key);
    return v === null ? null : (JSON.parse(v) as T);
  }
  async set(key: string, value: unknown) { await this.cmd('SET', key, JSON.stringify(value)); }
  async del(key: string) { await this.cmd('DEL', key); }
  async listPush(key: string, value: unknown, max: number) {
    await this.pipeline([['LPUSH', key, JSON.stringify(value)], ['LTRIM', key, 0, max - 1]]);
  }
  async listRange<T>(key: string, limit: number) {
    const items = await this.cmd<string[]>('LRANGE', key, 0, limit - 1);
    return items.map(s => JSON.parse(s) as T);
  }
}

// ─── Memory / File ──────────────────────────────────────────────────────────
type Data = Record<string, unknown>;

class MemoryStore implements KeyValueStore {
  kind: StoreKind = 'memory';
  persistent = false;
  constructor(protected data: Data = {}) {}
  protected flush() {}
  async get<T>(key: string) { return (this.data[key] as T) ?? null; }
  async set(key: string, value: unknown) { this.data[key] = structuredClone(value); this.flush(); }
  async del(key: string) { delete this.data[key]; this.flush(); }
  async listPush(key: string, value: unknown, max: number) {
    const list = (this.data[key] as unknown[]) ?? [];
    this.data[key] = [structuredClone(value), ...list].slice(0, max);
    this.flush();
  }
  async listRange<T>(key: string, limit: number) { return ((this.data[key] as T[]) ?? []).slice(0, limit); }
}

class FileStore extends MemoryStore {
  kind: StoreKind = 'file';
  persistent = true;
  constructor(private file: string) {
    let data: Data = {};
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
    super(data);
  }
  protected flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────
const g = globalThis as unknown as { __crmStore?: KeyValueStore };

export function getStore(): KeyValueStore {
  if (g.__crmStore) return g.__crmStore;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) g.__crmStore = new UpstashStore(url.replace(/\/$/, ''), token);
  else if (!process.env.VERCEL && process.env.NODE_ENV !== 'test') g.__crmStore = new FileStore(path.join(process.cwd(), '.data', 'store.json'));
  else g.__crmStore = new MemoryStore();
  return g.__crmStore;
}

/** For tests. */
export function setStore(store: KeyValueStore | undefined) { g.__crmStore = store; }
export function createMemoryStore(): KeyValueStore { return new MemoryStore(); }
