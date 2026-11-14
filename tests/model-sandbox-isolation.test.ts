import { describe, expect, it } from 'vitest';
import {
  archiveBaselineVersion,
  createDraftBaselineVersion,
  deleteRegistryModel,
  getEffectiveConfig,
  getEffectiveModel,
  saveThresholds,
  validateBaselineVersion,
} from '../lib/storage/repositories';
import { runTrial } from '../lib/experiment';
import { POST as saveModelConfigRoute } from '../app/api/save-model-config/route';
import { saveReferenceDatasetBlob } from '../lib/storage/blob';

describe('Model Sandbox Isolation & Selected Model Configuration Tests', () => {
  const customModelId = 'test_model_iso';
  const customVersion = '1.0.0';
  const customRefId = 'ref_iso_dataset_1';

  it('preserves built-in ascore_v1 config and seed run before custom model registration', async () => {
    const ascoreModel = await getEffectiveModel('ascore_v1');
    expect(ascoreModel.id).toBe('ascore_v1');
    expect(ascoreModel.thresholds.psi_warning).toBe(0.10);
    expect(ascoreModel.thresholds.auc_min).toBe(0.55);

    // Baseline trial run with seed 42
    const trialBefore = runTrial(ascoreModel, { type: 'extreme_outlier', severity: 'medium', seed: 42 });
    expect(trialBefore.spec.seed).toBe(42);
    expect(trialBefore.drift?.psi).toBeDefined();

    // Clean up if leftover from previous test runs
    try { await deleteRegistryModel(customModelId, { purgeBlobs: true, actor: 'test' }); } catch { /* ignore */ }

    // Mock Reference Blob for custom model (>= 200 rows)
    const mockRefRows = Array.from({ length: 250 }, (_, i) => ({
      id: String(i + 1),
      score: 500 + (i % 200),
      flag: i % 10 === 0 ? 1 : 0,
      feat_a: 20 + (i % 40),
      feat_b: 1000 + (i * 20),
    }));
    await saveReferenceDatasetBlob({
      rows: mockRefRows,
      meta: {
        referenceId: customRefId,
        modelId: customModelId,
        version: '1.0.0',
        rowCount: 250,
        badCount: 25,
        badRate: 0.1,
        periodStart: '2024-01-01',
        periodEnd: '2024-06-30',
        sha256: 'mocksha256iso',
        source: 'unit_test',
        description: 'Test isolation reference',
        createdAt: '2024-01-01T00:00:00Z',
        columns: ['id', 'score', 'flag', 'feat_a', 'feat_b'],
      },
    });

    // 1. Create custom model with Model Table and Development Stats
    const draft = await createDraftBaselineVersion(customModelId, {
      version: customVersion,
      name: 'Custom Isolation Model',
      description: 'Test isolation between models',
      referenceDatasetId: customRefId,
      mode: 'score_column',
      columns: {
        idColumn: 'id',
        dateColumn: null,
        labelColumn: 'flag',
        scoreColumn: 'score',
      },
      thresholds: {
        psi_warning: 0.15,
        psi_critical: 0.30,
        gini_min: 0.12,
        auc_min: 0.60,
        ks_min: 0.12,
        csi_features: {},
      },
      modelTable: {
        base_points: 500,
        features: ['feat_a', 'feat_b'],
        rows: [
          { variable: 'feat_a', pool_id: 'P1', lower: 0, upper: 30, points: 20 },
          { variable: 'feat_a', pool_id: 'P2', lower: 30, upper: 60, points: -10 },
          { variable: 'feat_b', pool_id: 'P1', lower: 0, upper: 2500, points: 15 },
          { variable: 'feat_b', pool_id: 'P2', lower: 2500, upper: 10000, points: -5 },
        ],
      },
      developmentStats: {
        reported: {
          test: { auc: 0.72, gini: 0.44, ks: 0.36 },
          train: { auc: 0.75, gini: 0.50, ks: 0.40 },
          oot: { auc: 0.69, gini: 0.38, ks: 0.32 },
        },
      },
    });

    expect(draft.status).toBe('DRAFT');

    // 2. Validate version
    const valResult = await validateBaselineVersion(customModelId, customVersion, { dryRun: false });
    if (!valResult.ok) {
      console.error('Validation errors:', valResult.report.errors);
    }
    expect(valResult.version.status).toBe('VALIDATED');

    // 3. Test getEffectiveConfig when model is in VALIDATED status (not yet ACTIVE):
    // Should still load custom model metadata and not fall back to ascore_v1
    const configValidated = await getEffectiveConfig(customModelId);
    expect(configValidated.activeModelId).toBe(customModelId);
    expect(configValidated.models[customModelId]).toBeDefined();
    expect(configValidated.models[customModelId].id).toBe(customModelId);
    expect(configValidated.models[customModelId].thresholds.psi_warning).toBe(0.15);
    expect(configValidated.models[customModelId].modelTable?.base_points).toBe(500);

    // 4. Archive version and verify getEffectiveConfig still returns it (not falling back to ascore_v1)
    await archiveBaselineVersion(customModelId, customVersion, { note: 'Test archive status' });
    const configArchived = await getEffectiveConfig(customModelId);
    expect(configArchived.activeModelId).toBe(customModelId);
    expect(configArchived.models[customModelId]).toBeDefined();
    expect(configArchived.models[customModelId].id).toBe(customModelId);
    expect(configArchived.models[customModelId].status).toBe('archived');

    // 5. Update thresholds for custom model and verify strict isolation
    await saveThresholds(customModelId, {
      psi_warning: 0.22,
      psi_critical: 0.38,
      gini_min: 0.15,
      auc_min: 0.68,
      ks_min: 0.18,
      csi_features: {},
    });

    const updatedCustom = await getEffectiveModel(customModelId);
    expect(updatedCustom.thresholds.psi_warning).toBe(0.22);
    expect(updatedCustom.thresholds.auc_min).toBe(0.68);

    // Verify ascore_v1 thresholds are 100% UNCHANGED
    const ascoreAfter = await getEffectiveModel('ascore_v1');
    expect(ascoreAfter.thresholds.psi_warning).toBe(0.10);
    expect(ascoreAfter.thresholds.auc_min).toBe(0.55);

    // 6. Rerun trial on ascore_v1 with same seed 42 — numbers must match trialBefore exactly
    const trialAfter = runTrial(ascoreAfter, { type: 'extreme_outlier', severity: 'medium', seed: 42 });
    expect(trialAfter.drift?.psi).toBe(trialBefore.drift?.psi);
    expect(trialAfter.detectors.validation.TP).toBe(trialBefore.detectors.validation.TP);
    expect(trialAfter.detectors.iqr.TP).toBe(trialBefore.detectors.iqr.TP);

    // 7. Verify saveModelConfigRoute guards against missing modelId
    const badReq = new Request('http://localhost/api/save-model-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thresholds: { psi_warning: 0.25 } }),
    });
    const badRes = await saveModelConfigRoute(badReq);
    expect(badRes.status).toBe(400);
    const badData = await badRes.json();
    expect(badData.error).toContain('ต้องระบุ modelId');

    // 8. Verify saveModelConfigRoute successfully saves custom model config without touching ascore_v1
    const goodReq = new Request('http://localhost/api/save-model-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId: customModelId,
        thresholds: {
          psi_warning: 0.24,
          psi_critical: 0.40,
          gini_min: 0.16,
          auc_min: 0.70,
          ks_min: 0.20,
        },
      }),
    });
    const goodRes = await saveModelConfigRoute(goodReq);
    expect(goodRes.status).toBe(200);
    const goodData = await goodRes.json();
    expect(goodData.success).toBe(true);
    expect(goodData.model.thresholds.psi_warning).toBe(0.24);

    const ascoreStillUnchanged = await getEffectiveModel('ascore_v1');
    expect(ascoreStillUnchanged.thresholds.psi_warning).toBe(0.10);
    expect(ascoreStillUnchanged.thresholds.auc_min).toBe(0.55);

    // Clean up
    await deleteRegistryModel(customModelId, { purgeBlobs: true, actor: 'test' });
  });

  it('correctly isolates developmentStats (Train/Test/OOT) and returns undefined when absent', async () => {
    const noStatsModelId = 'test_model_no_stats';
    const noStatsVersion = '1.0.0';
    try { await deleteRegistryModel(noStatsModelId, { purgeBlobs: true, actor: 'test' }); } catch { /* ignore */ }

    await createDraftBaselineVersion(noStatsModelId, {
      version: noStatsVersion,
      name: 'No Stats Model',
      description: 'Model without developmentStats',
      referenceDatasetId: 'ascore_v1_dev855',
      mode: 'scorecard',
      columns: { idColumn: 'app_id' },
      thresholds: { psi_warning: 0.10, psi_critical: 0.25, gini_min: 0.10, auc_min: 0.55, ks_min: 0.10, csi_features: {} },
    });

    const config = await getEffectiveConfig(noStatsModelId);
    const model = config.models[noStatsModelId];
    expect(model).toBeDefined();
    expect(model.id).toBe(noStatsModelId);
    expect(model.developmentStats).toBeUndefined();

    await deleteRegistryModel(noStatsModelId, { purgeBlobs: true, actor: 'test' });
  });
});
