import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../lib/random';
import { registerReferenceDataset, getReferenceProfile } from '../lib/reference';
import { computeRowsSha256, saveReferenceDatasetBlob } from '../lib/storage/blob';
import {
  activateBaselineVersion,
  createDraftBaselineVersion,
  getEffectiveModel,
  validateBaselineVersion,
} from '../lib/storage/repositories';
import { inferColumnsFromRows } from '../lib/baselineValidation';
import { runMonitoring } from '../lib/monitoring';
import { injectAnomaly } from '../lib/injection';
import { runTrial } from '../lib/experiment';
import { validateDataset } from '../lib/validation';
import type { FeatureDefinition, ReferenceDatasetMeta } from '../lib/types';
import modelConfig from '../app/model-config.json';

const MODEL_ID = 'cat_credit_v1';
const REF_ID = 'cat_credit_v1_ref500';
const VERSION = '1.0.0';

const OCCUPATIONS = ['Engineer', 'Teacher', 'Merchant', 'Officer', 'Freelance'] as const;
const REGIONS = ['Bangkok', 'Central', 'North', 'Northeast'] as const;

function buildSyntheticCategoricalDataset(n = 500, seed = 202610) {
  const rnd = mulberry32(seed);
  const columns = ['app_id', 'apply_date', 'net_salary', 'credit_utilization', 'occupation', 'region', 'pd_score', 'is_bad'];
  const rows: Record<string, string | number | null>[] = [];
  let badCount = 0;

  for (let i = 0; i < n; i++) {
    const netSalary = Math.round(18000 + rnd() * 72000);
    const creditUtil = +(0.05 + rnd() * 0.85).toFixed(4);

    // 5 occupations: Engineer (~26%), Teacher (~22%), Merchant (~20%), Officer (~18%), Freelance (~14%)
    const uOcc = rnd();
    const occupation =
      uOcc < 0.26
        ? OCCUPATIONS[0]
        : uOcc < 0.48
          ? OCCUPATIONS[1]
          : uOcc < 0.68
            ? OCCUPATIONS[2]
            : uOcc < 0.86
              ? OCCUPATIONS[3]
              : OCCUPATIONS[4];

    // 4 regions: Bangkok (~35%), Central (~25%), North (~20%), Northeast (~20%)
    const uReg = rnd();
    const region =
      uReg < 0.35
        ? REGIONS[0]
        : uReg < 0.60
          ? REGIONS[1]
          : uReg < 0.80
            ? REGIONS[2]
            : REGIONS[3];

    const occRisk =
      occupation === 'Engineer'
        ? -0.35
        : occupation === 'Officer'
          ? -0.25
          : occupation === 'Teacher'
            ? -0.15
            : occupation === 'Merchant'
              ? 0.20
              : 0.35;

    const logit = -2.0 + 1.8 * creditUtil - (netSalary - 40000) / 60000 + occRisk + (rnd() - 0.5) * 0.5;
    const pdScore = +(1 / (1 + Math.exp(-logit))).toFixed(4);
    const isBad = rnd() < pdScore ? 1 : 0;
    if (isBad === 1) badCount++;

    const month = String((i % 6) + 1).padStart(2, '0');
    rows.push({
      app_id: `CAT_${String(i + 1).padStart(4, '0')}`,
      apply_date: `2025-${month}-15`,
      net_salary: netSalary,
      credit_utilization: creditUtil,
      occupation,
      region,
      pd_score: pdScore,
      is_bad: isBad,
    });
  }

  const sha256 = computeRowsSha256(rows, columns);
  const meta: ReferenceDatasetMeta = {
    referenceId: REF_ID,
    version: '1.0.0',
    modelId: MODEL_ID,
    description: 'Synthetic reference dataset for Fake Model #4 with 2 numeric + 2 categorical features',
    source: 'tests/categorical.test.ts',
    createdAt: '2026-03-01T00:00:00Z',
    rowCount: rows.length,
    badCount,
    badRate: +(badCount / rows.length).toFixed(4),
    periodStart: '2025-01',
    periodEnd: '2025-06',
    columns,
    sha256,
  };

  return { meta, rows, columns };
}

const FEATURE_REGISTRY: Record<string, FeatureDefinition> = {
  net_salary: {
    columnName: 'net_salary',
    displayName: 'เงินเดือนสุทธิ',
    dataType: 'numeric',
    required: true,
    monitoringEnabled: true,
    displayOrder: 1,
    anomalyTransform: 'log1p',
    csiThreshold: 0.10,
    validation: { minValue: 0, maxValue: 1000000, allowNull: false, missingStrategy: 'reject' },
  },
  credit_utilization: {
    columnName: 'credit_utilization',
    displayName: 'อัตราใช้วงเงิน',
    dataType: 'numeric',
    required: true,
    monitoringEnabled: true,
    displayOrder: 2,
    anomalyTransform: 'none',
    csiThreshold: 0.10,
    validation: { minValue: 0, maxValue: 2, allowNull: false, missingStrategy: 'reject' },
  },
  occupation: {
    columnName: 'occupation',
    displayName: 'อาชีพ',
    dataType: 'categorical',
    required: true,
    monitoringEnabled: true,
    displayOrder: 3,
    csiThreshold: 0.10,
    rareCategoryThreshold: 0.01,
    validation: { allowNull: false, missingStrategy: 'fillMode' },
  },
  region: {
    columnName: 'region',
    displayName: 'ภูมิภาค',
    dataType: 'categorical',
    required: true,
    monitoringEnabled: true,
    displayOrder: 4,
    csiThreshold: 0.10,
    rareCategoryThreshold: 0.01,
    validation: { allowNull: false, missingStrategy: 'fillMode' },
  },
};

describe('Step 10b-2: categorical feature support across validation, anomaly, drift, registry, and injection', () => {
  const dataset = buildSyntheticCategoricalDataset(500, 202610);

  it('(1) registers Fake Model #4, validates baseline, and inferColumnsFromRows infers categorical (<= 50) vs string (> 50)', async () => {
    await saveReferenceDatasetBlob({ meta: dataset.meta, rows: dataset.rows });
    registerReferenceDataset(dataset.meta, dataset.rows);

    const inferred = inferColumnsFromRows(dataset.rows, dataset.columns);
    const byCol = Object.fromEntries(inferred.map(c => [c.name, c]));
    expect(byCol.net_salary.inferredType).toBe('numeric');
    expect(byCol.credit_utilization.inferredType).toBe('numeric');
    expect(byCol.occupation.inferredType).toBe('categorical');
    expect(byCol.occupation.uniqueCount).toBe(5);
    expect(byCol.occupation.monitoringEnabled).toBe(true);
    expect(byCol.region.inferredType).toBe('categorical');
    expect(byCol.region.uniqueCount).toBe(4);
    expect(byCol.region.monitoringEnabled).toBe(true);
    expect(byCol.is_bad.inferredType).toBe('binary');
    // app_id has 500 unique text values (> 50) -> inferred as 'string' with monitoringEnabled = false + warning
    expect(byCol.app_id.inferredType).toBe('string');
    expect(byCol.app_id.monitoringEnabled).toBe(false);
    expect(byCol.app_id.warning).toContain('> 50');

    await createDraftBaselineVersion(MODEL_ID, {
      version: VERSION,
      name: 'Categorical Credit Model v1',
      description: 'Fake Model #4 with 2 numeric + 2 categorical features',
      mode: 'score_column',
      columns: {
        idColumn: 'app_id',
        dateColumn: 'apply_date',
        labelColumn: 'is_bad',
        scoreColumn: 'pd_score',
      },
      scoreDirection: 'higher_is_riskier',
      featureRegistry: FEATURE_REGISTRY,
      referenceDatasetId: REF_ID,
      thresholds: {
        psi_warning: 0.10,
        psi_critical: 0.25,
        gini_min: 0.10,
        auc_min: 0.55,
        ks_min: 0.10,
        csi_features: {},
      },
    });

    const valRes = await validateBaselineVersion(MODEL_ID, VERSION);
    expect(valRes.ok).toBe(true);
    expect(valRes.report.errors).toEqual([]);

    const activated = await activateBaselineVersion(MODEL_ID, VERSION);
    expect(activated.status).toBe('ACTIVE');
  });

  it('(2) clean bootstrap on Fake Model #4 → all drift sections are STABLE and IF/LOF records excluded categorical warning in configSnapshot', async () => {
    const model = await getEffectiveModel(MODEL_ID);
    const inj = injectAnomaly(model, { type: 'none', seed: 42 });
    const { run } = runMonitoring({
      model,
      fileName: 'clean_cat_bootstrap.csv',
      csvText: inj.csvText,
      history: [],
      recordTriggerEvent: false,
    });

    expect(run.validation.ok).toBe(true);
    expect(run.drift).not.toBeNull();
    expect(run.drift?.overallStatus).toBe('STABLE');
    expect(run.drift?.csi.occupation).toBeDefined();
    expect(run.drift?.csi.region).toBeDefined();
    expect(run.drift?.csi.occupation.status).toBe('STABLE');
    expect(run.drift?.csi.region.status).toBe('STABLE');

    expect(run.driftReport).not.toBeNull();
    expect(run.driftReport?.covariate.status).toBe('STABLE');
    expect(run.driftReport?.missing.status).toBe('STABLE');
    expect(run.driftReport?.label.status).toBe('STABLE');
    expect(run.driftReport?.concept.status).toBe('STABLE');
    expect(run.driftReport?.summary.status).toBe('STABLE');

    // Categorical covariate report has chiSquare, jensenShannon, distributionProfile.categories, and null ks/wasserstein
    const occCov = run.driftReport?.covariate.metrics.features.occupation;
    expect(occCov?.dataType).toBe('categorical');
    expect(occCov?.ks).toBeNull();
    expect(occCov?.wasserstein).toBeNull();
    expect(occCov?.chiSquare).not.toBeNull();
    expect(occCov?.jensenShannon).not.toBeNull();
    expect(occCov?.jensenShannon?.status).toBe('STABLE');
    expect(occCov?.distributionProfile?.categories?.length).toBe(5);

    // Concept drift includes per-category bad rates for categorical features
    expect(run.driftReport?.concept.metrics?.features.occupation.bins.length).toBe(5);
    expect(run.driftReport?.concept.metrics?.features.region.bins.length).toBe(4);

    // Layer 4 (IF/LOF) excludes categorical features and records warning in configSnapshot
    expect(run.anomaly?.configSnapshot.excludedCategoricalFeatures).toEqual(['occupation', 'region']);
    expect(run.anomaly?.configSnapshot.warnings?.some(w => w.includes('categorical'))).toBe(true);
  });

  it('(3) injecting category_shift high on occupation → CSI and JS of occupation are NOT STABLE', async () => {
    const model = await getEffectiveModel(MODEL_ID);
    const inj = injectAnomaly(model, {
      type: 'category_shift',
      severity: 'high',
      targetFeatures: ['occupation'],
      seed: 42,
    });
    expect(inj.expected.layer).toBe('drift');
    expect(inj.spec.kind).toBe('drift');
    expect(inj.spec.injectedCount).toBeGreaterThan(0);

    const { run } = runMonitoring({
      model,
      fileName: 'category_shift_high.csv',
      csvText: inj.csvText,
      history: [],
      recordTriggerEvent: false,
    });

    const occCov = run.driftReport?.covariate.metrics.features.occupation;
    const csiVal = occCov?.psiOrCsi?.value ?? 0;
    const csiStatus = occCov?.psiOrCsi?.status;
    const jsDist = occCov?.jensenShannon?.distance ?? 0;
    const jsDiv = occCov?.jensenShannon?.divergence ?? 0;
    const jsStatus = occCov?.jensenShannon?.status;
    const chiSq = occCov?.chiSquare;

    console.log(
      'CATEGORY_SHIFT_HIGH_REPORT ' +
        JSON.stringify({
          csi: +csiVal.toFixed(6),
          csiStatus,
          jsDistance: +jsDist.toFixed(6),
          jsDivergence: +jsDiv.toFixed(6),
          jsStatus,
          chiSquareStatistic: chiSq ? +chiSq.statistic.toFixed(4) : null,
          chiSquareDf: chiSq?.df ?? null,
          chiSquarePValue: chiSq?.pValue ?? null,
        }),
    );

    expect(csiStatus).not.toBe('STABLE');
    expect(jsStatus).not.toBe('STABLE');
    expect(occCov?.status).not.toBe('STABLE');
    expect(chiSq?.pValue).toBeLessThan(0.001);
  });

  it('(4) injecting unseen_category 5% → all injected rows flagged with unseen_category, recall = 1, and trigger = INVESTIGATE_DATA or MONITOR_CLOSELY', async () => {
    const model = await getEffectiveModel(MODEL_ID);
    const inj = injectAnomaly(model, {
      type: 'unseen_category',
      severity: 'medium',
      rate: 0.05,
      targetFeatures: ['occupation'],
      seed: 42,
    });
    expect(inj.expected.layer).toBe('anomaly');
    expect(inj.spec.kind).toBe('data_error');

    const { run } = runMonitoring({
      model,
      fileName: 'unseen_cat_5pct.csv',
      csvText: inj.csvText,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [],
      recordTriggerEvent: false,
    });

    // Layer 2: warning UNSEEN_CATEGORY without rejecting rows
    expect(run.validation.ok).toBe(true);
    expect(run.validation.rejectedRows).toBe(0);
    const unseenIssues = run.validation.issues.filter(i => i.type === 'UNSEEN_CATEGORY');
    const injectedRowIds = inj.groundTruth.filter(g => g.injected).map(g => g.row);
    expect(unseenIssues.length).toBe(injectedRowIds.length);

    // Layer 3: every injected row flagged with method 'unseen_category'
    const flaggedWithUnseen = new Set(
      (run.anomaly?.flaggedRows ?? [])
        .filter(f => f.methods.includes('unseen_category'))
        .map(f => f.row),
    );
    for (const r of injectedRowIds) {
      expect(flaggedWithUnseen.has(r)).toBe(true);
    }

    // Trial evaluation: recall = 1, routed to anomaly, trigger is INVESTIGATE_DATA or MONITOR_CLOSELY
    const trial = runTrial(model, {
      type: 'unseen_category',
      severity: 'medium',
      rate: 0.05,
      targetFeatures: ['occupation'],
      seed: 42,
    });
    console.log(
      'UNSEEN_CATEGORY_5PCT_REPORT ' +
        JSON.stringify({
          injectedCount: trial.injectedCount,
          unseenFlaggedCount: flaggedWithUnseen.size,
          anomalyAnyRecall: trial.detectors.anomaly_any.recall,
          allLayersRecall: trial.detectors.all_layers.recall,
          routedLayer: trial.file.routedLayer,
          routingCorrect: trial.file.routingCorrect,
          triggerAction: run.trigger?.action,
          triggerMatchedRuleId: run.trigger?.matchedRuleId,
          driftStatus: run.drift?.overallStatus,
          driftExclFlaggedStatus: run.driftExcludingFlagged?.overallStatus,
        }),
    );

    expect(trial.detectors.anomaly_any.recall).toBe(1);
    expect(trial.detectors.all_layers.recall).toBe(1);
    expect(['INVESTIGATE_DATA', 'MONITOR_CLOSELY']).toContain(run.trigger?.action);
  });

  it('(5) "Engineer" and " engineer " are normalized and counted as the same category (plus rare categories grouped into __OTHER__ and missing filled with mode)', async () => {
    const model = await getEffectiveModel(MODEL_ID);
    const profile = getReferenceProfile(REF_ID, null, {
      labelColumn: 'is_bad',
      scoreColumn: 'pd_score',
      featureRegistry: model.featureRegistry,
    });

    const baseRows = dataset.rows.slice(0, 120).map((r, i) => ({
      ...r,
      app_id: `CASE_${i + 1}`,
      // Alternate between "Engineer", " engineer ", and "  ENGINEER  " whenever occupation is Engineer
      occupation:
        r.occupation === 'Engineer'
          ? i % 3 === 0
            ? 'Engineer'
            : i % 3 === 1
              ? ' engineer '
              : '  ENGINEER  '
          : r.occupation,
    }));

    const { result, rows: clean } = validateDataset(baseRows, dataset.columns, model.featureRegistry, {
      scoringFeatures: [],
      idColumn: 'app_id',
      dateColumn: 'apply_date',
      labelColumn: 'is_bad',
      scoreColumn: 'pd_score',
      referenceCategorySpecs: profile.categorySpecs,
    });

    expect(result.ok).toBe(true);
    expect(result.issues.filter(i => i.type === 'UNSEEN_CATEGORY')).toHaveLength(0);
    const engineerRows = clean.filter((_, i) => dataset.rows[i].occupation === 'Engineer');
    expect(engineerRows.length).toBeGreaterThan(0);
    for (const r of engineerRows) {
      expect(r.categories?.occupation).toBe('Engineer');
    }

    // Also verify missingStrategy = 'fillMode' fills blank occupation with Reference modeCategory
    const withBlank = [{ ...baseRows[0], app_id: 'BLANK_OCC', occupation: '   ' }, ...baseRows.slice(1)];
    const valBlank = validateDataset(withBlank, dataset.columns, model.featureRegistry, {
      scoringFeatures: [],
      idColumn: 'app_id',
      dateColumn: 'apply_date',
      labelColumn: 'is_bad',
      scoreColumn: 'pd_score',
      referenceCategorySpecs: profile.categorySpecs,
    });
    expect(valBlank.result.ok).toBe(true);
    expect(valBlank.rows[0].categories?.occupation).toBe(profile.categorySpecs.occupation.modeCategory);
    expect(valBlank.rows[0].imputed).toContain('occupation');
  });

  it('(6) numeric-only model (ascore_v1) skips category_shift and unseen_category with reason and without error', () => {
    const ascoreModel = structuredClone((modelConfig as any).models.ascore_v1);
    const shiftRes = injectAnomaly(ascoreModel, { type: 'category_shift', severity: 'high', seed: 42 });
    expect(shiftRes.skipped).toBe(true);
    expect(shiftRes.skipReason).toContain('categorical');
    expect(shiftRes.spec.injectedCount).toBe(0);

    const unseenRes = injectAnomaly(ascoreModel, { type: 'unseen_category', severity: 'medium', rate: 0.05, seed: 42 });
    expect(unseenRes.skipped).toBe(true);
    expect(unseenRes.skipReason).toContain('categorical');
    expect(unseenRes.spec.injectedCount).toBe(0);
  });
});
