import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEffectiveModel, loadReferenceProfile } from '../lib/storage/repositories';
import { runMonitoring } from '../lib/monitoring';
import { calibrateThresholds } from '../lib/calibration';
import { registerReferenceDataset } from '../lib/reference';
import type { FeatureDefinition, MonitoringRun, ScoringConfig } from '../lib/types';

function buildAutoLoanEphemeralModel(): any {
  return {
    modelId: 'new_model_auto_loan',
    version: '1.0.0',
    name: 'Auto Loan Default Risk Model (Synthetic)',
    description: 'Machine Learning Model สำหรับทำนายโอกาสผิดนัดชำระหนี้สินเชื่อรถยนต์',
    mode: 'score_column',
    status: 'ACTIVE',
    scoreDirection: 'higher_is_riskier',
    referenceDatasetId: 'auto_loan_dev600',
    columns: {
      idColumn: 'เลขที่สัญญา',
      dateColumn: 'วันที่อนุมัติ',
      labelColumn: 'npl_flag',
      scoreColumn: 'risk_score',
    },
    featureRegistry: {
      'ราคารถ': { columnName: 'ราคารถ', displayName: 'ราคารถยนต์', dataType: 'numeric', required: true, monitoringEnabled: true },
      'เงินดาวน์_pct': { columnName: 'เงินดาวน์_pct', displayName: 'สัดส่วนเงินดาวน์', dataType: 'numeric', required: true, monitoringEnabled: true },
      'ระยะผ่อน_เดือน': { columnName: 'ระยะผ่อน_เดือน', displayName: 'ระยะเวลาผ่อนชำระ', dataType: 'numeric', required: true, monitoringEnabled: true },
      'ประเภทรถ': { columnName: 'ประเภทรถ', displayName: 'ประเภทรถยนต์', dataType: 'categorical', required: true, monitoringEnabled: true },
      'อายุผู้กู้': { columnName: 'อายุผู้กู้', displayName: 'อายุผู้กู้', dataType: 'numeric', required: true, monitoringEnabled: true },
    },
    thresholds: {
      psi_warning: 0.10,
      psi_critical: 0.25,
      csi_features: {},
    },
    driftConfig: {
      thresholdMode: 'fixed',
      ksWarning: 0.10,
      ksCritical: 0.20,
      wassersteinWarning: 0.10,
      wassersteinCritical: 0.25,
      missingDeltaWarning: 0.02,
      missingDeltaCritical: 0.05,
      minLabeledRows: 100,
      labelRelChangeWarning: 0.20,
      labelRelChangeCritical: 0.50,
      labelPValueThreshold: 0.05,
      minBadsPerBin: 5,
      giniRelDropWarning: 0.10,
      giniRelDropCritical: 0.25,
    },
    triggerConfig: { rules: null },
  };
}

function parseCsvSimple(text: string): Record<string, any>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
  const rows: Record<string, any>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    const r: Record<string, any> = {};
    headers.forEach((h, idx) => {
      const val = parts[idx];
      const num = Number(val);
      r[h] = !isNaN(num) && val !== '' ? num : val;
    });
    rows.push(r);
  }
  return rows;
}

function extractSnapshotData(run: MonitoringRun) {
  const dr = run.driftReport as any;
  const covFeatures: Record<string, any> = {};
  const rawFeatures = dr?.covariate?.metrics?.features ?? dr?.covariate?.features;
  if (rawFeatures) {
    for (const [k, f] of Object.entries(rawFeatures as Record<string, any>)) {
      covFeatures[k] = {
        displayName: f.displayName,
        status: f.status,
        statusFixed: f.statusFixed,
        statusCalibrated: f.statusCalibrated,
        csiValue: f.psiOrCsi?.value !== undefined ? +f.psiOrCsi.value.toFixed(4) : null,
        ksD: f.ks?.d !== undefined ? +f.ks.d.toFixed(4) : null,
        wasserstein: f.wasserstein?.scaled !== undefined ? +f.wasserstein.scaled.toFixed(4) : null,
        jensenShannon: f.jensenShannon?.distance !== undefined ? +f.jensenShannon.distance.toFixed(4) : null,
      };
    }
  }

  return {
    validation: {
      ok: run.validation.ok,
      totalRows: run.validation.totalRows,
      validRows: run.validation.validRows,
      rejectedRows: run.validation.rejectedRows,
      rejectedPct: +run.validation.rejectedPct.toFixed(2),
    },
    drift: {
      overallStatus: dr?.overallStatus ?? dr?.summary?.overallStatus ?? run.drift?.overallStatus ?? 'N/A',
      overallStatusFixed: dr?.statusFixed ?? dr?.summary?.overallStatusFixed,
      overallStatusCalibrated: dr?.statusCalibrated ?? dr?.summary?.overallStatusCalibrated,
      covariateStatus: dr?.covariate?.status,
      covariateStatusFixed: dr?.covariate?.statusFixed,
      covariateStatusCalibrated: dr?.covariate?.statusCalibrated,
      covariateFeatures: covFeatures,
      missingStatus: dr?.missing?.status,
      conceptStatus: dr?.concept?.status,
      labelStatus: dr?.label?.status,
    },
    trigger: {
      action: run.trigger?.action,
      severity: run.trigger?.severity,
      matchedRuleId: run.trigger?.matchedRuleId,
      headline: (run.trigger as any)?.headline ?? (run.trigger as any)?.message,
    },
  };
}

async function main() {
  const targetFile = process.argv[2] || 'snapshots/baseline_snapshot_before.json';
  const snapshot: Record<string, any> = {};

  const baseDir = join(process.cwd(), 'samples', 'demo');

  // 1. ascore_v1
  const ascoreModel = await getEffectiveModel('ascore_v1');
  const ascoreRef = await loadReferenceProfile(ascoreModel.referenceDatasetId, ascoreModel);
  const ascoreCal = calibrateThresholds(ascoreRef, ascoreModel, { sizes: [500], resamples: 500, seed: 42 });

  const ascoreFiles = [
    '01_clean.csv',
    '02_data_error_5pct.csv',
    '03_data_error_20pct.csv',
    '04_schema_break.csv',
    '05_rejected_rows.csv',
    '06_mix_shift.csv',
    '07_label_shift.csv',
    '08_concept_shift.csv',
    '09_multivariate.csv',
  ];

  for (const fn of ascoreFiles) {
    const csvContent = readFileSync(join(baseDir, 'ascore_v1', fn), 'utf8');
    const runFixed = runMonitoring({
      model: { ...ascoreModel, calibratedThresholds: ascoreCal, driftConfig: { ...ascoreModel.driftConfig, thresholdMode: 'fixed' } },
      fileName: fn,
      csvText: csvContent,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [],
      recordTriggerEvent: false,
    }).run;
    const runCal = runMonitoring({
      model: { ...ascoreModel, calibratedThresholds: ascoreCal, driftConfig: { ...ascoreModel.driftConfig, thresholdMode: 'calibrated' } },
      fileName: fn,
      csvText: csvContent,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [],
      recordTriggerEvent: false,
    }).run;

    snapshot[`ascore_v1/${fn}`] = {
      fixed: extractSnapshotData(runFixed),
      calibrated: extractSnapshotData(runCal),
    };
  }

  // sequence_mix_shift month_01 to month_12
  const seqRunsFixed: MonitoringRun[] = [];
  const seqRunsCal: MonitoringRun[] = [];
  for (let m = 1; m <= 12; m++) {
    const monthStr = String(m).padStart(2, '0');
    const fn = `sequence_mix_shift/month_${monthStr}.csv`;
    const csvContent = readFileSync(join(baseDir, 'ascore_v1', fn), 'utf8');

    const rf = runMonitoring({
      model: { ...ascoreModel, calibratedThresholds: ascoreCal, driftConfig: { ...ascoreModel.driftConfig, thresholdMode: 'fixed' } },
      fileName: `month_${monthStr}.csv`,
      csvText: csvContent,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [...seqRunsFixed],
      recordTriggerEvent: false,
    }).run;
    seqRunsFixed.push(rf);

    const rc = runMonitoring({
      model: { ...ascoreModel, calibratedThresholds: ascoreCal, driftConfig: { ...ascoreModel.driftConfig, thresholdMode: 'calibrated' } },
      fileName: `month_${monthStr}.csv`,
      csvText: csvContent,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [...seqRunsCal],
      recordTriggerEvent: false,
    }).run;
    seqRunsCal.push(rc);

    snapshot[`ascore_v1/${fn}`] = {
      fixed: extractSnapshotData(rf),
      calibrated: extractSnapshotData(rc),
    };
  }

  // 2. ext_model
  const extModel = await getEffectiveModel('ext_model');
  const extRef = await loadReferenceProfile(extModel.referenceDatasetId, extModel);
  const extCal = calibrateThresholds(extRef, extModel, { sizes: [500], resamples: 500, seed: 101 });

  const extFiles = [
    '01_clean.csv',
    '02_unseen_category.csv',
    '03_category_shift.csv',
    '04_missing_drift.csv',
  ];

  for (const fn of extFiles) {
    const csvContent = readFileSync(join(baseDir, 'ext_model', fn), 'utf8');
    const runFixed = runMonitoring({
      model: { ...extModel, calibratedThresholds: extCal, driftConfig: { ...extModel.driftConfig, thresholdMode: 'fixed' } },
      fileName: fn,
      csvText: csvContent,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [],
      recordTriggerEvent: false,
    }).run;
    const runCal = runMonitoring({
      model: { ...extModel, calibratedThresholds: extCal, driftConfig: { ...extModel.driftConfig, thresholdMode: 'calibrated' } },
      fileName: fn,
      csvText: csvContent,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [],
      recordTriggerEvent: false,
    }).run;

    snapshot[`ext_model/${fn}`] = {
      fixed: extractSnapshotData(runFixed),
      calibrated: extractSnapshotData(runCal),
    };
  }

  // 3. new_model_auto_loan
  const autoLoanModel = buildAutoLoanEphemeralModel();
  const autoBaselineText = readFileSync(join(baseDir, 'new_model_auto_loan', 'baseline.csv'), 'utf8');
  const autoBaselineRows = parseCsvSimple(autoBaselineText);

  registerReferenceDataset(
    {
      referenceId: 'auto_loan_dev600',
      version: '1.0.0',
      modelId: 'new_model_auto_loan',
      description: 'Auto Loan Baseline (Synthetic 600)',
      source: 'baseline.csv',
      createdAt: new Date().toISOString(),
      rowCount: autoBaselineRows.length,
      columns: Object.keys(autoBaselineRows[0]),
      badCount: autoBaselineRows.filter(r => r.npl_flag === 1).length,
      badRate: +(autoBaselineRows.filter(r => r.npl_flag === 1).length / autoBaselineRows.length).toFixed(4),
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      sha256: 'synthetic_auto_loan_sha',
    },
    autoBaselineRows as any,
  );

  const autoRef = await loadReferenceProfile('auto_loan_dev600', autoLoanModel);
  const autoCal = calibrateThresholds(autoRef, autoLoanModel, { sizes: [500], resamples: 500, seed: 999 });

  const autoFiles = ['monitor_clean.csv', 'monitor_drift.csv'];
  for (const fn of autoFiles) {
    const csvContent = readFileSync(join(baseDir, 'new_model_auto_loan', fn), 'utf8');
    const runFixed = runMonitoring({
      model: { ...autoLoanModel, calibratedThresholds: autoCal, driftConfig: { ...autoLoanModel.driftConfig, thresholdMode: 'fixed' } },
      fileName: fn,
      csvText: csvContent,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [],
      recordTriggerEvent: false,
    }).run;
    const runCal = runMonitoring({
      model: { ...autoLoanModel, calibratedThresholds: autoCal, driftConfig: { ...autoLoanModel.driftConfig, thresholdMode: 'calibrated' } },
      fileName: fn,
      csvText: csvContent,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [],
      recordTriggerEvent: false,
    }).run;

    snapshot[`new_model_auto_loan/${fn}`] = {
      fixed: extractSnapshotData(runFixed),
      calibrated: extractSnapshotData(runCal),
    };
  }

  writeFileSync(join(process.cwd(), targetFile), JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`Saved snapshot (${Object.keys(snapshot).length} items) to ${targetFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
