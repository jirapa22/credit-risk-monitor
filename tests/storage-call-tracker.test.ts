import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryStore,
  getStore,
  setStore,
  storageCallTracker,
  type StorageCallCounts,
} from '../lib/storage/store';
import {
  createMemoryBlobStore,
  getBlobStore,
  setBlobStore,
  type ReferenceDatasetBlob,
} from '../lib/storage/blob';

describe('Storage Call Tracker & Wrapper Verification (Item 5)', () => {
  beforeEach(() => {
    setStore(createMemoryStore());
    setBlobStore(createMemoryBlobStore());
  });

  afterEach(() => {
    setStore(undefined);
    setBlobStore(undefined);
  });

  it('accurately counts store read and write operations via wrapStoreWithTracker', async () => {
    const initialCounts: StorageCallCounts = {
      storeReads: 0,
      storeWrites: 0,
      blobReads: 0,
      blobWrites: 0,
    };

    await storageCallTracker.run(initialCounts, async () => {
      const store = getStore();

      // Write operations
      await store.set('test:key1', { value: 123 });
      await store.listPush('test:list', { item: 1 }, 10);
      if (store.listReplace) {
        await store.listReplace('test:list', [{ item: 2 }], 10);
      }
      if (store.putSync) {
        store.putSync('test:sync', { sync: true });
      }
      await store.del('test:key1');

      // Read operations
      await store.get('test:key1');
      await store.listRange('test:list', 10);
      if (store.peek) {
        store.peek('test:sync');
      }

      const counts = storageCallTracker.getStore();
      expect(counts).toBeDefined();
      expect(counts!.storeWrites).toBeGreaterThanOrEqual(4);
      expect(counts!.storeReads).toBeGreaterThanOrEqual(2);
      expect(counts!.blobReads).toBe(0);
      expect(counts!.blobWrites).toBe(0);
    });
  });

  it('accurately counts blob read and write operations via wrapBlobStoreWithTracker', async () => {
    const initialCounts: StorageCallCounts = {
      storeReads: 0,
      storeWrites: 0,
      blobReads: 0,
      blobWrites: 0,
    };

    await storageCallTracker.run(initialCounts, async () => {
      const blobStore = getBlobStore();
      const mockBlob: ReferenceDatasetBlob = {
        meta: {
          referenceId: 'test_ref_1',
          version: '1.0.0',
          modelId: 'test_model',
          description: 'Test ref',
          source: 'test.csv',
          createdAt: new Date().toISOString(),
          rowCount: 10,
          badCount: 0,
          badRate: 0,
          periodStart: '2023-01-01',
          periodEnd: '2023-12-31',
          columns: ['colA', 'colB'],
          sha256: 'abc123sha',
        },
        rows: [{ colA: 1, colB: 2 }],
      };

      // Write operations
      await blobStore.put('test_ref_1', mockBlob);
      // Read operations
      await blobStore.get('test_ref_1');
      // Delete operation
      await blobStore.del('test_ref_1');

      const counts = storageCallTracker.getStore();
      expect(counts).toBeDefined();
      expect(counts!.blobWrites).toBe(2); // put + del
      expect(counts!.blobReads).toBe(1);  // get
      expect(counts!.storeReads).toBe(0);
      expect(counts!.storeWrites).toBe(0);
    });
  });

  it('confirms getBlobStore() returns a new Proxy on each call and explains monkeypatching impact', () => {
    const blob1 = getBlobStore();
    const blob2 = getBlobStore();

    // Each getBlobStore() wraps the underlying store in a new Proxy wrapper
    expect(blob1).not.toBe(blob2);

    // Monkeypatching directly on the returned wrapper instance:
    const mockGet = vi.fn().mockResolvedValue(null);
    (blob1 as any).get = mockGet;

    // blob2 is a separate Proxy wrapper around the underlying activeBlobStore,
    // so mutating blob1 does not affect blob2's get method!
    expect((blob2 as any).get).not.toBe(mockGet);

    // The canonical, sanctioned way to mock in tests is setBlobStore(mockStore):
    const customMockStore = createMemoryBlobStore();
    const customSpy = vi.spyOn(customMockStore, 'get');
    setBlobStore(customMockStore);

    // All subsequent getBlobStore() calls delegate to the customMockStore
    const blob3 = getBlobStore();
    const blob4 = getBlobStore();
    blob3.get('non_existent');
    expect(customSpy).toHaveBeenCalledTimes(1);
    blob4.get('non_existent_2');
    expect(customSpy).toHaveBeenCalledTimes(2);
  });
});

