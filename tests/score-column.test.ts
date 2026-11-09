/**
 * Step 10b.4(b) — Model-agnostic `score_column` mode end-to-end test (Fake Model #3).
 *
 * Model specification:
 *   - modelId: 'ext_gbm_v1', mode: 'score_column'
 *   - columns: { idColumn: 'app_id', dateColumn: 'snapshot_dt', labelColumn: 'target', scoreColumn: 'ext_score' }
 *   - features: x1, x2, x3 with x2 ≈ 0.7 * x1 + noise (strong positive correlation between x1 and x2)
 *   - ext_score: logistic probability of default from x1..x3 (higher score = higher risk, scoreDirection = 'higher_is_riskier')
 *   - No scorecard (scoring is omitted)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mulberry32 } from '../lib/random';
import { createMemoryStore, setStore } from '../lib/storage/store';
import { createMemoryBlobStore, setBlobStore } from '../lib/storage/blob';
import {
  activateBaselineVersion,
  createDraftBaselineVersion,
  getEffectiveModel,
  loadReferenceProfile,
  validateBaselineVersion,
} from '../lib/storage/repositories';
import { registerReferenceDataset } from '../lib/reference';
import { ANOMALY_KIND, injectAnomaly, toCsv } from '../lib/injection';
import { runMonitoring } from '../lib/monitoring';
import { runTrial } from '../lib/experiment';
import { POST as uploadReferenceRoute } from '../app/api/registry/references/route';
import type { AnomalyType, FeatureDefinition } from '../lib/types';

const MODEL_ID = 'ext_gbm_v1';
const REF_ID = 'ext_gbm_ref_400';
const COLUMNS = ['app_id', 'snapshot_dt', 'x1', 'x2', 'x3', 'ext_score', 'target'];

const THIRD_MODEL_REGISTRY: Record<string, FeatureDefinition> = {
  x1: {
    columnName: 'x1',
    displayName: 'Feature X1',
    dataType: 'numeric',
    required: true,
    monitoringEnabled: true,
    displayOrder: 1,
    validation: { minValue: 0, maxValue: 500, allowNull: false },
  },
  x2: {
    columnName: 'x2',
    displayName: 'Feature X2',
    dataType: 'numeric',
    required: true,
    monitoringEnabled: true,
    displayOrder: 2,
    validation: { minValue: -50, maxValue: 500, allowNull: false },
  },
  x3: {
    columnName: 'x3',
    displayName: 'Feature X3',
    dataType: 'numeric',
    required: true,
    monitoringEnabled: true,
    displayOrder: 3,
    validation: { minValue: 0, maxValue: 500, allowNull: false },
  },
};

function buildThirdModelRows(count = 400, seed = 101): Record<string, string | number>[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: count }, (_, i) => {
    const x1 = +(10 + rnd() * 90).toFixed(4);
    const noise = (rnd() - 0.5) * 4; // tight noise in [-2, +2] so x2 ≈ 0.7 * x1 + noise
    const x2 = +(0.7 * x1 + noise).toFixed(4);
    const x3 = +(10 + rnd() * 90).toFixed(4);

    // Logistic model: higher x1, x2, x3 -> higher probability of default (ext_score)
    const z = -1.6 + 0.032 * (x1 - 55) + 0.028 * (x2 - 38.5) + 0.035 * (x3 - 55);
    const prob = 1 / (1 + Math.exp(-z));
    const ext_score = +prob.toFixed(6);
    const target = rnd() < prob ? 1 : 0;
    const day = String((i % 28) + 1).padStart(2, '0');

    return {
      app_id: `APP_${String(i + 1).padStart(4, '0')}`,
      snapshot_dt: `2026-01-${day}`,
      x1,
      x2,
      x3,
      ext_score,
      target,
    };
  });
}

async function setupActiveThirdModel() {
  const rows = buildThirdModelRows(400, 101);
  const csvText = toCsv(rows, COLUMNS);

  const upRes = await uploadReferenceRoute(
    new Request('http://localhost/api/registry/references', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        referenceId: REF_ID,
        modelId: MODEL_ID,
        version: '1.0.0',
        labelColumn: 'target',
        dateColumn: 'snapshot_dt',
        csvText,
      }),
    }),
  );
  expect(upRes.status).toBe(201);
  const upBody = await upRes.json();
  registerReferenceDataset(upBody.meta, rows);

  await createDraftBaselineVersion(MODEL_ID, {
    version: '1.0.0',
    name: 'External GBM Score Model v1',
    description: 'Model-agnostic score_column baseline without scorecard',
    mode: 'score_column',
    columns: {
      idColumn: 'app_id',
      dateColumn: 'snapshot_dt',
      labelColumn: 'target',
      scoreColumn: 'ext_score',
    },
    scoreDirection: 'higher_is_riskier',
    featureRegistry: THIRD_MODEL_REGISTRY,
    thresholds: {
      psi_warning: 0.10,
      psi_critical: 0.25,
      gini_min: 0.15,
      auc_min: 0.55,
      ks_min: 0.10,
      csi_features: {},
    },
    referenceDatasetId: REF_ID,
  });

  const valResult = await validateBaselineVersion(MODEL_ID, '1.0.0');
  const activeVersion = await activateBaselineVersion(MODEL_ID, '1.0.0');
  const model = await getEffectiveModel(MODEL_ID);
  const profile = await loadReferenceProfile(REF_ID, activeVersion);

  return { rows, valResult, activeVersion, model, profile };
}

describe('Step 10b.4(b) — score_column mode with Fake Model #3 (x1, x2, x3, ext_score, target)', () => {
  beforeEach(() => {
    setStore(createMemoryStore());
    setBlobStore(createMemoryBlobStore());
  });

  it('(1) ลงทะเบียน → validate → activate ผ่าน และ AUC บน Reference > 0.6', async () => {
    const { valResult, activeVersion, profile } = await setupActiveThirdModel();

    expect(valResult.ok).toBe(true);
    expect(valResult.report.errors).toEqual([]);
    expect(activeVersion.status).toBe('ACTIVE');
    expect(activeVersion.mode).toBe('score_column');
    expect(activeVersion.scoring).toBeUndefined();

    expect(profile.hasScores).toBe(true);
    expect(profile.scores).toHaveLength(400);
    expect(profile.scoreBoundaries).toHaveLength(9);

    const refAuc = valResult.report.computed.performance?.auc ?? 0;
    console.log('[score-column (1)] Reference performance:', valResult.report.computed.performance);
    expect(refAuc).toBeGreaterThan(0.6);
  });

  it('(2) อัปโหลดไฟล์ปกติ (bootstrap) → score PSI, performance และ riskGrades (D1–D10) คำนวณได้และเป็น STABLE', async () => {
    const { model } = await setupActiveThirdModel();
    const cleanBoot = injectAnomaly(model, { type: 'none', seed: 42 });

    const { run, riskGradeDist, riskGradeStatus } = runMonitoring({
      model,
      fileName: 'ext_clean_bootstrap.csv',
      csvText: cleanBoot.csvText,
    });

    expect(run.validation.ok).toBe(true);
    expect(run.drift).not.toBeNull();
    expect(run.drift!.psi.status).toBe('STABLE');
    expect(run.drift!.psi.bins).toHaveLength(10);

    expect(run.driftReport?.covariate.metrics.score.status).toBe('STABLE');
    expect(run.driftReport?.concept.metrics?.performance.status).toBe('STABLE');
    expect(run.driftReport?.concept.metrics?.performance.actual?.auc).toBeGreaterThan(0.6);
    expect(run.trigger?.action).toBe('CONTINUE');

    // Auto D1–D10 risk grades ordered by scoreDirection (D1 = lowest risk)
    expect(riskGradeStatus).toBe('STABLE');
    expect(riskGradeDist).toHaveLength(10);
    expect(riskGradeDist[0].grade).toBe('D1');
    expect(riskGradeDist[9].grade).toBe('D10');
    const totalCount = riskGradeDist.reduce((s, g) => s + g.count, 0);
    expect(totalCount).toBe(400);
  });

  it('(3) อัปโหลดไฟล์ที่สลับ label มั่ว → concept เป็น CRITICAL → trigger เป็น CONSIDER_RETRAIN', async () => {
    const { model } = await setupActiveThirdModel();
    const base = injectAnomaly(model, { type: 'none', seed: 21 });
    const rnd = mulberry32(999);
    const shuffledRows = base.rows.map(r => ({
      ...r,
      target: rnd() < 0.25 ? 1 : 0, // random label independent of ext_score and x1..x3
    }));
    const csvText = toCsv(shuffledRows, base.columns);

    const { run } = runMonitoring({
      model,
      fileName: 'ext_shuffled_labels.csv',
      csvText,
    });

    expect(run.validation.ok).toBe(true);
    expect(run.driftReport?.concept.status).toBe('CRITICAL');
    expect(run.driftReport?.concept.metrics?.performance.status).toBe('CRITICAL');
    expect(run.trigger?.action).toBe('CONSIDER_RETRAIN');
  });

  it('(4) อัปโหลดไฟล์ที่ไม่มีคอลัมน์ ext_score → ส่วนที่ใช้คะแนนเป็น NOT_AVAILABLE แต่ CSI ยังคำนวณได้และไม่ error', async () => {
    const { model } = await setupActiveThirdModel();
    const base = injectAnomaly(model, { type: 'none', seed: 33 });
    const colsWithoutScore = base.columns.filter(c => c !== 'ext_score');
    const rowsWithoutScore = base.rows.map(r => {
      const copy = { ...r };
      delete copy.ext_score;
      return copy;
    });
    const csvText = toCsv(rowsWithoutScore, colsWithoutScore);

    const { run, riskGradeDist, riskGradeStatus } = runMonitoring({
      model,
      fileName: 'ext_missing_score_col.csv',
      csvText,
    });

    expect(run.validation.ok).toBe(true);
    expect(run.drift).not.toBeNull();
    // Score-dependent sections are NOT_AVAILABLE
    expect(run.drift!.psi.status).toBe('NOT_AVAILABLE');
    expect(run.driftReport?.covariate.metrics.score.status).toBe('NOT_AVAILABLE');
    expect(run.driftReport?.concept.metrics?.performance.status).toBe('NOT_AVAILABLE');
    expect(riskGradeStatus).toBe('NOT_AVAILABLE');
    expect(riskGradeDist).toEqual([]);

    // Feature-level CSI is still computed for x1, x2, x3 without error
    expect(Object.keys(run.drift!.csi).sort()).toEqual(['x1', 'x2', 'x3']);
    for (const k of ['x1', 'x2', 'x3']) {
      expect(run.drift!.csi[k].status).toBe('STABLE');
    }
  });

  it('(5) multivariate_inconsistent เลือกคู่ x1–x2 อัตโนมัติ และ LOF จับได้ (recall >= 0.8)', async () => {
    const { model } = await setupActiveThirdModel();
    const inj = injectAnomaly(model, {
      type: 'multivariate_inconsistent',
      severity: 'medium',
      rate: 0.05,
      seed: 42,
    });

    expect(inj.spec.targetFeatures).toEqual(['x1', 'x2']);

    const trial = runTrial(model, {
      type: 'multivariate_inconsistent',
      severity: 'medium',
      rate: 0.05,
      seed: 42,
    });
    const lofRecall = trial.detectors.lof.recall ?? 0;
    console.log('[score-column (5)] multivariate_inconsistent targets:', inj.spec.targetFeatures, 'LOF recall:', lofRecall);
    expect(lofRecall).toBeGreaterThanOrEqual(0.8);
  });

  it('(6) runTrial ทุก type ของการฉีดทำงานได้บนโมเดลนี้โดยไม่ error', async () => {
    const { model } = await setupActiveThirdModel();
    const allTypes = Object.keys(ANOMALY_KIND) as AnomalyType[];
    const summaryRows: Record<string, unknown>[] = [];

    for (const type of allTypes) {
      const trial = runTrial(model, {
        type,
        severity: type === 'none' ? 'none' : 'medium',
        seed: 42,
      });
      expect(trial.spec.type).toBe(type);
      expect(trial.rowCount).toBeGreaterThan(0);
      summaryRows.push({
        type,
        expectedLayer: trial.expected.layer,
        routedLayer: trial.file.routedLayer,
        injected: trial.injectedCount,
        blocked: trial.file.blocked,
        alarm: trial.file.alarm,
        triggerAction: trial.triggerAction,
      });
    }

    console.table(summaryRows);
    expect(summaryRows).toHaveLength(allTypes.length);
  });
});
