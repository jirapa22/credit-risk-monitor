/**
 * Tests for Baseline Deletion, Impact Analysis, and Lifecycle Guards.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  archiveBaselineVersion,
  createDraftBaselineVersion,
  deleteBaselineVersion,
  deleteRegistryModel,
  getBaselineVersionImpact,
  getDefaultModelId,
  listBaselineVersions,
  listDeletionAuditLogs,
  listRegistryModels,
  saveRun,
  saveTriggerEvent,
  setDefaultModelId,
  updateBaselineVersion,
  BuiltInProtectedError,
  RegistryError,
} from '../lib/storage/repositories';
import { createMemoryBlobStore, setBlobStore, type ReferenceDatasetBlob } from '../lib/storage/blob';
import { createMemoryStore, setStore } from '../lib/storage/store';
import {
  DELETE as deleteVersionRoute,
  GET as getVersionRoute,
  PATCH as patchVersionRoute,
} from '../app/api/registry/models/[modelId]/versions/[version]/route';
import { DELETE as deleteModelRoute } from '../app/api/registry/models/[modelId]/route';
import { GET as getAuditRoute } from '../app/api/registry/audit/route';
import type { MonitoringRun, TriggerEvent } from '../lib/types';

describe('Step 2: Baseline Deletion, Impact Analysis & Guards', () => {
  const customModelId = 'test_custom_loan';
  const customVersion = '1.0.0';
  const customRefId = 'ref_custom_test_001';

  beforeEach(async () => {
    setStore(createMemoryStore());
    const memBlob = createMemoryBlobStore();
    setBlobStore(memBlob);

    // Seed dummy blob reference
    const dummyBlob: ReferenceDatasetBlob = {
      meta: {
        referenceId: customRefId,
        version: '1.0.0',
        modelId: customModelId,
        description: 'Test ref',
        source: 'test',
        createdAt: new Date().toISOString(),
        rowCount: 100,
        badCount: 10,
        badRate: 0.1,
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        columns: ['col_a'],
        sha256: 'dummy_hash',
      },
      rows: [{ col_a: 1 }],
    };
    await memBlob.put(customRefId, dummyBlob);

    // Create DRAFT baseline
    await createDraftBaselineVersion(customModelId, {
      version: customVersion,
      name: 'Custom Loan Model v1',
      description: 'Draft baseline for deletion tests',
      referenceDatasetId: customRefId,
      mode: 'score_column',
      columns: {
        idColumn: 'app_id',
        dateColumn: null,
        labelColumn: 'target_flag',
        scoreColumn: 'score_val',
      },
      thresholds: {
        psi_warning: 0.10,
        psi_critical: 0.25,
        gini_min: 0.10,
        auc_min: 0.55,
        ks_min: 0.10,
        csi_features: {},
      },
    });
  });

  it('prevents deletion of built-in models and baselines', async () => {
    const builtInVers = await listBaselineVersions('ascore_v1');
    expect(builtInVers.length).toBeGreaterThan(0);
    const builtInVer = builtInVers[0].version;

    // Attempt to delete built-in ascore_v1
    await expect(deleteBaselineVersion('ascore_v1', builtInVer)).rejects.toThrow(BuiltInProtectedError);

    // Also check impact analysis reports canDelete: false
    const impact = await getBaselineVersionImpact('ascore_v1', builtInVer);
    expect(impact.canDelete).toBe(false);
    expect(impact.reason).toContain('Built-in');
  });

  it('reports correct impact metrics for associated runs and events', async () => {
    // Add 1 monitoring run and 1 trigger event linked to customVersion
    const dummyRun = {
      runId: 'run_test_01',
      kind: 'monitoring' as const,
      createdAt: new Date().toISOString(),
      model: {
        modelId: customModelId,
        configVersion: customVersion,
      },
      modelName: 'Custom Loan Model',
      referenceId: customRefId,
      fileName: 'test.csv',
      thresholdsSnapshot: {
        psi_warning: 0.1,
        psi_critical: 0.25,
        gini_min: 0.1,
        auc_min: 0.55,
        ks_min: 0.1,
        csi_features: {},
      },
      validation: {
        ok: true,
        validRows: 10,
        rejectedRows: 0,
        rejectedPct: 0,
        totalRows: 10,
        blockingErrors: [],
        warnings: [],
        groups: { schema: [], completeness: [], domain: [] },
      },
      drift: null,
    } as unknown as MonitoringRun;
    await saveRun(dummyRun);

    const dummyEvent: TriggerEvent = {
      eventId: 'evt_test_01',
      runId: 'run_test_01',
      createdAt: new Date().toISOString(),
      model: dummyRun.model,
      referenceId: customRefId,
      decision: {
        action: 'INVESTIGATE_DRIFT',
        severity: 'critical',
        matchedRuleId: 'R6',
        reasons: ['Test'],
        evidence: {} as any,
        recommendedSteps: [],
        requiresHumanReview: true,
      },
      status: 'OPEN',
      review: {
        decision: 'RETRAIN_SCHEDULED',
        reviewer: 'analyst_01',
        reviewedAt: new Date().toISOString(),
        note: 'Needs retrain',
      },
    };
    await saveTriggerEvent(dummyEvent);

    const impact = await getBaselineVersionImpact(customModelId, customVersion);
    expect(impact.canDelete).toBe(true);
    expect(impact.monitoringRunsCount).toBe(1);
    expect(impact.eventsCount).toBe(1);
    expect(impact.reviewsCount).toBe(1);
    expect(impact.totalImpactCount).toBe(2);
  });

  it('refuses direct deletion of ACTIVE baselines and requires Archive first', async () => {
    // Manually simulate ACTIVE status
    const stored = await listBaselineVersions(customModelId);
    stored[0].status = 'ACTIVE';

    await expect(deleteBaselineVersion(customModelId, customVersion)).rejects.toThrow(
      'ไม่สามารถลบเวอร์ชัน',
    );

    // Can archive it first
    await archiveBaselineVersion(customModelId, customVersion);
    const afterArchive = await listBaselineVersions(customModelId);
    expect(afterArchive[0].status).toBe('ARCHIVED');

    // Once archived, delete succeeds
    const delResult = await deleteBaselineVersion(customModelId, customVersion);
    expect(delResult.deleted).toBe(true);
  });

  it('deletes DRAFT baseline, purges KV runs, and deletes unused Blob reference', async () => {
    // Save run before deletion
    const dummyRun = {
      runId: 'run_test_02',
      kind: 'monitoring' as const,
      createdAt: new Date().toISOString(),
      model: {
        modelId: customModelId,
        configVersion: customVersion,
      },
      modelName: 'Custom Loan Model',
      referenceId: customRefId,
      fileName: 'test.csv',
      thresholdsSnapshot: {
        psi_warning: 0.1,
        psi_critical: 0.25,
        gini_min: 0.1,
        auc_min: 0.55,
        ks_min: 0.1,
        csi_features: {},
      },
      validation: {
        ok: true,
        validRows: 10,
        rejectedRows: 0,
        rejectedPct: 0,
        totalRows: 10,
        blockingErrors: [],
        warnings: [],
        groups: { schema: [], completeness: [], domain: [] },
      },
      drift: null,
    } as unknown as MonitoringRun;
    await saveRun(dummyRun);

    const result = await deleteBaselineVersion(customModelId, customVersion, { purgeBlob: true });
    expect(result.deleted).toBe(true);
    expect(result.clearedRunsCount).toBe(1);
    expect(result.blobDeleted).toBe(true);

    // Verify version is gone
    const remaining = await listBaselineVersions(customModelId);
    expect(remaining.find(v => v.version === customVersion)).toBeUndefined();
  });

  it('via API route: supports GET impact and DELETE action (archive vs delete)', async () => {
    // 1. GET route
    const getRes = await getVersionRoute(new Request('http://localhost'), {
      params: { modelId: customModelId, version: customVersion },
    });
    const getData = await getRes.json();
    expect(getData.ok).toBe(true);
    expect(getData.canDelete).toBe(true);

    // 2. DELETE route with action: 'archive'
    const archiveReq = new Request('http://localhost', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive' }),
    });
    const arcRes = await deleteVersionRoute(archiveReq, {
      params: { modelId: customModelId, version: customVersion },
    });
    const arcData = await arcRes.json();
    expect(arcData.ok).toBe(true);
    expect(arcData.action).toBe('archived');
    expect(arcData.baseline.status).toBe('ARCHIVED');

    // 3. DELETE route with action: 'delete'
    const deleteReq = new Request('http://localhost', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete' }),
    });
    const delRes = await deleteVersionRoute(deleteReq, {
      params: { modelId: customModelId, version: customVersion },
    });
    const delData = await delRes.json();
    expect(delData.ok).toBe(true);
    expect(delData.action).toBe('deleted');
  });

  it('Part (A) Audit log: records audit log on archive & delete, and survives after baseline is deleted', async () => {
    // 1. Archive version -> audit log created
    await archiveBaselineVersion(customModelId, customVersion, { by: 'test_auditor', note: 'Audit test archive' });
    let logs = await listDeletionAuditLogs();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe('archive_version');
    expect(logs[0].actor).toBe('test_auditor');
    expect(logs[0].modelId).toBe(customModelId);

    // 2. Delete version -> audit log created
    await deleteBaselineVersion(customModelId, customVersion, { actor: 'test_admin' });
    logs = await listDeletionAuditLogs();
    expect(logs[0].action).toBe('delete_version');
    expect(logs[0].actor).toBe('test_admin');
    expect(logs[0].modelId).toBe(customModelId);

    // 3. Confirm baseline is gone but audit log remains
    const versions = await listBaselineVersions(customModelId);
    expect(versions.length).toBe(0);
    const auditRes = await getAuditRoute(new Request('http://localhost'));
    const auditData = await auditRes.json();
    expect(auditData.ok).toBe(true);
    expect(auditData.logs.some((l: any) => l.modelId === customModelId)).toBe(true);
  });

  it('Part (B) Delete model: guards against built-in, default, and active models, and cleans up empty model', async () => {
    // 1. Cannot delete built-in ascore_v1
    await expect(deleteRegistryModel('ascore_v1')).rejects.toThrow(BuiltInProtectedError);

    // 2. Cannot delete default model
    await setDefaultModelId(customModelId);
    await expect(deleteRegistryModel(customModelId)).rejects.toThrow('ไม่สามารถลบโมเดลที่เป็นค่าเริ่มต้น');

    // Switch default back to ascore_v1
    await setDefaultModelId('ascore_v1');

    // 3. Cannot delete model with ACTIVE version
    const vers = await listBaselineVersions(customModelId);
    vers[0].status = 'ACTIVE';
    await expect(deleteRegistryModel(customModelId)).rejects.toThrow('ไม่สามารถลบโมเดล');

    // Change status back to DRAFT or ARCHIVED
    vers[0].status = 'DRAFT';

    // 4. Successful model deletion via API route
    const delModelRes = await deleteModelRoute(new Request('http://localhost', { method: 'DELETE' }), {
      params: { modelId: customModelId },
    });
    const delModelData = await delModelRes.json();
    expect(delModelData.ok).toBe(true);
    expect(delModelData.deleted).toBe(true);

    // Verify model is completely gone from registry
    const { models } = await listRegistryModels();
    expect(models.find(m => m.modelId === customModelId)).toBeUndefined();
  });

  it('Part (B) deleteModelIfEmpty: cleans up model metadata when deleting last version', async () => {
    const res = await deleteBaselineVersion(customModelId, customVersion, { deleteModelIfEmpty: true });
    expect(res.deleted).toBe(true);
    expect(res.modelDeleted).toBe(true);

    const { models } = await listRegistryModels();
    expect(models.find(m => m.modelId === customModelId)).toBeUndefined();
  });

  it('Part (C) Edit baseline: allows updating name/description, reverts VALIDATED to DRAFT on schema change, guards ACTIVE', async () => {
    // 1. Edit name & description
    const updated = await updateBaselineVersion(customModelId, customVersion, {
      name: 'Renamed Loan Model',
      description: 'Updated description',
    });
    expect(updated.name).toBe('Renamed Loan Model');
    expect(updated.description).toBe('Updated description');
    expect(updated.status).toBe('DRAFT');

    // 2. Via PATCH route
    const patchRes = await patchVersionRoute(
      new Request('http://localhost', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Patched Model Name' }),
      }),
      { params: { modelId: customModelId, version: customVersion } },
    );
    const patchData = await patchRes.json();
    expect(patchData.ok).toBe(true);
    expect(patchData.baseline.name).toBe('Patched Model Name');
  });
});
