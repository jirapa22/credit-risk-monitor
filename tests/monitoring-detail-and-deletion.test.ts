import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getStore, setStore, UpstashMockStore } from '../lib/storage/store';
import {
  saveRun,
  listRuns,
  getMonitoringRunDetail,
  deleteMonitoringRuns,
  listDeletionAuditLogs,
  recordDeletionAudit,
} from '../lib/storage/repositories';
import { getBlobStore, saveRunDetailBlob, loadRunDetailBlob } from '../lib/storage/blob';
import type { MonitoringRun, MonitoringRunDetail } from '../lib/types';

describe('Monitoring Run Detail & Deletion Lifecycle Tests', () => {
  let mockStore: UpstashMockStore;

  beforeEach(() => {
    mockStore = new UpstashMockStore();
    setStore(mockStore);
  });

  afterEach(() => {
    setStore(undefined);
  });

  const makeMockRun = (id: string, modelId: string, overrides: Partial<MonitoringRun> = {}): MonitoringRun => ({
    runId: id,
    kind: 'monitoring',
    createdAt: new Date().toISOString(),
    model: {
      modelId,
      configVersion: '1.0.0',
    },
    modelName: 'Test Model',
    referenceId: 'ref_test_1',
    fileName: `${id}.csv`,
    thresholdsSnapshot: {
      psi_warning: 0.1,
      psi_critical: 0.25,
      csi_features: {},
    } as any,
    validation: {
      ok: true,
      totalRows: 1000,
      validRows: 990,
      rejectedRows: 10,
      rejectedPct: 1.0,
      warningRows: 5,
      warningRowPct: 0.5,
      blockingErrors: [],
      warnings: [],
      groups: [],
      issues: [],
    },
    drift: {
      referenceId: 'ref_test_1',
      psi: {
        value: 0.05,
        status: 'STABLE',
        threshold: { warning: 0.1, critical: 0.25 },
        bins: [],
      },
      csi: {},
      overallStatus: 'STABLE',
      triggered: [],
    },
    ...overrides,
  });

  const makeMockDetail = (run: MonitoringRun): MonitoringRunDetail => ({
    runId: run.runId,
    modelId: run.model.modelId,
    version: '1.0.0',
    configVersion: run.model.configVersion,
    referenceId: run.referenceId,
    fileName: run.fileName,
    sha256: 'mock_sha256_hash_123',
    createdAt: run.createdAt,
    thresholdMode: 'fixed',
    validation: run.validation,
    drift: run.drift,
    csiDetail: {},
    riskGradeDist: [{ grade: 'A', count: 500, pct: 50 }],
    riskGradeStatus: 'STABLE',
    scoredCustomers: Array.from({ length: 20 }, (_, i) => ({ row: i + 1, id: `APP_${i + 1}`, score: 550 })),
    uploadSummary: { periods: [], missingData: [] },
    anomaly: null,
    driftReport: null,
    trigger: {
      action: 'CONTINUE',
      severity: 'info',
      matchedRuleId: 'R0',
      reasons: ['No drift detected'],
      evidence: {} as any,
      recommendedSteps: [],
      requiresHumanReview: false,
    },
    psi: 0.05,
    psiStatus: 'STABLE',
    devPsi: null,
    devStability: null,
    status: 'STABLE',
    processedRows: 990,
    skippedRows: 10,
  });

  it('(1) detail บันทึกแล้วอ่านกลับได้ครบ (inline detail)', async () => {
    const run = makeMockRun('run_inline_1', 'model_alpha');
    const detail = makeMockDetail(run);
    run.detail = detail;
    run.sha256 = detail.sha256;

    await saveRun(run);

    const result = await getMonitoringRunDetail('model_alpha', 'run_inline_1');
    expect(result.run).toBeDefined();
    expect(result.hasDetail).toBe(true);
    expect(result.detail).toBeDefined();
    expect(result.detail?.runId).toBe('run_inline_1');
    expect(result.detail?.sha256).toBe('mock_sha256_hash_123');
    expect(result.detail?.scoredCustomers?.length).toBe(20);
    expect(result.detail?.validation.validRows).toBe(990);
    expect(result.detail?.trigger?.action).toBe('CONTINUE');
  });

  it('(2) detail ขนาดใหญ่ (> 500 KB) ถูกบันทึกลง Blob และอ่านกลับได้ครบถ้วน', async () => {
    const run = makeMockRun('run_blob_1', 'model_alpha');
    const detail = makeMockDetail(run);
    // Simulate large payload > 500 KB
    (detail as any).largeMockData = 'x'.repeat(600 * 1024);

    const blobUrl = await saveRunDetailBlob(run.runId, detail);
    expect(blobUrl).toContain('run_blob_1');
    run.detailBlobUrl = blobUrl;
    run.sha256 = detail.sha256;
    delete run.detail; // pointer only in run

    await saveRun(run);

    const result = await getMonitoringRunDetail('model_alpha', 'run_blob_1');
    expect(result.run).toBeDefined();
    expect(result.hasDetail).toBe(true);
    expect(result.detail).toBeDefined();
    expect(result.detail?.runId).toBe('run_blob_1');
    expect((result.detail as any).largeMockData.length).toBe(600 * 1024);
  });

  it('(3) run เก่าไม่มี detail ไม่พัง: แสดงสรุปเดิมและ hasDetail = false', async () => {
    const run = makeMockRun('run_legacy_1', 'model_alpha');
    delete run.detail;
    delete run.detailBlobUrl;

    await saveRun(run);

    const result = await getMonitoringRunDetail('model_alpha', 'run_legacy_1');
    expect(result.run).toBeDefined();
    expect(result.hasDetail).toBe(false);
    expect(result.detail).toBeNull();
    expect(result.run?.fileName).toBe('run_legacy_1.csv');
    expect(result.run?.validation.totalRows).toBe(1000);
  });

  it('(4) ลบหนึ่ง run แล้วเหลือที่เหลือครบ (3 runs -> delete 1 -> remaining 2)', async () => {
    const r1 = makeMockRun('run_1', 'model_alpha');
    const r2 = makeMockRun('run_2', 'model_alpha');
    const r3 = makeMockRun('run_3', 'model_alpha');

    await saveRun(r1);
    await saveRun(r2);
    await saveRun(r3);

    const initial = await listRuns<MonitoringRun>('monitoring', 'model_alpha');
    expect(initial.length).toBe(3);

    const deleteRes = await deleteMonitoringRuns('model_alpha', ['run_2']);
    expect(deleteRes.deletedCount).toBe(1);
    expect(deleteRes.remainingCount).toBe(2);

    const remaining = await listRuns<MonitoringRun>('monitoring', 'model_alpha');
    expect(remaining.length).toBe(2);
    expect(remaining.map(r => r.runId)).toEqual(['run_3', 'run_1']);
    expect(remaining.some(r => r.runId === 'run_2')).toBe(false);
  });

  it('(5) ลบในโมเดล A ไม่กระทบโมเดล B และไม่กระทบ Sandbox', async () => {
    const rA1 = makeMockRun('run_a1', 'model_A');
    const rA2 = makeMockRun('run_a2', 'model_A');
    const rB1 = makeMockRun('run_b1', 'model_B');
    const rB2 = makeMockRun('run_b2', 'model_B');

    await saveRun(rA1);
    await saveRun(rA2);
    await saveRun(rB1);
    await saveRun(rB2);

    // Save sandbox run
    const sandboxRun = {
      runId: 'sandbox_1',
      kind: 'sandbox',
      model: { modelId: 'model_A', version: '1.0.0', configVersion: '1.0.0' },
      createdAt: new Date().toISOString(),
    } as any;
    await saveRun(sandboxRun);

    // Delete in Model A
    await deleteMonitoringRuns('model_A', ['run_a1']);

    // Check Model A
    const runsA = await listRuns<MonitoringRun>('monitoring', 'model_A');
    expect(runsA.length).toBe(1);
    expect(runsA[0].runId).toBe('run_a2');

    // Check Model B (completely untouched)
    const runsB = await listRuns<MonitoringRun>('monitoring', 'model_B');
    expect(runsB.length).toBe(2);
    expect(runsB.map(r => r.runId)).toEqual(['run_b2', 'run_b1']);

    // Check Sandbox runs (untouched)
    const sandboxes = await listRuns('sandbox', 'model_A');
    expect(sandboxes.length).toBe(1);
    expect(sandboxes[0].runId).toBe('sandbox_1');
  });

  it('(6) ลบแล้วบันทึก audit event RUN_DELETED โดย audit เดิมไม่ถูกลบ และลบ blob detail ด้วย', async () => {
    // Record existing audit log
    await recordDeletionAudit({
      action: 'delete_version',
      actor: 'admin',
      modelId: 'model_alpha',
      clearedCounts: { monitoringRuns: 0, sandboxRuns: 0, events: 0, reviews: 0, total: 0 },
      blobDeleted: false,
      note: 'Existing baseline deletion audit',
    });

    const run = makeMockRun('run_with_blob', 'model_alpha');
    const detail = makeMockDetail(run);
    const blobUrl = await saveRunDetailBlob(run.runId, detail);
    run.detailBlobUrl = blobUrl;
    await saveRun(run);

    // Verify blob exists
    const loadedBlobBefore = await loadRunDetailBlob(run.runId);
    expect(loadedBlobBefore).toBeDefined();

    // Delete run
    await deleteMonitoringRuns('model_alpha', ['run_with_blob']);

    // Verify blob was deleted
    const loadedBlobAfter = await loadRunDetailBlob(run.runId);
    expect(loadedBlobAfter).toBeNull();

    // Check audit logs
    const audits = await listDeletionAuditLogs();
    expect(audits.length).toBe(2);

    const runDeleteAudit = audits.find(a => a.action === 'RUN_DELETED');
    expect(runDeleteAudit).toBeDefined();
    expect(runDeleteAudit?.runId).toBe('run_with_blob');
    expect(runDeleteAudit?.fileName).toBe('run_with_blob.csv');
    expect(runDeleteAudit?.modelId).toBe('model_alpha');

    // Verify existing audit log is still intact
    const existingAudit = audits.find(a => a.action === 'delete_version');
    expect(existingAudit).toBeDefined();
    expect(existingAudit?.note).toBe('Existing baseline deletion audit');
  });

  it('(7) ใช้ได้กับ mock Upstash และไม่เกิด WRONGTYPE เมื่อบันทึกและลบ', async () => {
    const r1 = makeMockRun('run_kv_1', 'model_kv');
    const r2 = makeMockRun('run_kv_2', 'model_kv');

    // In UpstashMockStore, list operations will throw if key type is wrong
    await saveRun(r1);
    await saveRun(r2);

    const runs = await listRuns<MonitoringRun>('monitoring', 'model_kv');
    expect(runs.length).toBe(2);

    await deleteMonitoringRuns('model_kv', ['run_kv_1']);
    const after = await listRuns<MonitoringRun>('monitoring', 'model_kv');
    expect(after.length).toBe(1);
    expect(after[0].runId).toBe('run_kv_2');
  });

  it('(8) ป้องกันการลบโดยไม่ระบุ modelId (throws error)', async () => {
    await expect(deleteMonitoringRuns('', ['run_1'])).rejects.toThrow('ต้องระบุ modelId');
  });
});
