/**
 * Tests for VercelBlobStore adapter, private blob access headers, and error reporting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VercelBlobStore,
  getBlobAccess,
  extractErrorSnippet,
  type ReferenceDatasetBlob,
} from '../lib/storage/blob';

describe('VercelBlobStore & Blob Storage Helpers', () => {
  const origEnv = process.env.BLOB_ACCESS;
  const mockToken = 'vercel_blob_rw_test_token_secret_12345';
  let store: VercelBlobStore;

  const sampleBlob: ReferenceDatasetBlob = {
    meta: {
      referenceId: 'test_ref',
      version: '1.0.0',
      modelId: 'ascore_v1',
      description: 'Test Reference Description',
      source: 'test_upload',
      createdAt: '2026-01-01T00:00:00.000Z',
      rowCount: 10,
      badCount: 1,
      badRate: 0.1,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      columns: ['feature_a', 'feature_b'],
      sha256: 'mock_sha256_hash',
    },
    rows: [{ feature_a: 1 }, { feature_a: 2 }],
  };

  beforeEach(() => {
    delete process.env.BLOB_ACCESS;
    store = new VercelBlobStore(mockToken);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.BLOB_ACCESS = origEnv;
    } else {
      delete process.env.BLOB_ACCESS;
    }
    vi.restoreAllMocks();
  });

  describe('getBlobAccess', () => {
    it('defaults to "private" when BLOB_ACCESS is unset', () => {
      delete process.env.BLOB_ACCESS;
      expect(getBlobAccess()).toBe('private');
    });

    it('defaults to "private" for arbitrary or empty values', () => {
      process.env.BLOB_ACCESS = '';
      expect(getBlobAccess()).toBe('private');
      process.env.BLOB_ACCESS = '   ';
      expect(getBlobAccess()).toBe('private');
      process.env.BLOB_ACCESS = 'something_else';
      expect(getBlobAccess()).toBe('private');
    });

    it('returns "public" when BLOB_ACCESS is set to public (case-insensitive with trimming)', () => {
      process.env.BLOB_ACCESS = 'public';
      expect(getBlobAccess()).toBe('public');
      process.env.BLOB_ACCESS = '  PUBLIC  ';
      expect(getBlobAccess()).toBe('public');
    });
  });

  describe('PUT behavior', () => {
    it('sends "x-vercel-blob-access: private" by default with Authorization and required headers', async () => {
      let capturedUrl = '';
      let capturedOptions: RequestInit | undefined;

      const mockFetch = vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        capturedUrl = url;
        capturedOptions = opts;
        return new Response(JSON.stringify({ url: 'https://blob.vercel-storage.com/ref.json' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      await store.put('test_ref', sampleBlob);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(capturedUrl).toBe('https://blob.vercel-storage.com/references/test_ref.json');
      expect(capturedOptions?.method).toBe('PUT');
      const headers = capturedOptions?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${mockToken}`);
      expect(headers['content-type']).toBe('application/json');
      expect(headers['x-vercel-blob-access']).toBe('private');
      expect(headers['x-add-random-suffix']).toBe('0');
      expect(headers['x-cache-control-max-age']).toBe('60');
    });

    it('sends "x-vercel-blob-access: public" when BLOB_ACCESS=public', async () => {
      process.env.BLOB_ACCESS = 'public';

      let capturedOptions: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
        capturedOptions = opts;
        return new Response('{}', { status: 200 });
      });
      vi.stubGlobal('fetch', mockFetch);

      await store.put('test_ref', sampleBlob);

      const headers = capturedOptions?.headers as Record<string, string>;
      expect(headers['x-vercel-blob-access']).toBe('public');
    });

    it('includes response body snippet in error message when PUT fails', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('This store is private. Access must be private.', {
          status: 400,
          statusText: 'Bad Request',
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      await expect(store.put('test_ref', sampleBlob)).rejects.toThrow(
        'Vercel Blob PUT "test_ref" failed: HTTP 400: This store is private. Access must be private.',
      );
    });

    it('redacts tokens from the error response snippet and truncates to 300 characters', async () => {
      const longMessage = `Unauthorized token ${mockToken}. ` + 'x'.repeat(400);
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(longMessage, { status: 403 }),
      );
      vi.stubGlobal('fetch', mockFetch);

      try {
        await store.put('test_ref', sampleBlob);
        expect.unreachable('Should have thrown an error');
      } catch (err: unknown) {
        const msg = (err as Error).message;
        expect(msg).toContain('HTTP 403:');
        expect(msg).not.toContain(mockToken);
        expect(msg).toContain('[REDACTED_TOKEN]');
        // Verify snippet does not exceed max length
        const prefix = 'Vercel Blob PUT "test_ref" failed: HTTP 403: ';
        const snippet = msg.replace(prefix, '');
        expect(snippet.length).toBeLessThanOrEqual(300);
      }
    });
  });

  describe('GET behavior with private blob support', () => {
    it('sends Authorization header when querying list and downloading matched private blob', async () => {
      const calls: { url: string; headers: Record<string, string> }[] = [];

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        if (url.includes('prefix=')) {
          return new Response(
            JSON.stringify({
              blobs: [
                {
                  pathname: 'references/test_ref.json',
                  url: 'https://blob.vercel-storage.com/public-url',
                  downloadUrl: 'https://blob.vercel-storage.com/private-signed-download-url',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('private-signed-download-url')) {
          return new Response(JSON.stringify(sampleBlob), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await store.get('test_ref');

      expect(result).toEqual(sampleBlob);
      expect(calls.length).toBe(2);
      // Call 1: prefix search with Authorization
      expect(calls[0].headers['Authorization']).toBe(`Bearer ${mockToken}`);
      // Call 2: download via downloadUrl with Authorization
      expect(calls[1].url).toBe('https://blob.vercel-storage.com/private-signed-download-url');
      expect(calls[1].headers['Authorization']).toBe(`Bearer ${mockToken}`);
    });

    it('returns null if blob is not found or status is 404', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 }));
      vi.stubGlobal('fetch', mockFetch);

      const result = await store.get('nonexistent');
      expect(result).toBeNull();
    });

    it('throws error with response body snippet when GET listing or download fails with 500', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('Internal Blob Service Error', { status: 500 }),
      );
      vi.stubGlobal('fetch', mockFetch);

      await expect(store.get('test_ref')).rejects.toThrow(
        'Vercel Blob GET "test_ref" list failed: HTTP 500: Internal Blob Service Error',
      );
    });
  });

  describe('DELETE behavior', () => {
    it('lists and deletes blobs with Authorization header and handles errors with snippet', async () => {
      const calls: { url: string; method?: string; headers: Record<string, string> }[] = [];

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          method: init?.method,
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        if (url.includes('prefix=')) {
          return new Response(
            JSON.stringify({
              blobs: [{ url: 'https://blob.vercel-storage.com/ref1.json' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/delete')) {
          return new Response('Delete forbidden for store', { status: 403 });
        }
        return new Response('OK', { status: 200 });
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(store.del('test_ref')).rejects.toThrow(
        'Vercel Blob DELETE "test_ref" failed: HTTP 403: Delete forbidden for store',
      );
      expect(calls[0].headers['Authorization']).toBe(`Bearer ${mockToken}`);
      expect(calls[1].headers['Authorization']).toBe(`Bearer ${mockToken}`);
    });
  });

  describe('LIST behavior', () => {
    it('lists blobs and downloads using downloadUrl || url with Authorization header', async () => {
      const calls: { url: string; headers: Record<string, string> }[] = [];

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        if (url.includes('prefix=references/')) {
          return new Response(
            JSON.stringify({
              blobs: [
                {
                  url: 'https://blob.vercel-storage.com/ref1.json',
                  downloadUrl: 'https://blob.vercel-storage.com/ref1-download.json',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify(sampleBlob), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      const metas = await store.list();
      expect(metas.length).toBe(1);
      expect(metas[0].referenceId).toBe('test_ref');
      expect(calls.length).toBe(2);
      expect(calls[0].headers['Authorization']).toBe(`Bearer ${mockToken}`);
      expect(calls[1].url).toBe('https://blob.vercel-storage.com/ref1-download.json');
      expect(calls[1].headers['Authorization']).toBe(`Bearer ${mockToken}`);
    });
  });

  describe('extractErrorSnippet helper', () => {
    it('handles empty response gracefully', async () => {
      const res = new Response('', { status: 500 });
      const snippet = await extractErrorSnippet(res);
      expect(snippet).toBe('');
    });

    it('redacts raw token and Bearer tokens', async () => {
      const secret = 'my_top_secret_token_abc';
      const body = `Error with token ${secret} and Bearer xyz987_token failed.`;
      const res = new Response(body, { status: 401 });
      const snippet = await extractErrorSnippet(res, secret);
      expect(snippet).not.toContain(secret);
      expect(snippet).toContain('[REDACTED_TOKEN]');
    });
  });
});
