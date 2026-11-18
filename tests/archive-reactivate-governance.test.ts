import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setStore, UpstashMockStore } from '../lib/storage/store';
import { createMemoryBlobStore, getBlobStore, setBlobStore } from '../lib/storage/blob';
import { listBaselineVersions, listDeletionAuditLogs } from '../lib/storage/repositories';
import { computeBaselineConfigHash } from '../lib/baselineValidation';

// Route handlers
import { POST as referencesHandler } from '../app/api/registry/references/route';
import { POST as scorecardImportHandler } from '../app/api/registry/scorecard/import/route';
import { POST as createVersionHandler } from '../app/api/registry/models/[modelId]/versions/route';
import { POST as validateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/validate/route';
import { POST as activateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/activate/route';
import { POST as archiveVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/archive/route';
import { POST as reactivateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/reactivate/route';
import { POST as monitorUploadHandler } from '../app/api/monitor-upload/route';

describe('Archive, Re-activate Governance and Monitoring Integration Tests', () => {
  const root = process.cwd();
  let mockStore: UpstashMockStore;

  beforeEach(() => {
    mockStore = new UpstashMockStore();
    setStore(mockStore);
    setBlobStore(createMemoryBlobStore());
  });

  afterEach(() => {
    setStore(undefined);
    setBlobStore(undefined);
  });

  async function createAndActivateModel(modelId: string, version = '1.0.0') {
    const baseText = readFileSync(join(root, 'samples/cashloan_v2/baseline_cashloan_v2_2024.csv'), 'utf8');
    const mtText = readFileSync(join(root, 'samples/cashloan_v2/model_table_cashloan.csv'), 'utf8');
    const referenceId = `ref_${modelId}`;

    await referencesHandler(new Request('http://localhost/api/registry/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId, csvText: baseText, modelId, version, labelColumn: 'default_12m' }),
    }));

    const scRes = await scorecardImportHandler(new Request('http://localhost/api/registry/scorecard/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csvText: mtText, referenceId, scoreColumn: 'credit_score' }),
    }));
    const scData = await scRes.json();

    await createVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version,
        name: `Model ${modelId}`,
        referenceId,
        mode: 'scorecard',
        scoreDirection: 'higher_better',
        featureRegistry: {},
        columns: { idColumn: 'app_id', dateColumn: 'app_date', labelColumn: 'default_12m', scoreColumn: 'credit_score' },
        modelTable: scData.table,
        scoring: scData.scoring,
      }),
    }), { params: Promise.resolve({ modelId }) });

    await validateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/${version}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'test-user' }),
    }), { params: Promise.resolve({ modelId, version }) });

    await activateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/${version}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'test-user' }),
    }), { params: Promise.resolve({ modelId, version }) });
  }

  it('archive single ACTIVE version via route returns leavesNoActive: true', async () => {
    const modelId = 'test_archive_model';
    await createAndActivateModel(modelId, '1.0.0');

    const res = await archiveVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'web-user', note: 'Archived via confirmation modal' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.baseline.status).toBe('ARCHIVED');
    expect(data.leavesNoActive).toBe(true);

    const history = data.baseline.statusHistory;
    expect(history.length).toBeGreaterThan(0);
    const lastHistory = history[history.length - 1];
    expect(lastHistory.to).toBe('ARCHIVED');
    expect(lastHistory.by).toBe('web-user');
    expect(lastHistory.note).toBe('Archived via confirmation modal');

    const versions = await listBaselineVersions(modelId);
    expect(versions.some(v => v.status === 'ACTIVE')).toBe(false);
  });

  it('re-activate from ARCHIVED must fail direct activate without validate, and succeed via reactivate route', async () => {
    const modelId = 'test_reactivate_model';
    await createAndActivateModel(modelId, '1.0.0');

    // Archive it first
    await archiveVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'web-user' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });

    // 1. Direct activate on ARCHIVED should fail (status must be VALIDATED first)
    const directActRes = await activateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'web-user' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });
    expect(directActRes.status).toBe(400);
    const directActData = await directActRes.json();
    expect(directActData.error).toContain('ต้องเป็น "VALIDATED" เท่านั้น');

    // 2. Call reactivate route (which runs validate first, then activates)
    const reactRes = await reactivateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/reactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'registry-panel', note: 'Re-activated via registry-panel' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });

    expect(reactRes.status).toBe(200);
    const reactData = await reactRes.json();
    expect(reactData.ok).toBe(true);
    expect(reactData.baseline.status).toBe('ACTIVE');

    // Check statusHistory progression: ARCHIVED -> VALIDATED -> ACTIVE
    const history = reactData.baseline.statusHistory;
    const valStep = history.find((h: any) => h.from === 'ARCHIVED' && h.to === 'VALIDATED');
    expect(valStep).toBeDefined();
    expect(valStep.by).toBe('registry-panel');

    const actSteps = history.filter((h: any) => h.from === 'VALIDATED' && h.to === 'ACTIVE');
    const latestActStep = actSteps[actSteps.length - 1];
    expect(latestActStep).toBeDefined();
    expect(latestActStep.by).toBe('registry-panel');
    expect(latestActStep.note).toBe('Re-activated via registry-panel');
  });

  it('if re-validation fails during re-activate, the version status REMAINS strictly ARCHIVED (does not become DRAFT or VALIDATED)', async () => {
    const modelId = 'test_failed_reactivate_model';
    await createAndActivateModel(modelId, '1.0.0');

    // Archive 1.0.0
    await archiveVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'web-user' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });

    // Verify it is ARCHIVED
    const versionsBefore = await listBaselineVersions(modelId);
    expect(versionsBefore.find(v => v.version === '1.0.0')?.status).toBe('ARCHIVED');

    // Make validation fail by deleting reference dataset blob
    await getBlobStore().del(`ref_${modelId}`);

    // Try to re-activate
    const reactRes = await reactivateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/reactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'registry-panel' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });

    expect(reactRes.status).toBe(400);
    const data = await reactRes.json();
    expect(data.ok).toBe(false);
    expect(data.code).toBe('REVALIDATION_FAILED');
    expect(data.error).toContain('ไม่ผ่านการตรวจสอบ');
    expect(data.error).toContain('สถานะยังคงเป็น ARCHIVED');

    // CRITICAL: verify in stored versions that status is STILL 'ARCHIVED', not 'DRAFT' and not 'VALIDATED'
    const versionsAfter = await listBaselineVersions(modelId);
    const v100 = versionsAfter.find(v => v.version === '1.0.0')!;
    expect(v100.status).toBe('ARCHIVED');
    expect(v100.status).not.toBe('DRAFT');
    expect(v100.status).not.toBe('VALIDATED');
    expect(v100.validationReport?.ok).toBe(false);
    expect(v100.validationReport?.errors[0].code).toBe('REFERENCE_NOT_FOUND');

    // Verify reactivate_failed audit log entry
    const auditLogs = await listDeletionAuditLogs();
    const failEntry = auditLogs.find(a => a.modelId === modelId && a.version === '1.0.0' && a.action === 'reactivate_failed');
    expect(failEntry).toBeDefined();
    expect(failEntry?.actor).toBe('registry-panel');
    expect(failEntry?.reason).toBe('REVALIDATION_FAILED');
    expect(failEntry?.errorCount).toBeGreaterThan(0);
    expect(failEntry?.previousStatus).toBe('ARCHIVED');
    expect(failEntry?.timestamp).toBeDefined();
  });

  it('re-activate auto-archives any other currently ACTIVE version and records statusHistory and audit', async () => {
    const modelId = 'test_multi_version_reactivate';
    await createAndActivateModel(modelId, '1.0.0');

    // Archive 1.0.0
    await archiveVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'web-user' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });

    // Create and activate 1.0.1
    await createAndActivateModel(modelId, '1.0.1');

    // Now 1.0.1 is ACTIVE, 1.0.0 is ARCHIVED
    const versionsBefore = await listBaselineVersions(modelId);
    expect(versionsBefore.find(v => v.version === '1.0.1')?.status).toBe('ACTIVE');
    expect(versionsBefore.find(v => v.version === '1.0.0')?.status).toBe('ARCHIVED');

    // Re-activate 1.0.0
    const reactRes = await reactivateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/reactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'registry-panel', note: 'Re-activated v1.0.0' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });
    expect(reactRes.status).toBe(200);

    // Verify 1.0.0 is now ACTIVE
    const versionsAfter = await listBaselineVersions(modelId);
    expect(versionsAfter.find(v => v.version === '1.0.0')?.status).toBe('ACTIVE');

    // Verify 1.0.1 was auto-archived with statusHistory and audit log
    const v101 = versionsAfter.find(v => v.version === '1.0.1')!;
    expect(v101.status).toBe('ARCHIVED');
    const autoArchivedStep = v101.statusHistory[v101.statusHistory.length - 1];
    expect(autoArchivedStep.to).toBe('ARCHIVED');
    expect(autoArchivedStep.by).toBe('system');
    expect(autoArchivedStep.note).toContain('Archived automatically when version 1.0.0 was activated');

    const auditLogs = await listDeletionAuditLogs();
    const auditEntry = auditLogs.find(a => a.modelId === modelId && a.version === '1.0.1' && a.action === 'archive_version');
    expect(auditEntry).toBeDefined();
    expect(auditEntry?.actor).toBe('system');
    expect(auditEntry?.note).toContain('Archived automatically when version 1.0.0 was activated');
  });

  it('monitor-upload with a model having no ACTIVE version responds with Thai message and NO_ACTIVE_VERSION code', async () => {
    const modelId = 'test_no_active_model';
    await createAndActivateModel(modelId, '1.0.0');

    // Archive the only version so 0 ACTIVE versions remain
    await archiveVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'web-user' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });

    const m01Text = readFileSync(join(root, 'samples/cashloan_v2/m01_v2_2025-07_ปกติ.csv'), 'utf8');

    const uploadRes = await monitorUploadHandler(new Request('http://localhost/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csvText: m01Text, fileName: 'm01.csv', modelId }),
    }));

    expect(uploadRes.status).toBe(404);
    const data = await uploadRes.json();
    expect(data.code).toBe('NO_ACTIVE_VERSION');
    expect(data.error).toContain('ยังไม่มีเวอร์ชันที่เปิดใช้งาน (ACTIVE)');
  });

  it('if activate fails after validation succeeds during re-activation, rolls back to ARCHIVED and records statusHistory + audit', async () => {
    const modelId = 'test_activate_failure_rollback';
    await createAndActivateModel(modelId, '1.0.0');

    // Archive 1.0.0
    await archiveVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'web-user' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });

    // Verify it is ARCHIVED
    const versionsBefore = await listBaselineVersions(modelId);
    expect(versionsBefore.find(v => v.version === '1.0.0')?.status).toBe('ARCHIVED');

    // Hook storage to intercept specifically during the 'activate' lifecycle phase
    // (after validation passes and status transitions to VALIDATED)
    let isActivatingPhase = false;
    const originalSave = mockStore.set.bind(mockStore);
    mockStore.set = async (key: string, value: any) => {
      if (key.includes(`registry:model:${modelId}:versions`)) {
        const versions = Array.isArray(value) ? value : [];
        if (versions.some((v: any) => v.version === '1.0.0' && v.status === 'VALIDATED')) {
          isActivatingPhase = true;
        }
      }
      return originalSave(key, value);
    };

    const blobStore = getBlobStore();
    const originalBlobGet = blobStore.get.bind(blobStore);
    blobStore.get = async (key: string) => {
      if (isActivatingPhase) {
        throw new Error('Simulated storage failure during activateBaselineVersion');
      }
      return originalBlobGet(key);
    };

    // Attempt to re-activate
    const reactRes = await reactivateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/reactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'admin-user', note: 'Reactivation test' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });

    expect(reactRes.status).toBe(500);

    // Verify status was rolled back to ARCHIVED and is NOT left as VALIDATED or ACTIVE
    const versionsAfter = await listBaselineVersions(modelId);
    const v100 = versionsAfter.find(v => v.version === '1.0.0')!;
    expect(v100.status).toBe('ARCHIVED');
    expect(v100.status).not.toBe('VALIDATED');
    expect(v100.status).not.toBe('ACTIVE');

    // Verify statusHistory records the rollback from VALIDATED to ARCHIVED
    const lastHistory = v100.statusHistory[v100.statusHistory.length - 1];
    expect(lastHistory.from).toBe('VALIDATED');
    expect(lastHistory.to).toBe('ARCHIVED');
    expect(lastHistory.by).toBe('admin-user');
    expect(lastHistory.note).toContain('Rollback to ARCHIVED after activation failure');
    expect(lastHistory.note).toContain('Simulated storage failure');

    // Verify audit log has reactivate_failed with previousStatus VALIDATED
    const auditLogs = await listDeletionAuditLogs();
    const auditEntry = auditLogs.find(a => a.modelId === modelId && a.version === '1.0.0' && a.action === 'reactivate_failed' && a.previousStatus === 'VALIDATED');
    expect(auditEntry).toBeDefined();
    expect(auditEntry?.actor).toBe('admin-user');
    expect(auditEntry?.reason).toBe('ACTIVATION_FAILED');
    expect(auditEntry?.note).toContain('ACTIVATION_FAILED');
  });

  it('recovering stuck VALIDATED version with ARCHIVED history succeeds, while normal VALIDATED version is rejected', async () => {
    const modelId = 'test_stuck_validated_recovery';
    await createAndActivateModel(modelId, '1.0.0');

    // Archive 1.0.0 first
    await archiveVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'web-user' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });

    // Manually simulate a crashed/stuck activation that left the version at VALIDATED with ARCHIVED in history
    const versions = await mockStore.get<any[]>(`registry:model:${modelId}:versions`);
    expect(versions).toBeDefined();
    const targetIdx = versions!.findIndex((v: any) => v.version === '1.0.0');
    expect(targetIdx).toBeGreaterThanOrEqual(0);

    const stuckVersion = {
      ...versions![targetIdx],
      status: 'VALIDATED',
      statusHistory: [
        ...versions![targetIdx].statusHistory,
        {
          from: 'ARCHIVED',
          to: 'VALIDATED',
          at: new Date().toISOString(),
          by: 'reactivator',
          note: 'Interrupted re-activation',
        },
      ],
    };
    versions![targetIdx] = stuckVersion;
    await mockStore.set(`registry:model:${modelId}:versions`, versions);

    // Call re-activate on the stuck VALIDATED version -> should succeed!
    const retryRes = await reactivateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/reactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'admin-retry', note: 'Retry activation from stuck state' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });

    expect(retryRes.status).toBe(200);
    const retryData = await retryRes.json();
    expect(retryData.ok).toBe(true);
    expect(retryData.baseline.status).toBe('ACTIVE');

    // Now test a freshly created model in VALIDATED status (never ARCHIVED)
    const freshModelId = 'test_fresh_validated';
    const baseText = readFileSync(join(root, 'samples/cashloan_v2/baseline_cashloan_v2_2024.csv'), 'utf8');
    const mtText = readFileSync(join(root, 'samples/cashloan_v2/model_table_cashloan.csv'), 'utf8');
    const referenceId = `ref_${freshModelId}`;

    await referencesHandler(new Request('http://localhost/api/registry/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId, csvText: baseText, modelId: freshModelId, version: '1.0.0', labelColumn: 'default_12m' }),
    }));

    const scRes = await scorecardImportHandler(new Request('http://localhost/api/registry/scorecard/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csvText: mtText, referenceId, scoreColumn: 'credit_score' }),
    }));
    const scData = await scRes.json();

    await createVersionHandler(new Request(`http://localhost/api/registry/models/${freshModelId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '1.0.0',
        name: `Model ${freshModelId}`,
        referenceId,
        mode: 'scorecard',
        scoreDirection: 'higher_better',
        featureRegistry: {},
        columns: { idColumn: 'app_id', dateColumn: 'app_date', labelColumn: 'default_12m', scoreColumn: 'credit_score' },
        modelTable: scData.table,
        scoring: scData.scoring,
      }),
    }), { params: Promise.resolve({ modelId: freshModelId }) });

    await validateVersionHandler(new Request(`http://localhost/api/registry/models/${freshModelId}/versions/1.0.0/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'test-user' }),
    }), { params: Promise.resolve({ modelId: freshModelId, version: '1.0.0' }) });

    // Calling reactivate on this normal VALIDATED version must be rejected
    const rejectRes = await reactivateVersionHandler(new Request(`http://localhost/api/registry/models/${freshModelId}/versions/1.0.0/reactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'user' }),
    }), { params: Promise.resolve({ modelId: freshModelId, version: '1.0.0' }) });

    expect(rejectRes.status).toBe(400);
    const rejectData = await rejectRes.json();
    expect(rejectData.error).toContain('สามารถเรียกกลับมาใช้งาน (Re-activate) ได้เฉพาะเวอร์ชันที่มีสถานะ ARCHIVED หรือค้างระหว่างเปิดใช้งานเท่านั้น');
  });

  it('computeBaselineConfigHash invalidates fast path when modelTable or scoring is altered', async () => {
    const baselineA: any = {
      mode: 'scorecard',
      modelTable: [{ feature: 'f1', bin: '[0, 10)', points: 10 }],
      scoring: { scorecard: { f1: { bins: [10], points: 10 } } },
      columns: { idColumn: 'app_id' },
    };
    const hashA = computeBaselineConfigHash(baselineA);

    // Altering modelTable must change hash
    const baselineB = { ...baselineA, modelTable: [{ feature: 'f1', bin: '[0, 10)', points: 15 }] };
    const hashB = computeBaselineConfigHash(baselineB);
    expect(hashB).not.toBe(hashA);

    // Altering scoring must change hash
    const baselineC = { ...baselineA, scoring: { scorecard: { f1: { bins: [10], points: [15] } } } };
    const hashC = computeBaselineConfigHash(baselineC);
    expect(hashC).not.toBe(hashA);

    // Altering validationPolicy must change hash
    const baselineD = { ...baselineA, validationPolicy: { maxMissingRatio: 0.05 } };
    expect(computeBaselineConfigHash(baselineD)).not.toBe(hashA);

    // Now test end-to-end via re-activate
    const modelId = 'test_hash_invalidation';
    await createAndActivateModel(modelId, '1.0.0');

    // Archive 1.0.0
    await archiveVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'web-user' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });

    // 1. First re-activate with untouched baseline -> must reuse validation report (fast path)
    const reactivateRes1 = await reactivateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/reactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'admin' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });
    expect(reactivateRes1.status).toBe(200);
    const data1 = await reactivateRes1.json();
    expect(data1.report.timings.reusedValidationReport).toBe(true);

    // Archive again
    await archiveVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'web-user' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });

    // Mutate modelTable in store
    const versions = await mockStore.get<any[]>(`registry:model:${modelId}:versions`);
    expect(versions).toBeDefined();
    versions![0].modelTable = [{ feature: 'mutated', points: 99 }];
    await mockStore.set(`registry:model:${modelId}:versions`, versions);

    // 2. Second re-activate after modelTable mutated -> fast path MUST be bypassed
    const reactivateRes2 = await reactivateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/reactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'admin' }),
    }), { params: Promise.resolve({ modelId, version: '1.0.0' }) });
    expect(reactivateRes2.status).toBe(200);
    const data2 = await reactivateRes2.json();
    expect(data2.report.timings.reusedValidationReport).toBe(false);
  });
});
