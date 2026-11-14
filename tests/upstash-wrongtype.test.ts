import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getStore, setStore, createUpstashMockStore, UpstashMockStore } from '../lib/storage/store';
import {
  createDraftBaselineVersion,
  deleteBaselineVersion,
  deleteRegistryModel,
  getBaselineVersionImpact,
  listDeletionAuditLogs,
  listRuns,
  recordDeletionAudit,
  saveRun,
} from '../lib/storage/repositories';
import type { MonitoringRun } from '../lib/types';

describe('Upstash WRONGTYPE & Resilient Deletion Tests', () => {
  let mockStore: UpstashMockStore;

  beforeEach(() => {
    mockStore = new UpstashMockStore();
    setStore(mockStore);
  });

  afterEach(() => {
    setStore(undefined);
  });

  it('(1) KV Mock correctly throws WRONGTYPE when string key is read with listRange, and vice versa', async () => {
    // String key -> LRANGE throws WRONGTYPE
    await mockStore.set('my_str', { a: 1 });
    await expect(mockStore.listRange('my_str', 10)).rejects.toThrow(
      'Upstash LRANGE failed: WRONGTYPE Operation against a key holding the wrong kind of value',
    );

    // List key -> GET throws WRONGTYPE
    await mockStore.listPush('my_list', { item: 1 }, 10);
    await expect(mockStore.get('my_list')).rejects.toThrow(
      'Upstash GET failed: WRONGTYPE Operation against a key holding the wrong kind of value',
    );
  });

  it('(2) deleteRegistryModel and getBaselineVersionImpact work when runs are stored as Redis LIST', async () => {
    const modelId = 'model_z98pi';
    const version = '1.0.0';

    // 1. Create a draft model/version
    await createDraftBaselineVersion(modelId, {
      modelId,
      version,
      name: 'Cash Loan Model',
      description: 'Test model',
      mode: 'scorecard',
      status: 'DRAFT',
      scoreDirection: 'higher_is_safer',
      referenceDatasetId: 'ref_cashloan_1',
      columns: { idColumn: 'app_id', dateColumn: 'app_date', scoreColumn: 'score' },
      featureRegistry: {},
      thresholds: { psi_warning: 0.1, psi_critical: 0.25, csi_features: {} } as any,
      driftConfig: { thresholdMode: 'fixed' } as any,
    });

    // 2. Save monitoring run (uses listPush -> Redis LIST)
    const fakeRun: any = {
      runId: 'run_test_1',
      kind: 'monitoring',
      createdAt: new Date().toISOString(),
      model: { modelId, version, configVersion: version },
      referenceId: 'ref_cashloan_1',
      fileName: 'm01.csv',
      validation: { ok: true, totalRows: 100, validRows: 100, rejectedRows: 0, rejectedPct: 0, issues: [] },
      drift: { psi: { value: 0.05, status: 'STABLE' }, overallStatus: 'STABLE' },
      trigger: { action: 'CONTINUE' },
    };
    await saveRun(fakeRun);

    // 3. getBaselineVersionImpact must read via listRange without WRONGTYPE
    const impact = await getBaselineVersionImpact(modelId, version);
    expect(impact.monitoringRunsCount).toBe(1);

    // 4. deleteRegistryModel must succeed without WRONGTYPE
    const delResult = await deleteRegistryModel(modelId, { actor: 'tester' });
    expect(delResult.deleted).toBe(true);
    expect(delResult.clearedRunsCount).toBe(1);

    // Verify deletion audit was recorded
    const audits = await listDeletionAuditLogs();
    const modelAudit = audits.find(a => a.modelId === modelId && a.action === 'delete_model');
    expect(modelAudit).toBeDefined();
    expect(modelAudit?.clearedCounts.monitoringRuns).toBe(1);
  });

  it('(3) deleteBaselineVersion works and preserves Redis LIST type when partially filtering runs', async () => {
    const modelId = 'model_multi_ver';
    const v1 = '1.0.0';
    const v2 = '2.0.0';

    await createDraftBaselineVersion(modelId, {
      modelId,
      version: v1,
      name: 'Model Multi',
      description: 'V1',
      mode: 'scorecard',
      status: 'ARCHIVED',
      scoreDirection: 'higher_is_safer',
      referenceDatasetId: 'ref_1',
      columns: { idColumn: 'id', dateColumn: 'd', scoreColumn: 's' },
      featureRegistry: {},
      thresholds: { psi_warning: 0.1, psi_critical: 0.25, csi_features: {} } as any,
      driftConfig: { thresholdMode: 'fixed' } as any,
    });

    await createDraftBaselineVersion(modelId, {
      modelId,
      version: v2,
      name: 'Model Multi',
      description: 'V2',
      mode: 'scorecard',
      status: 'DRAFT',
      scoreDirection: 'higher_is_safer',
      referenceDatasetId: 'ref_2',
      columns: { idColumn: 'id', dateColumn: 'd', scoreColumn: 's' },
      featureRegistry: {},
      thresholds: { psi_warning: 0.1, psi_critical: 0.25, csi_features: {} } as any,
      driftConfig: { thresholdMode: 'fixed' } as any,
    });

    // Save run for v1 and v2
    await saveRun({
      runId: 'r1',
      kind: 'monitoring',
      createdAt: new Date().toISOString(),
      model: { modelId, version: v1, configVersion: v1 },
      referenceId: 'ref_1',
      fileName: 'm01.csv',
      validation: { ok: true, totalRows: 50, validRows: 50, rejectedRows: 0, rejectedPct: 0, issues: [] },
      drift: { psi: { value: 0.01, status: 'STABLE' }, overallStatus: 'STABLE' },
      trigger: { action: 'CONTINUE' },
    } as any);

    await saveRun({
      runId: 'r2',
      kind: 'monitoring',
      createdAt: new Date().toISOString(),
      model: { modelId, version: v2, configVersion: v2 },
      referenceId: 'ref_2',
      fileName: 'm02.csv',
      validation: { ok: true, totalRows: 50, validRows: 50, rejectedRows: 0, rejectedPct: 0, issues: [] },
      drift: { psi: { value: 0.02, status: 'STABLE' }, overallStatus: 'STABLE' },
      trigger: { action: 'CONTINUE' },
    } as any);

    // Delete v1
    const delVerResult = await deleteBaselineVersion(modelId, v1, { actor: 'tester' });
    expect(delVerResult.deleted).toBe(true);
    expect(delVerResult.clearedRunsCount).toBe(1);

    // Verify remaining runs still queryable as Redis LIST without WRONGTYPE
    const remaining = await listRuns('monitoring', modelId);
    expect(remaining.length).toBe(1);
    expect(remaining[0].runId).toBe('r2');
  });

  it('(4) Resilient reading: auto-migrates registry:deletion_audit if previously saved as LIST on Upstash', async () => {
    // Simulate legacy Upstash where registry:deletion_audit was written using LPUSH
    const legacyAudit = {
      id: 'legacy_audit_1',
      timestamp: new Date().toISOString(),
      action: 'delete_model',
      actor: 'legacy-system',
      modelId: 'legacy_model',
      clearedCounts: { monitoringRuns: 5, sandboxRuns: 0, events: 0, reviews: 0, total: 5 },
      blobDeleted: false,
    };
    await mockStore.listPush('registry:deletion_audit', legacyAudit, 100);

    // listDeletionAuditLogs should catch WRONGTYPE, read from list, and migrate to String
    const logs = await listDeletionAuditLogs();
    expect(logs.length).toBe(1);
    expect(logs[0].id).toBe('legacy_audit_1');

    // Next recordDeletionAudit should work cleanly on the migrated String key
    await recordDeletionAudit({
      action: 'delete_version',
      actor: 'new-user',
      modelId: 'new_model',
      version: '1.0.0',
      clearedCounts: { monitoringRuns: 1, sandboxRuns: 0, events: 0, reviews: 0, total: 1 },
      blobDeleted: false,
    });

    const updatedLogs = await listDeletionAuditLogs();
    expect(updatedLogs.length).toBe(2);
    expect(updatedLogs[0].action).toBe('delete_version');
    expect(updatedLogs[1].id).toBe('legacy_audit_1');
  });

  it('(5) Resilient reading: auto-migrates runs:* if previously saved as String on Upstash', async () => {
    const modelId = 'legacy_run_model';
    // Simulate legacy Upstash where runs:monitoring:legacy_run_model was saved as String JSON
    const legacyRuns: any[] = [
      {
        runId: 'legacy_run_1',
        kind: 'monitoring',
        createdAt: new Date().toISOString(),
        model: { modelId, version: '1.0.0', configVersion: '1.0.0' },
        referenceId: 'ref_1',
        fileName: 'legacy.csv',
        validation: { ok: true, totalRows: 100, validRows: 100, rejectedRows: 0, rejectedPct: 0, issues: [] },
        drift: { psi: { value: 0.03, status: 'STABLE' }, overallStatus: 'STABLE' },
      },
    ];
    await mockStore.set(`runs:monitoring:${modelId}`, legacyRuns);

    // listRuns should catch WRONGTYPE, recover runs, and migrate key to Redis LIST
    const runs = await listRuns('monitoring', modelId);
    expect(runs.length).toBe(1);
    expect(runs[0].runId).toBe('legacy_run_1');

    // Now saveRun should work cleanly with listPush (which requires a LIST)
    await saveRun({
      runId: 'legacy_run_2',
      kind: 'monitoring',
      createdAt: new Date().toISOString(),
      model: { modelId, version: '1.0.0', configVersion: '1.0.0' },
      referenceId: 'ref_1',
      fileName: 'legacy2.csv',
      validation: { ok: true, totalRows: 100, validRows: 100, rejectedRows: 0, rejectedPct: 0, issues: [] },
      drift: { psi: { value: 0.04, status: 'STABLE' }, overallStatus: 'STABLE' },
      trigger: { action: 'CONTINUE' },
    } as any);

    const allRuns = await listRuns('monitoring', modelId);
    expect(allRuns.length).toBe(2);
    expect(allRuns[0].runId).toBe('legacy_run_2');
    expect(allRuns[1].runId).toBe('legacy_run_1');
  });
});
