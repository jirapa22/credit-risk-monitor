/**
 * Step 8 — Full Drift Report tests:
 *   (1) Bootstrap sample from Reference → all sections STABLE or NOT_AVAILABLE
 *   (2) mean_shift −20% of monthly_income → covariate of monthly_income not STABLE; KS D & Wasserstein > (1)
 *   (3) unit_error ×10 at 5% rate → print table comparing CSI, KS D, Wasserstein sensitivity
 *   (4) Flip labels so bad rate rises from ~9% to ~18% (features untouched) → label not STABLE, covariate STABLE
 *   (5) File without label column → label and concept are NOT_AVAILABLE, no error
 *   (6) 10% missing in loan_amount (missingStrategy = fillMedian) → missing not STABLE
 *   (7) Second fake model (age, salary, utilization, labelColumn = 'is_bad', no WOE scorecard, no date) →
 *       buildDriftReport works, covariate computed, unavailable parts return NOT_AVAILABLE
 *   (8) Official drift numbers (PSI/CSI) remain identical to runDriftDetection
 */
import { describe, it, expect } from 'vitest';
import modelConfig from '../app/model-config.json';
import { getReferenceProfile, getReferenceRows, registerReferenceDataset } from '../lib/reference';
import { runMonitoring } from '../lib/monitoring';
import { buildDriftReport } from '../lib/driftReport';
import { runDriftDetection } from '../lib/drift';
import { injectAnomaly } from '../lib/injection';
import { calculateAUC, calculateGini, calculateKS } from '../lib/stats';
import { validateDataset } from '../lib/validation';
import type { FeatureDefinition, ScoringConfig } from '../lib/types';

const baseModel = (modelConfig as any).models.ascore_v1;
const refProfile = getReferenceProfile(baseModel.referenceDatasetId, baseModel.scoring as ScoringConfig, {
  labelColumn: baseModel.labelColumn,
  scoreColumn: baseModel.scoreColumn,
});
const refData = getReferenceRows(baseModel.referenceDatasetId);

describe('Step 8 — Model Config & Reference A-Score Direction', () => {
  it('verifies A-Score direction is higher_is_safer and Reference AUC > 0.5', () => {
    expect(baseModel.scoreDirection).toBe('higher_is_safer');
    const pts = refProfile.scores.map((s, i) => ({ score: s, label: refProfile.labels[i] }));
    const auc = calculateAUC(pts, baseModel.scoreDirection);
    const gini = calculateGini(pts, baseModel.scoreDirection);
    const ks = calculateKS(pts);
    console.log(
      `\n[Step 8.1 Reference Performance] scoreDirection=${baseModel.scoreDirection} | AUC=${auc.toFixed(4)} | Gini=${gini.toFixed(4)} | KS=${ks.toFixed(4)}`,
    );
    expect(auc).toBeGreaterThan(0.5);
    expect(gini).toBeGreaterThan(0);
    expect(refProfile.hasLabels).toBe(true);
    expect(refProfile.labels.every(l => l === 0 || l === 1)).toBe(true);
  });
});

describe('Step 8 — Full Drift Report (tests/drift-report.test.ts)', () => {
  // Use a deterministic bootstrap sample of size 855 from Reference
  const bootRows = injectAnomaly(baseModel, { type: 'none', seed: 101 }).rows;
  const bootMon = runMonitoring({
    model: baseModel,
    fileName: 'bootstrap_ref.csv',
    rows: bootRows,
    anomalyScreening: false,
  });
  const bootReport = bootMon.run.driftReport!;

  it('(1) ไฟล์ที่สุ่มแบบ bootstrap จาก Reference: ทุกส่วนต้อง STABLE หรือ NOT_AVAILABLE', () => {
    expect(bootReport).toBeDefined();
    expect(['STABLE', 'NOT_AVAILABLE']).toContain(bootReport.covariate.status);
    expect(['STABLE', 'NOT_AVAILABLE']).toContain(bootReport.missing.status);
    expect(['STABLE', 'NOT_AVAILABLE']).toContain(bootReport.label.status);
    expect(['STABLE', 'NOT_AVAILABLE']).toContain(bootReport.concept.status);
    expect(bootReport.summary.overallStatus).toBe('STABLE');
    expect(bootReport.summary.driftTypesDetected).toEqual([]);
  });

  it('(2) mean_shift −20% ของรายได้: covariate ของรายได้ต้องไม่ STABLE และ KS D กับ Wasserstein ต้องสูงกว่ากรณี (1) ชัดเจน', () => {
    const shiftedRows = bootRows.map(r => ({
      ...r,
      monthly_income: Math.max(15000, Math.round(Number(r.monthly_income) * 0.8)),
    }));
    const shiftedMon = runMonitoring({
      model: baseModel,
      fileName: 'mean_shift_income_minus20.csv',
      rows: shiftedRows,
      anomalyScreening: false,
    });
    const report = shiftedMon.run.driftReport!;
    const incBoot = bootReport.covariate.metrics.features.monthly_income;
    const incShift = report.covariate.metrics.features.monthly_income;

    console.log('\n[Test (2) Table — monthly_income: Bootstrap vs mean_shift -20%]');
    console.table([
      {
        case: 'Bootstrap (Control)',
        CSI: +incBoot.psiOrCsi!.value.toFixed(4),
        KS_D: +incBoot.ks!.d.toFixed(4),
        KS_pValue: +incBoot.ks!.pValue.toFixed(4),
        Wasserstein: +incBoot.wasserstein!.scaled.toFixed(4),
        mean: +incBoot.distributionProfile!.actual.mean.toFixed(1),
        median: +incBoot.distributionProfile!.actual.median.toFixed(1),
        sd: +incBoot.distributionProfile!.actual.sd.toFixed(1),
        iqr: +incBoot.distributionProfile!.actual.iqr.toFixed(1),
        status: incBoot.status,
      },
      {
        case: 'mean_shift -20%',
        CSI: +incShift.psiOrCsi!.value.toFixed(4),
        KS_D: +incShift.ks!.d.toFixed(4),
        KS_pValue: +incShift.ks!.pValue.toFixed(4),
        Wasserstein: +incShift.wasserstein!.scaled.toFixed(4),
        mean: +incShift.distributionProfile!.actual.mean.toFixed(1),
        median: +incShift.distributionProfile!.actual.median.toFixed(1),
        sd: +incShift.distributionProfile!.actual.sd.toFixed(1),
        iqr: +incShift.distributionProfile!.actual.iqr.toFixed(1),
        status: incShift.status,
      },
    ]);

    expect(incShift.status).not.toBe('STABLE');
    expect(incShift.ks!.d).toBeGreaterThan(incBoot.ks!.d + 0.10);
    expect(incShift.wasserstein!.scaled).toBeGreaterThan(incBoot.wasserstein!.scaled + 0.15);
    expect(report.summary.driftTypesDetected).toContain('covariate:monthly_income');
  });

  it('(3) unit_error ×10 จำนวน 5% (ค่าที่ไปอยู่ใน bin ปลายเปิด): เปรียบเทียบ CSI, KS D, Wasserstein (พิมพ์ตาราง)', () => {
    const injected = injectAnomaly(baseModel, {
      type: 'unit_error',
      severity: 'low', // low severity for unit_error = factor ×10
      rate: 0.05,
      seed: 42,
      targetFeatures: ['monthly_income', 'loan_amount'],
    });
    // Relax maxValue on a copy of model config so 10x values are not rejected by Layer 1 range check
    // and reach the Drift layer (open-ended top bin) for direct comparison of CSI vs KS D vs Wasserstein.
    const modelOpenRange = structuredClone(baseModel);
    for (const k of ['monthly_income', 'loan_amount']) {
      if (modelOpenRange.featureRegistry[k]?.validation) {
        modelOpenRange.featureRegistry[k].validation.maxValue = null;
      }
    }
    const unitMon = runMonitoring({
      model: modelOpenRange,
      fileName: 'unit_error_10x_5pct.csv',
      rows: injected.rows,
      anomalyScreening: false,
    });
    const unitReport = unitMon.run.driftReport!;

    const tableRows = ['monthly_income', 'loan_amount'].map(key => {
      const b = bootReport.covariate.metrics.features[key];
      const u = unitReport.covariate.metrics.features[key];
      const csiVal = u.psiOrCsi!.value;
      const ksVal = u.ks!.d;
      const wassVal = u.wasserstein!.scaled;
      const metricsMap: Record<string, number> = {
        CSI: csiVal,
        KS_D: ksVal,
        Wasserstein: wassVal,
      };
      const mostChanged = Object.entries(metricsMap).sort((a, c) => c[1] - a[1])[0][0];
      return {
        feature: key,
        transform: u.wasserstein!.transform,
        boot_CSI: +b.psiOrCsi!.value.toFixed(4),
        unit_CSI: +csiVal.toFixed(4),
        boot_KS_D: +b.ks!.d.toFixed(4),
        unit_KS_D: +ksVal.toFixed(4),
        boot_Wasserstein: +b.wasserstein!.scaled.toFixed(4),
        unit_Wasserstein: +wassVal.toFixed(4),
        mostSensitive: mostChanged,
        status: u.status,
      };
    });

    console.log('\n[Test (3) Table — unit_error ×10 at 5% rate: CSI vs KS D vs Wasserstein]');
    console.table(tableRows);
    expect(tableRows.length).toBe(2);
  });

  it('(4) เปลี่ยน label ให้ bad rate ขึ้นจาก ~9% เป็น ~18% (ฉีดเฉพาะ label ไม่แตะตัวแปร): label ต้องไม่ STABLE แต่ covariate ต้อง STABLE', () => {
    // Use Reference rows directly so features have 0 drift, and flip Good -> Bad on ~9% of rows
    const refRowsCopy = refData.rows.map(r => ({ ...r }));
    const targetBads = Math.round(refRowsCopy.length * 0.18);
    let currentBads = refRowsCopy.filter(r => Number(r.default_flag) === 1).length;
    for (let i = 0; i < refRowsCopy.length && currentBads < targetBads; i++) {
      if (Number(refRowsCopy[i].default_flag) === 0) {
        refRowsCopy[i].default_flag = 1;
        currentBads++;
      }
    }

    const labelMon = runMonitoring({
      model: baseModel,
      fileName: 'label_drift_18pct.csv',
      rows: refRowsCopy,
      anomalyScreening: false,
    });
    const report = labelMon.run.driftReport!;
    const lm = report.label.metrics!;

    console.log('\n[Test (4) Table — Label Drift (~9% -> ~18%)]');
    console.table([
      {
        refBadRatePct: +(lm.referenceBadRate * 100).toFixed(2),
        actualBadRatePct: +(lm.actualBadRate * 100).toFixed(2),
        relChangePct: +((lm.relativeChange ?? 0) * 100).toFixed(2),
        zStat: +(lm.zStat ?? 0).toFixed(4),
        pValue: +(lm.pValue ?? 1).toExponential(3),
        labelStatus: report.label.status,
        covariateStatus: report.covariate.status,
      },
    ]);

    expect(report.label.status).not.toBe('STABLE');
    expect(['WARNING', 'CRITICAL']).toContain(report.label.status);
    expect(report.covariate.status).toBe('STABLE');
    expect(report.summary.driftTypesDetected).toContain('label');
  });

  it('(5) ไฟล์ที่ไม่มีคอลัมน์ label: label และ concept ต้องเป็น NOT_AVAILABLE และต้องไม่ error', () => {
    const noLabelRows = bootRows.map(r => {
      const copy: Record<string, unknown> = { ...r };
      delete copy.default_flag;
      return copy;
    });

    const noLabelMon = runMonitoring({
      model: baseModel,
      fileName: 'no_label.csv',
      rows: noLabelRows,
      anomalyScreening: false,
    });
    const report = noLabelMon.run.driftReport!;

    expect(report.label.status).toBe('NOT_AVAILABLE');
    expect(report.label.reason.length).toBeGreaterThan(0);
    expect(report.concept.status).toBe('NOT_AVAILABLE');
    expect(report.concept.reason.length).toBeGreaterThan(0);
    expect(report.covariate.status).toBe('STABLE');
    expect(report.summary.notAvailable.map(n => n.section)).toEqual(
      expect.arrayContaining(['label', 'concept']),
    );
  });

  it('(6) เพิ่มค่าว่างใน loan_amount 10% (ตั้ง missingStrategy เป็น fillMedian ใน test): missing ต้องไม่ STABLE', () => {
    const modelFillMedian = structuredClone(baseModel);
    modelFillMedian.featureRegistry.loan_amount.validation.allowNull = true;
    modelFillMedian.featureRegistry.loan_amount.validation.missingStrategy = 'fillMedian';

    const missingRows = bootRows.map((r, idx) => ({
      ...r,
      loan_amount: idx < Math.round(bootRows.length * 0.10) ? '' : r.loan_amount,
    }));

    const missMon = runMonitoring({
      model: modelFillMedian,
      fileName: 'missing_loan_10pct.csv',
      rows: missingRows,
      anomalyScreening: false,
    });
    const report = missMon.run.driftReport!;
    const loanMiss = report.missing.metrics.features.loan_amount;

    expect(report.missing.status).not.toBe('STABLE');
    expect(loanMiss.status).toBe('CRITICAL'); // 10% >= 5% critical threshold
    expect(loanMiss.actualMissingRate).toBeCloseTo(Math.round(bootRows.length * 0.10) / bootRows.length, 4);
    expect(loanMiss.imputedRate).toBeCloseTo(Math.round(bootRows.length * 0.10) / bootRows.length, 4);
    expect(report.summary.driftTypesDetected).toContain('missing:loan_amount');
  });

  it('(7) โมเดลปลอมตัวที่สอง (age, salary, utilization, labelColumn = is_bad, ไม่มีสกอร์การ์ด WOE, ไม่มีวันที่)', () => {
    const fakeRefId = 'fake_model_v2_ref';
    const fakeRefRows: Record<string, string | number>[] = Array.from({ length: 250 }, (_, i) => ({
      acct_id: `ACC_${i + 1}`,
      age: 22 + (i % 40),
      salary: 18000 + (i * 350) % 60000,
      utilization: +(((i * 7) % 95) / 100).toFixed(2),
      is_bad: i % 10 === 0 ? 1 : 0,
    }));

    registerReferenceDataset(
      {
        referenceId: fakeRefId,
        version: '1.0.0',
        modelId: 'fake_model_v2',
        description: 'Synthetic reference dataset for second model test',
        source: 'unit-test',
        createdAt: '2026-01-01T00:00:00Z',
        rowCount: fakeRefRows.length,
        badCount: 25,
        badRate: 0.10,
        periodStart: '',
        periodEnd: '',
        columns: ['acct_id', 'age', 'salary', 'utilization', 'is_bad'],
        sha256: 'fake_sha256',
      },
      fakeRefRows,
    );

    const fakeRegistry: Record<string, FeatureDefinition> = {
      age: {
        columnName: 'age',
        displayName: 'Age',
        dataType: 'numeric',
        required: true,
        monitoringEnabled: true,
      },
      salary: {
        columnName: 'salary',
        displayName: 'Monthly Salary',
        dataType: 'numeric',
        required: true,
        monitoringEnabled: true,
        anomalyTransform: 'log1p',
      },
      utilization: {
        columnName: 'utilization',
        displayName: 'Credit Utilization',
        dataType: 'numeric',
        required: true,
        monitoringEnabled: true,
      },
    };

    const fakeModel = {
      id: 'fake_model_v2',
      name: 'Fake Model V2 (No WOE Scorecard)',
      configVersion: '2.0.0',
      referenceDatasetId: fakeRefId,
      idColumn: 'acct_id',
      dateColumn: null,
      labelColumn: 'is_bad',
      featureRegistry: fakeRegistry,
      scoring: {
        base_points: 0,
        factor: 1,
        offset: 0,
        features: ['age', 'salary', 'utilization'],
        scorecard: {},
      },
      thresholds: {
        psi_warning: 0.10,
        psi_critical: 0.25,
        gini_min: 0.10,
        auc_min: 0.55,
        ks_min: 0.10,
        csi_features: {},
      },
    };

    const fakeRefProfile = getReferenceProfile(fakeRefId, fakeModel.scoring, {
      labelColumn: fakeModel.labelColumn,
    });
    expect(fakeRefProfile.hasScores).toBe(false);
    expect(fakeRefProfile.hasLabels).toBe(true);

    // Shift salary by +40% in new data
    const newFakeRows = fakeRefRows.map(r => ({
      ...r,
      salary: Math.round(Number(r.salary) * 1.4),
    }));

    const { rows: cleanFake } = validateDataset(
      newFakeRows,
      ['acct_id', 'age', 'salary', 'utilization', 'is_bad'],
      fakeRegistry,
      {
        scoringFeatures: ['age', 'salary', 'utilization'],
        idColumn: 'acct_id',
        dateColumn: '',
        labelColumn: 'is_bad',
      },
    );

    const fakeReport = buildDriftReport(fakeRefProfile, fakeModel, {
      cleanRows: cleanFake,
      rawRows: newFakeRows,
    });

    expect(fakeReport.model).toEqual({ modelId: 'fake_model_v2', configVersion: '2.0.0' });
    expect(fakeReport.referenceId).toBe(fakeRefId);
    // Numeric features are computed
    expect(Object.keys(fakeReport.covariate.metrics.features)).toEqual(['age', 'salary', 'utilization']);
    expect(fakeReport.covariate.metrics.features.salary.status).not.toBe('STABLE');
    expect(fakeReport.covariate.metrics.features.age.status).toBe('STABLE');
    // Score covariate is NOT_AVAILABLE because there is no scorecard and no scoreColumn
    expect(fakeReport.covariate.metrics.score.status).toBe('NOT_AVAILABLE');
    // Concept performance is NOT_AVAILABLE because there is no score, but bin bad rates ARE computed
    expect(fakeReport.concept.metrics).not.toBeNull();
    expect(fakeReport.concept.metrics!.performance.status).toBe('NOT_AVAILABLE');
    expect(Object.keys(fakeReport.concept.metrics!.features)).toEqual(['age', 'salary', 'utilization']);
    expect(fakeReport.summary.notAvailable.map(x => x.section)).toEqual(
      expect.arrayContaining(['covariate:score', 'concept:performance']),
    );
  });

  it('(8) drift เดิมต้องได้ตัวเลขเท่าเดิม (PSI/CSI ใน run.drift ตรงกับ runDriftDetection ทุกประการ)', () => {
    const actualFeatures: Record<string, number[]> = {
      monthly_income: bootRows.map(r => Number(r.monthly_income)),
      loan_amount: bootRows.map(r => Number(r.loan_amount)),
      dti_ratio: bootRows.map(r => Number(r.dti_ratio)),
    };
    const directDrift = runDriftDetection(
      refProfile,
      bootMon.scored.map(s => s.aScore),
      actualFeatures,
      baseModel.featureRegistry,
      baseModel.thresholds,
    );

    expect(bootMon.run.drift!.psi.value).toBe(directDrift.psi.value);
    for (const k of ['monthly_income', 'loan_amount', 'dti_ratio']) {
      expect(bootMon.run.drift!.csi[k].value).toBe(directDrift.csi[k].value);
      expect(bootReport.covariate.metrics.features[k].psiOrCsi?.value).toBe(directDrift.csi[k].value);
    }
    expect(bootReport.covariate.metrics.score.psiOrCsi?.value).toBe(directDrift.psi.value);
  });
});
