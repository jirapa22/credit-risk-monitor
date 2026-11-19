import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

function extractDetail(run: any) {
  const dr = run.driftReport;
  const scorePsi = typeof run.drift?.psi?.value === "number"
    ? +run.drift.psi.value.toFixed(6)
    : (typeof dr?.score?.psi === "number" ? +dr.score.psi.toFixed(6) : null);
  const scoreStatus = run.drift?.psi?.status ?? dr?.score?.status ?? run.drift?.status ?? null;
  const csiFeatures: Record<string, number | null> = {};
  const csiStatus: Record<string, string | null> = {};
  
  const feats = dr?.covariate?.metrics?.features ?? dr?.covariate?.features ?? {};
  for (const [k, f] of Object.entries(feats as Record<string, any>)) {
    csiFeatures[k] = typeof f.psiOrCsi?.value === "number" ? +f.psiOrCsi.value.toFixed(6) : null;
    csiStatus[k] = f.status ?? null;
  }
  
  return {
    scorePsi,
    scoreStatus,
    csiFeatures,
    csiStatus,
    overallStatus: dr?.overallStatus ?? run.drift?.overallStatus ?? "STABLE",
    triggerAction: run.trigger?.action ?? (run.validation?.ok ? "CONTINUE" : "BLOCKED_INVALID_DATA"),
  };
}

async function main() {
  const outputFile = process.argv[2];
  if (!outputFile) {
    console.error('Usage: tsx extract_metrics.ts <outputPath>');
    process.exit(1);
  }

  const cwd = process.cwd();
  const repoImport = (rel: string) => import(pathToFileURL(join(cwd, rel)).href);

  const { getEffectiveModel, loadReferenceProfile } = await repoImport('lib/storage/repositories.ts');
  const { runMonitoring } = await repoImport('lib/monitoring.ts');
  const { calibrateThresholds } = await repoImport('lib/calibration.ts');
  const { registerReferenceDataset } = await repoImport('lib/reference.ts');
  const { seedSampleModels } = await repoImport('scripts/seed_samples.ts');

  await seedSampleModels().catch(() => {});

  const out: Record<string, any> = {};
  const baseDir = join(cwd, 'samples', 'demo');

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

    out[`ascore_v1/${fn}`] = {
      modelId: 'ascore_v1',
      file: fn,
      calibratedThresholds: {
        score: {
          warning: ascoreCal.bySize[500]?.psi?.warning,
          critical: ascoreCal.bySize[500]?.psi?.critical,
        },
        csi_features: Object.fromEntries(
          Object.entries(ascoreCal.bySize[500]?.csi ?? {}).map(([k, v]: [string, any]) => [
            k,
            { warning: v.warning, critical: v.critical },
          ])
        ),
      },
      fixed: extractDetail(runFixed),
      calibrated: extractDetail(runCal),
    };
  }

  // ascore_v1 sequence
  const seqRunsFixed: any[] = [];
  const seqRunsCal: any[] = [];
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

    out[`ascore_v1/${fn}`] = {
      modelId: 'ascore_v1',
      file: fn,
      calibratedThresholds: {
        score: {
          warning: ascoreCal.bySize[500]?.psi?.warning,
          critical: ascoreCal.bySize[500]?.psi?.critical,
        },
        csi_features: Object.fromEntries(
          Object.entries(ascoreCal.bySize[500]?.csi ?? {}).map(([k, v]: [string, any]) => [
            k,
            { warning: v.warning, critical: v.critical },
          ])
        ),
      },
      fixed: extractDetail(rf),
      calibrated: extractDetail(rc),
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

    out[`ext_model/${fn}`] = {
      modelId: 'ext_model',
      file: fn,
      calibratedThresholds: {
        score: {
          warning: extCal.bySize[500]?.psi?.warning,
          critical: extCal.bySize[500]?.psi?.critical,
        },
        csi_features: Object.fromEntries(
          Object.entries(extCal.bySize[500]?.csi ?? {}).map(([k, v]: [string, any]) => [
            k,
            { warning: v.warning, critical: v.critical },
          ])
        ),
      },
      fixed: extractDetail(runFixed),
      calibrated: extractDetail(runCal),
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

    out[`new_model_auto_loan/${fn}`] = {
      modelId: 'new_model_auto_loan',
      file: fn,
      calibratedThresholds: {
        score: {
          warning: autoCal.bySize[500]?.psi?.warning,
          critical: autoCal.bySize[500]?.psi?.critical,
        },
        csi_features: Object.fromEntries(
          Object.entries(autoCal.bySize[500]?.csi ?? {}).map(([k, v]: [string, any]) => [
            k,
            { warning: v.warning, critical: v.critical },
          ])
        ),
      },
      fixed: extractDetail(runFixed),
      calibrated: extractDetail(runCal),
    };
  }

  writeFileSync(outputFile, JSON.stringify(out, null, 2), 'utf8');
  console.log(`Successfully extracted metrics for ${Object.keys(out).length} datasets to ${outputFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

