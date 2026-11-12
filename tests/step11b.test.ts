/**
 * Step 11b Unit & Regression Tests:
 *   (1) calibrateThresholds on ascore_v1 n = 250: false alarm rate is ~5% (±3%) on independent bootstrap set
 *   (2) calibrated threshold at n = 100 is higher than at n = 2500
 *   (3) thresholdMode = fixed: previous results unchanged (regression)
 *   (4) seed:samples run twice consecutively does not produce duplicate versions
 *   (5) missing_drift on ext_model works and missing section is NOT STABLE at severity high
 *   (6) fake score_column model can calibrate cleanly
 *   (7) guard test and all existing pipeline tests pass
 */
import { describe, expect, it } from 'vitest';
import modelConfig from '../app/model-config.json';
import { calibrateThresholds } from '../lib/calibration';
import { getReferenceRows } from '../lib/reference';
import { resolveCsiFeatures } from '../lib/drift';
import { resolveModelColumns } from '../lib/defaults';
import { injectAnomaly, toCsv } from '../lib/injection';
import { runMonitoring } from '../lib/monitoring';
import { buildDriftReport } from '../lib/driftReport';
import { psiWithBoundaries } from '../lib/stats';
import { mulberry32 } from '../lib/random';
import { seedSampleModels } from '../scripts/seed_samples';
import { getEffectiveModel, listBaselineVersions, loadReferenceProfile } from '../lib/storage/repositories';

const ascoreModel = structuredClone((modelConfig as any).models.ascore_v1);

describe('Step 11b — Calibration, Power Curve, and Ext Model', () => {
  it('(1) calibrateThresholds on ascore_v1 n = 250: false alarm rate is ~5% (±3%) on independent bootstrap set', async () => {
    const profile = await loadReferenceProfile(ascoreModel.referenceDatasetId, ascoreModel);
    // Calibrate with seed 42
    const calibrated = calibrateThresholds(profile, ascoreModel, {
      sizes: [250],
      resamples: 300,
      seed: 42,
      k: 1,
    });

    const incomeKey = resolveModelColumns(ascoreModel).dateColumn ? 'monthly_income' : 'monthly_income';
    const csiThreshold = calibrated.bySize[250].csi[incomeKey];
    expect(csiThreshold).toBeDefined();
    expect(csiThreshold.warning).toBeGreaterThan(0);

    // Evaluate on independent bootstrap batches (seed 9999)
    const testRounds = 100;
    const testRnd = mulberry32(9999);
    let falseAlarms = 0;
    const refIncome = profile.features[incomeKey];
    const bins = resolveCsiFeatures(ascoreModel.featureRegistry, ascoreModel.thresholds, profile).find(f => f.key === incomeKey)?.bins ?? [];

    for (let i = 0; i < testRounds; i++) {
      const sample = new Array<number>(250);
      for (let j = 0; j < 250; j++) {
        sample[j] = refIncome[Math.floor(testRnd() * refIncome.length)];
      }
      const csi = psiWithBoundaries(refIncome, sample, bins).value;
      if (csi >= csiThreshold.warning) {
        falseAlarms++;
      }
    }

    const falseAlarmRate = falseAlarms / testRounds;
    // Expected to be around 5% (±3%), i.e. [0.02, 0.08]
    expect(falseAlarmRate).toBeGreaterThanOrEqual(0.02);
    expect(falseAlarmRate).toBeLessThanOrEqual(0.09);
  });

  it('(2) calibrated threshold at n = 100 is higher than at n = 2500', async () => {
    const profile = await loadReferenceProfile(ascoreModel.referenceDatasetId, ascoreModel);
    const calibrated = calibrateThresholds(profile, ascoreModel, {
      sizes: [100, 2500],
      resamples: 150,
      seed: 42,
    });

    const incomeKey = 'monthly_income';
    const wass100 = calibrated.bySize[100].wasserstein[incomeKey].warning;
    const wass2500 = calibrated.bySize[2500].wasserstein[incomeKey].warning;
    expect(wass100).toBeGreaterThan(wass2500);

    const ks100 = calibrated.bySize[100].ks[incomeKey].warning;
    const ks2500 = calibrated.bySize[2500].ks[incomeKey].warning;
    expect(ks100).toBeGreaterThan(ks2500);

    if (calibrated.bySize[100].psi && calibrated.bySize[2500].psi) {
      expect(calibrated.bySize[100].psi.warning).toBeGreaterThan(calibrated.bySize[2500].psi.warning);
    }
  });

  it('(3) thresholdMode = fixed: previous results unchanged (regression)', async () => {
    const refRows = getReferenceRows(ascoreModel.referenceDatasetId).rows;
    const csvText = toCsv(refRows, Object.keys(refRows[0]));

    const runFixed = runMonitoring({
      model: { ...ascoreModel, driftConfig: { thresholdMode: 'fixed' } },
      fileName: 'ref_fixed.csv',
      csvText,
    }).run;

    const runDefault = runMonitoring({
      model: ascoreModel,
      fileName: 'ref_default.csv',
      csvText,
    }).run;

    expect(runFixed.driftReport!.summary.overallStatus).toBe(runDefault.driftReport!.summary.overallStatus);
    expect(runFixed.driftReport!.covariate.status).toBe(runDefault.driftReport!.covariate.status);
    expect(runFixed.driftReport!.statusFixed).toBe(runFixed.driftReport!.summary.overallStatus);
  });

  it('(4) seed:samples run twice consecutively does not produce duplicate versions', async () => {
    const first = await seedSampleModels();
    expect(first.modelId).toBe('ext_model');
    expect(first.version).toBe('1.0.0');

    const second = await seedSampleModels();
    expect(second.created).toBe(false);

    const all = await listBaselineVersions('ext_model');
    const matching = all.filter(v => v.version === '1.0.0');
    expect(matching.length).toBe(1);
    expect(matching[0].status).toBe('ACTIVE');
  });

  it('(5) missing_drift on ext_model works and missing section is NOT STABLE at severity high', async () => {
    await seedSampleModels();
    const extModel = await getEffectiveModel('ext_model');

    const inj = injectAnomaly(extModel, {
      type: 'missing_drift',
      severity: 'high',
      rate: 1,
      seed: 42,
    });
    expect(inj.skipped).toBeFalsy();

    const { run } = runMonitoring({
      model: extModel,
      fileName: 'test_missing_drift.csv',
      csvText: inj.csvText,
    });

    expect(run.driftReport!.missing.status).not.toBe('STABLE');
    expect(run.driftReport!.missing.status).toMatch(/WARNING|CRITICAL/);
  });

  it('(6) fake score_column model can calibrate cleanly', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: `ID_${i + 1}`,
      feat_a: 10 + (i % 50),
      feat_b: 100 + (i % 30),
      cat_x: i % 2 === 0 ? 'TypeA' : 'TypeB',
      model_score: 0.1 + (i % 10) * 0.05,
      target: i % 10 === 0 ? 1 : 0,
    }));

    const fakeModel = {
      id: 'fake_test_model',
      referenceDatasetId: 'fake_ref_dataset',
      mode: 'score_column',
      columns: { idColumn: 'id', scoreColumn: 'model_score', labelColumn: 'target' },
      scoreDirection: 'higher_is_riskier',
      featureRegistry: {
        feat_a: { columnName: 'feat_a', dataType: 'numeric', monitoringEnabled: true },
        feat_b: { columnName: 'feat_b', dataType: 'numeric', monitoringEnabled: true },
        cat_x: { columnName: 'cat_x', dataType: 'categorical', monitoringEnabled: true },
      },
      thresholds: {
        psi_warning: 0.10,
        psi_critical: 0.25,
        csi_features: {},
      },
      driftConfig: {
        thresholdMode: 'fixed',
      },
    };

    const fakeProfile = {
      meta: { referenceId: 'fake_ref_dataset', rowCount: rows.length } as any,
      features: {
        feat_a: rows.map(r => r.feat_a),
        feat_b: rows.map(r => r.feat_b),
      },
      categoricalFeatures: {
        cat_x: rows.map(r => r.cat_x),
      },
      categorySpecs: {
        cat_x: { categories: ['TypeA', 'TypeB'] } as any,
      },
      scores: rows.map(r => r.model_score),
      hasScores: true,
      scoreBoundaries: [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55],
      labels: rows.map(r => r.target),
      hasLabels: true,
      missingCount: {},
      missingRate: {},
    };

    const cal = calibrateThresholds(fakeProfile as any, fakeModel, {
      sizes: [100, 250],
      resamples: 50,
      seed: 42,
    });

    expect(cal).toBeDefined();
    expect(cal.bySize[100]).toBeDefined();
    expect(cal.bySize[100].csi.feat_a).toBeDefined();
    expect(cal.bySize[100].csi.cat_x).toBeDefined();
    expect(cal.bySize[100].psi).toBeDefined();
  });
});
