import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setStore, UpstashMockStore } from '../lib/storage/store';
import { createMemoryBlobStore, setBlobStore } from '../lib/storage/blob';
import { getEffectiveConfig, getEffectiveModel, listBaselineVersions, listRuns } from '../lib/storage/repositories';

// Route handlers
import { POST as referencesHandler } from '../app/api/registry/references/route';
import { POST as scorecardImportHandler } from '../app/api/registry/scorecard/import/route';
import { POST as createVersionHandler } from '../app/api/registry/models/[modelId]/versions/route';
import { POST as validateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/validate/route';
import { POST as activateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/activate/route';
import { POST as explainValidationHandler } from '../app/api/registry/explain-validation/route';
import { GET as getRegistryModelsHandler } from '../app/api/registry/models/route';
import { GET as getDefaultHandler } from '../app/api/registry/default/route';
import { GET as getAuditHandler } from '../app/api/registry/audit/route';

describe('Wizard Client Sequence and Concurrency Tests', () => {
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

  async function setupModel(modelId: string, version: string) {
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

    const valRes = await validateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/${version}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    }), { params: Promise.resolve({ modelId, version }) });
    const valData = await valRes.json();

    return { referenceId, valData };
  }

  it('runs exact client sequence (fire-and-forget explain, activate, concurrent dashboard loads)', async () => {
    const modelId = 'model_client_seq';
    const version = '1.0.0';
    const { valData } = await setupModel(modelId, version);

    // 1. Client Step 4 fire-and-forget explain validation
    const explainPromise = explainValidationHandler(new Request('http://localhost/api/registry/explain-validation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: valData.validationReport }),
    }));

    // 2. Client Step 5: user clicks Activate
    const actReq = new Request(`http://localhost/api/registry/models/${modelId}/versions/${version}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'onboarding-wizard' }),
    });
    const actRes = await activateVersionHandler(actReq, { params: Promise.resolve({ modelId, version }) });
    expect(actRes.status).toBe(200);

    // 3. Client handleWizardSuccess immediately triggers multiple concurrent loads
    const [modelsRes, defRes, auditRes, cfg, logs, expRes] = await Promise.all([
      getRegistryModelsHandler(),
      getDefaultHandler(),
      getAuditHandler(new Request('http://localhost/api/registry/audit')),
      getEffectiveConfig(modelId),
      listRuns('monitoring', modelId),
      explainPromise,
    ]);

    expect(modelsRes.status).toBe(200);
    const modelsData = await modelsRes.json();
    const targetModel = modelsData.models.find((m: any) => m.modelId === modelId);
    expect(targetModel).toBeDefined();
    expect(targetModel.versions).toHaveLength(1);
    expect(targetModel.versions[0].status).toBe('ACTIVE');
    expect(targetModel.activeVersion?.status).toBe('ACTIVE');

    // 4. Verify model is active in repositories
    const effModel = await getEffectiveModel(modelId);
    expect(effModel.status).toBe('active');
  });

  it('handles concurrent double-click on Activate without archiving', async () => {
    const modelId = 'model_concurrent_act';
    const version = '1.0.0';
    await setupModel(modelId, version);

    // User double-clicks "Activate" button (two simultaneous POST activate requests)
    const actReq1 = new Request(`http://localhost/api/registry/models/${modelId}/versions/${version}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'onboarding-wizard' }),
    });
    const actReq2 = new Request(`http://localhost/api/registry/models/${modelId}/versions/${version}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'onboarding-wizard' }),
    });

    const [res1, res2] = await Promise.all([
      activateVersionHandler(actReq1, { params: Promise.resolve({ modelId, version }) }),
      activateVersionHandler(actReq2, { params: Promise.resolve({ modelId, version }) }),
    ]);

    // At least one must succeed with 200
    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(200);

    // Check final status in storage
    const versions = await listBaselineVersions(modelId);
    expect(versions).toHaveLength(1);
    expect(versions[0].status).toBe('ACTIVE');
    expect(versions[0].status).not.toBe('ARCHIVED');
  });

  it('verifies that activating a version NEVER archives itself even if called with strange params', async () => {
    const modelId = 'model_self_check';
    const version = '1.0.0';
    await setupModel(modelId, version);

    const actRes = await activateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/${version}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'user' }),
    }), { params: Promise.resolve({ modelId, version }) });
    expect(actRes.status).toBe(200);

    const versions = await listBaselineVersions(modelId);
    expect(versions[0].status).toBe('ACTIVE');

    // Trying to activate again when already ACTIVE should return 400, NOT ARCHIVE
    const actResAgain = await activateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/${version}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'user' }),
    }), { params: Promise.resolve({ modelId, version }) });
    expect(actResAgain.status).toBe(400);

    const versionsAfter = await listBaselineVersions(modelId);
    expect(versionsAfter[0].status).toBe('ACTIVE');
  });
});

describe('Model Deletion followed by Model Creation Flow', () => {
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
      body: JSON.stringify({ actor: 'test' }),
    }), { params: Promise.resolve({ modelId, version }) });

    const actRes = await activateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/${version}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'onboarding-wizard' }),
    }), { params: Promise.resolve({ modelId, version }) });
    expect(actRes.status).toBe(200);
  }

  it('runs sequential flow: create/activate A -> archive & delete A -> create/activate B', async () => {
    const { DELETE: deleteVersionRoute } = await import('../app/api/registry/models/[modelId]/versions/[version]/route');
    const { DELETE: deleteModelRoute } = await import('../app/api/registry/models/[modelId]/route');

    // 1. Create and activate model A
    const modelA = 'model_a_seq';
    await createAndActivateModel(modelA);
    const verA = await listBaselineVersions(modelA);
    expect(verA[0].status).toBe('ACTIVE');

    // 2. User deletes active model A via UI flow:
    // 2a. User clicks Archive in deleteModal because ACTIVE model cannot be deleted directly
    const arcReq = new Request(`http://localhost/api/registry/models/${modelA}/versions/1.0.0`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive', deleteModelIfEmpty: true }),
    });
    const arcRes = await deleteVersionRoute(arcReq, { params: Promise.resolve({ modelId: modelA, version: '1.0.0' }) });
    expect(arcRes.status).toBe(200);

    const verAArchived = await listBaselineVersions(modelA);
    expect(verAArchived[0].status).toBe('ARCHIVED');
    expect(verAArchived[0].statusHistory.slice(-1)[0]).toMatchObject({
      from: 'ACTIVE',
      to: 'ARCHIVED',
      by: 'api-user',
    });

    // 2b. User proceeds to delete model A
    const delReq = new Request(`http://localhost/api/registry/models/${modelA}`, {
      method: 'DELETE',
    });
    const delRes = await deleteModelRoute(delReq, { params: Promise.resolve({ modelId: modelA }) });
    expect(delRes.status).toBe(200);

    const verAfterDel = await listBaselineVersions(modelA);
    expect(verAfterDel).toHaveLength(0);

    // 3. User immediately creates and activates model B with Wizard
    const modelB = 'model_b_seq';
    await createAndActivateModel(modelB);

    // 4. Verify model B status is ACTIVE (not ARCHIVED!)
    const verB = await listBaselineVersions(modelB);
    expect(verB).toHaveLength(1);
    expect(verB[0].status).toBe('ACTIVE');
    expect(verB[0].status).not.toBe('ARCHIVED');

    const effB = await getEffectiveModel(modelB);
    expect(effB.status).toBe('active');
  });

  it('runs concurrent flow: delete/archive requests on old model overlap with create/activate on new model', async () => {
    const { DELETE: deleteVersionRoute } = await import('../app/api/registry/models/[modelId]/versions/[version]/route');

    // 1. Create and activate model A
    const modelA = 'model_a_concur';
    await createAndActivateModel(modelA);

    // 2. Trigger archive on model A, and simultaneously create/activate model B
    const modelB = 'model_b_concur';

    const arcPromise = deleteVersionRoute(new Request(`http://localhost/api/registry/models/${modelA}/versions/1.0.0`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive', deleteModelIfEmpty: true }),
    }), { params: Promise.resolve({ modelId: modelA, version: '1.0.0' }) });

    const createBPromise = createAndActivateModel(modelB);

    await Promise.all([arcPromise, createBPromise]);

    // Check status of model B
    const verB = await listBaselineVersions(modelB);
    expect(verB).toHaveLength(1);
    expect(verB[0].status).toBe('ACTIVE');

    // Check status of model A
    const verA = await listBaselineVersions(modelA);
    expect(verA[0].status).toBe('ARCHIVED');
  });
});
