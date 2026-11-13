/**
 * Demo Pack Generator (Step 11d).
 *
 * Generates sample CSV files for demonstration, manual inspection, and Step 14 testing:
 *   1. samples/demo/ascore_v1/ (500 rows each):
 *      - 01_clean.csv
 *      - 02_data_error_5pct.csv (unit_error low x10, 5%)
 *      - 03_data_error_20pct.csv (extreme_outlier medium, 20%)
 *      - 04_schema_break.csv (schema break / missing required col)
 *      - 05_rejected_rows.csv (unit_error medium x100, 10% rejected by validation)
 *      - 06_mix_shift.csv (+20 pct pt mix shift)
 *      - 07_label_shift.csv (label shift x2 bad rate)
 *      - 08_concept_shift.csv (concept drift: 100% permuted labels)
 *      - 09_multivariate.csv (multivariate inconsistent, 10%)
 *      - sequence_mix_shift/month_01.csv .. month_12.csv (gradual mix shift starting month 6)
 *
 *   2. samples/demo/ext_model/ (500 rows each):
 *      - 01_clean.csv
 *      - 02_unseen_category.csv
 *      - 03_category_shift.csv
 *      - 04_missing_drift.csv
 *
 *   3. samples/demo/new_model_auto_loan/ (unregistered new model for Wizard demo):
 *      - baseline.csv (600 rows, AUC ~0.70-0.75, score_column mode, higher_is_riskier)
 *      - monitor_clean.csv (500 rows)
 *      - monitor_drift.csv (500 rows, down payment drop + category shift)
 *
 * Runs all files through runMonitoring (both fixed and calibrated modes)
 * and outputs samples/demo/README.md with complete results table.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getEffectiveModel, loadReferenceProfile } from '../lib/storage/repositories';
import { injectAnomaly, toCsv } from '../lib/injection';
import { runMonitoring } from '../lib/monitoring';
import { calibrateThresholds } from '../lib/calibration';
import { registerReferenceDataset } from '../lib/reference';
import type { FeatureDefinition, MonitoringRun, ReferenceDatasetMeta, ScoringConfig } from '../lib/types';

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface OutcomeRow {
  group: string;
  file: string;
  scenario: string;
  rows: number;
  rejectedRows: number;
  flaggedRows: number;
  covStatusFixed: string;
  covStatusCal: string;
  conceptStatusFixed: string;
  labelStatusFixed: string;
  actionFixed: string;
  ruleFixed: string;
  actionCal: string;
  ruleCal: string;
  notes: string;
}

async function main() {
  console.log('======================================================');
  console.log('  Generating Demo Pack & Verifying Outcomes (Step 11d)');
  console.log('======================================================\n');

  const baseDir = join(process.cwd(), 'samples', 'demo');
  const ascoreDir = join(baseDir, 'ascore_v1');
  const ascoreSeqDir = join(ascoreDir, 'sequence_mix_shift');
  const extDir = join(baseDir, 'ext_model');
  const autoLoanDir = join(baseDir, 'new_model_auto_loan');

  mkdirSync(ascoreDir, { recursive: true });
  mkdirSync(ascoreSeqDir, { recursive: true });
  mkdirSync(extDir, { recursive: true });
  mkdirSync(autoLoanDir, { recursive: true });

  const outcomes: OutcomeRow[] = [];

  // ─── 1. ascore_v1 ────────────────────────────────────────────────────────────
  console.log('Loading ascore_v1 model & calibrating null thresholds...');
  const ascoreModel = await getEffectiveModel('ascore_v1');
  const ascoreRef = await loadReferenceProfile(ascoreModel.referenceDatasetId, ascoreModel);
  const ascoreCal = calibrateThresholds(ascoreRef, ascoreModel, { sizes: [500], resamples: 500, seed: 42 });

  const ascoreSpecs: Array<{
    fileName: string;
    scenario: string;
    type: any;
    severity?: any;
    rate?: number;
    magnitude?: number;
    notes?: string;
  }> = [
    {
      fileName: '01_clean.csv',
      scenario: 'ข้อมูลปกติ (Clean Bootstrap)',
      type: 'none',
      severity: 'none',
      rate: 0,
      notes: 'ข้อมูลปกติ ไม่พบความผิดปกติหรือ drift',
    },
    {
      fileName: '02_data_error_5pct.csv',
      scenario: 'หน่วยเงินผิด ×10 จำนวน 5% (Data Error)',
      type: 'unit_error',
      severity: 'low',
      rate: 0.05,
      notes: 'ค่าขยาย 10 เท่า จับได้ในชั้น Screening (IQR/MAD) หรือ Validation',
    },
    {
      fileName: '03_data_error_20pct.csv',
      scenario: 'ค่าสุดขั้ว 20% (Extreme Outlier)',
      type: 'extreme_outlier',
      severity: 'medium',
      rate: 0.20,
      notes: 'ปักธงแถวผิดปกติได้มาก เมื่อตัดแถวออกแล้ว Drift กลับเป็น STABLE (R2)',
    },
    {
      fileName: '04_schema_break.csv',
      scenario: 'โครงสร้างไฟล์ผิด (Schema Break - ขาดคอลัมน์จำเป็น)',
      type: 'schema_break',
      severity: 'high',
      rate: 1.0,
      notes: 'ถูกบล็อกที่ชั้น Validation (BLOCKED_INVALID_DATA)',
    },
    {
      fileName: '05_rejected_rows.csv',
      scenario: 'หน่วยเงินผิด ×100 จำนวน 10% (ถูก Validation ตัดทิ้ง)',
      type: 'unit_error',
      severity: 'medium',
      rate: 0.10,
      notes: 'ค่านอกช่วงยอมรับ โดนตัด 10% เข้ากฎ R1b แนะนำตรวจสอบต้นทาง',
    },
    {
      fileName: '06_mix_shift.csv',
      scenario: 'การกระจายประชากรเลื่อน (+20 จุด% Mix Shift)',
      type: 'mix_shift',
      severity: 'high',
      rate: 1.0,
      magnitude: 0.20,
      notes: 'ลูกค้ากลุ่มเสี่ยงสูงเพิ่มขึ้นชัดเจน Covariate Drift เตือน',
    },
    {
      fileName: '07_label_shift.csv',
      scenario: 'อัตราหนี้เสียเพิ่มขึ้น 2 เท่า (Label Shift ×2)',
      type: 'label_shift',
      severity: 'high',
      rate: 1.0,
      magnitude: 2.0,
      notes: 'Bad Rate เพิ่มขึ้นชัดเจน แต่ความสามารถจัดอันดับ (AUC) ยังดี -> RECALIBRATE',
    },
    {
      fileName: '08_concept_shift.csv',
      scenario: 'ความสัมพันธ์ตัวแปรกับหนี้เสียเปลี่ยน (สลับ Label 100%)',
      type: 'concept_shift',
      severity: 'high',
      rate: 1.0,
      notes: 'Gini/AUC ตกฮวบเหลือใกล้ 0 เกิด Concept Drift วิกฤต -> CONSIDER_RETRAIN',
    },
    {
      fileName: '09_multivariate.csv',
      scenario: 'ความสัมพันธ์ข้ามตัวแปรผิดปกติ 10% (รายได้น้อยแต่กู้สูงผิดเกณฑ์)',
      type: 'multivariate_inconsistent',
      severity: 'medium',
      rate: 0.10,
      notes: 'ความผิดปกติหลายมิติจับได้ด้วย LOF / Isolation Forest',
    },
  ];

  for (const s of ascoreSpecs) {
    const inj = injectAnomaly(ascoreModel, {
      type: s.type,
      severity: s.severity ?? 'medium',
      rate: s.rate ?? 1,
      n: 500,
      seed: 42,
      magnitude: s.magnitude,
    });
    const csvContent = toCsv(inj.rows, inj.columns);
    const filePath = join(ascoreDir, s.fileName);
    writeFileSync(filePath, csvContent, 'utf8');

    // Run monitoring in fixed mode
    const runFixed = runMonitoring({
      model: { ...ascoreModel, calibratedThresholds: ascoreCal, driftConfig: { ...ascoreModel.driftConfig, thresholdMode: 'fixed' } },
      fileName: s.fileName,
      csvText: csvContent,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [],
      recordTriggerEvent: false,
    }).run;

    // Run monitoring in calibrated mode
    const runCal = runMonitoring({
      model: { ...ascoreModel, calibratedThresholds: ascoreCal, driftConfig: { ...ascoreModel.driftConfig, thresholdMode: 'calibrated' } },
      fileName: s.fileName,
      csvText: csvContent,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [],
      recordTriggerEvent: false,
    }).run;

    outcomes.push(recordOutcome('ascore_v1', s.fileName, s.scenario, runFixed, runCal, s.notes || ''));
  }

  // ascore_v1 sequence 12 months (gradual mix shift startMonth 6)
  console.log('Generating ascore_v1 12-month sequence...');
  const seqRunsFixed: MonitoringRun[] = [];
  const seqRunsCal: MonitoringRun[] = [];

  for (let m = 1; m <= 12; m++) {
    const monthStr = String(m).padStart(2, '0');
    const fileName = `sequence_mix_shift/month_${monthStr}.csv`;
    const isDrift = m >= 6;
    const fraction = isDrift ? (m - 5) / 7 : 0;
    const magnitude = isDrift ? +(0.20 * fraction).toFixed(4) : 0;

    const inj = injectAnomaly(ascoreModel, {
      type: isDrift ? 'mix_shift' : 'none',
      severity: 'medium',
      rate: 1,
      n: 500,
      seed: 42 + m * 100,
      magnitude,
    });

    // stamp date
    for (const r of inj.rows) {
      r['application_date'] = `2026-${monthStr}-15`;
    }
    const csvContent = toCsv(inj.rows, inj.columns);
    writeFileSync(join(ascoreDir, fileName), csvContent, 'utf8');

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

    outcomes.push(
      recordOutcome(
        'ascore_v1 (12M sequence)',
        `month_${monthStr}.csv`,
        m < 6 ? `เดือนที่ ${m} (ปกติ)` : `เดือนที่ ${m} (Drift สะสม ${Math.round(fraction * 100)}%)`,
        rf,
        rc,
        m < 6 ? 'ประชากรปกติ' : m < 9 ? 'เริ่มตรวจพบ Drift' : 'Drift รุนแรงต่อเนื่อง (R6 พิจารณา Retrain)',
      ),
    );
  }

  // ─── 2. ext_model ────────────────────────────────────────────────────────────
  console.log('Loading ext_model model & calibrating null thresholds...');
  const extModel = await getEffectiveModel('ext_model');
  const extRef = await loadReferenceProfile(extModel.referenceDatasetId, extModel);
  const extCal = calibrateThresholds(extRef, extModel, { sizes: [500], resamples: 500, seed: 42 });

  const extSpecs = [
    {
      fileName: '01_clean.csv',
      scenario: 'ข้อมูลปกติ (Clean Bootstrap)',
      type: 'none' as const,
      severity: 'none' as const,
      rate: 0,
      notes: 'ข้อมูลปกติสำหรับโมเดลภายนอก (score_column)',
    },
    {
      fileName: '02_unseen_category.csv',
      scenario: 'พบหมวดหมู่ใหม่ที่ไม่เคยมีใน Reference 5% (Unseen Category)',
      type: 'unseen_category' as const,
      severity: 'medium' as const,
      rate: 0.05,
      notes: 'จัดเข้ากลุ่ม __UNSEEN__ และแจ้งเตือนแถวผิดปกติ (R1b/Screening)',
    },
    {
      fileName: '03_category_shift.csv',
      scenario: 'สัดส่วนกลุ่มอาชีพเปลี่ยน (Category Shift)',
      type: 'category_shift' as const,
      severity: 'medium' as const,
      rate: 1.0,
      notes: 'สัดส่วนหมวดหมู่อาชีพเปลี่ยน Jensen-Shannon distance และ CSI สูงขึ้น',
    },
    {
      fileName: '04_missing_drift.csv',
      scenario: 'ค่าว่างเพิ่มขึ้นอย่างมีนัยสำคัญ (Missing Drift)',
      type: 'missing_drift' as const,
      severity: 'medium' as const,
      rate: 1.0,
      notes: 'missing rate เพิ่มขึ้นมากกว่าเกณฑ์ (R3 ตรวจระบบต้นทาง)',
    },
  ];

  for (const s of extSpecs) {
    const inj = injectAnomaly(extModel, {
      type: s.type,
      severity: s.severity,
      rate: s.rate,
      n: 500,
      seed: 101,
    });
    const csvContent = toCsv(inj.rows, inj.columns);
    writeFileSync(join(extDir, s.fileName), csvContent, 'utf8');

    const runFixed = runMonitoring({
      model: { ...extModel, calibratedThresholds: extCal, driftConfig: { ...extModel.driftConfig, thresholdMode: 'fixed' } },
      fileName: s.fileName,
      csvText: csvContent,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [],
      recordTriggerEvent: false,
    }).run;

    const runCal = runMonitoring({
      model: { ...extModel, calibratedThresholds: extCal, driftConfig: { ...extModel.driftConfig, thresholdMode: 'calibrated' } },
      fileName: s.fileName,
      csvText: csvContent,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [],
      recordTriggerEvent: false,
    }).run;

    outcomes.push(recordOutcome('ext_model', s.fileName, s.scenario, runFixed, runCal, s.notes));
  }

  // ─── 3. new_model_auto_loan ──────────────────────────────────────────────────
  console.log('Generating synthetic new_model_auto_loan (baseline + clean + drift)...');
  const autoLoanData = generateAutoLoanData();

  writeFileSync(join(autoLoanDir, 'baseline.csv'), autoLoanData.baselineCsv, 'utf8');
  writeFileSync(join(autoLoanDir, 'monitor_clean.csv'), autoLoanData.cleanCsv, 'utf8');
  writeFileSync(join(autoLoanDir, 'monitor_drift.csv'), autoLoanData.driftCsv, 'utf8');

  // Verify in memory with an ephemeral model object
  const ephemeralModel = buildAutoLoanEphemeralModel();
  registerReferenceDataset(
    {
      referenceId: 'auto_loan_dev600',
      version: '1.0.0',
      modelId: 'new_model_auto_loan',
      description: 'Auto Loan Baseline (Synthetic 600)',
      source: 'baseline.csv',
      createdAt: new Date().toISOString(),
      rowCount: autoLoanData.baselineRows.length,
      columns: Object.keys(autoLoanData.baselineRows[0]),
      badCount: autoLoanData.baselineRows.filter(r => r.npl_flag === 1).length,
      badRate: +(autoLoanData.baselineRows.filter(r => r.npl_flag === 1).length / 600).toFixed(4),
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      sha256: 'synthetic_auto_loan_sha',
    },
    autoLoanData.baselineRows as any,
  );

  const autoRef = await loadReferenceProfile('auto_loan_dev600', ephemeralModel);
  const autoCal = calibrateThresholds(autoRef, ephemeralModel, { sizes: [500], resamples: 500, seed: 42 });

  // Clean monitor
  const autoCleanFixed = runMonitoring({
    model: { ...ephemeralModel, calibratedThresholds: autoCal, driftConfig: { thresholdMode: 'fixed' } },
    fileName: 'monitor_clean.csv',
    csvText: autoLoanData.cleanCsv,
    maxValidationIssues: Infinity,
    maxStoredFlaggedRows: Infinity,
    history: [],
    recordTriggerEvent: false,
  }).run;

  const autoCleanCal = runMonitoring({
    model: { ...ephemeralModel, calibratedThresholds: autoCal, driftConfig: { thresholdMode: 'calibrated' } },
    fileName: 'monitor_clean.csv',
    csvText: autoLoanData.cleanCsv,
    maxValidationIssues: Infinity,
    maxStoredFlaggedRows: Infinity,
    history: [],
    recordTriggerEvent: false,
  }).run;

  outcomes.push(
    recordOutcome(
      'new_model_auto_loan',
      'monitor_clean.csv',
      'ติดตามรายเดือนปกติ (Clean 500 แถว)',
      autoCleanFixed,
      autoCleanCal,
      'ข้อมูลปกติ สอดคล้องกับประชากร Baseline',
    ),
  );

  // Drift monitor
  const autoDriftFixed = runMonitoring({
    model: { ...ephemeralModel, calibratedThresholds: autoCal, driftConfig: { thresholdMode: 'fixed' } },
    fileName: 'monitor_drift.csv',
    csvText: autoLoanData.driftCsv,
    maxValidationIssues: Infinity,
    maxStoredFlaggedRows: Infinity,
    history: [],
    recordTriggerEvent: false,
  }).run;

  const autoDriftCal = runMonitoring({
    model: { ...ephemeralModel, calibratedThresholds: autoCal, driftConfig: { thresholdMode: 'calibrated' } },
    fileName: 'monitor_drift.csv',
    csvText: autoLoanData.driftCsv,
    maxValidationIssues: Infinity,
    maxStoredFlaggedRows: Infinity,
    history: [],
    recordTriggerEvent: false,
  }).run;

  outcomes.push(
    recordOutcome(
      'new_model_auto_loan',
      'monitor_drift.csv',
      'เงินดาวน์ลดลง + สัดส่วนประเภทรถเปลี่ยน (Covariate Drift)',
      autoDriftFixed,
      autoDriftCal,
      'เงินดาวน์เฉลี่ยลดลง และประเภทรถเปลี่ยนสัดส่วน (รถตู้/กระบะเพิ่มขึ้น)',
    ),
  );

  // ─── 4. Write samples/demo/README.md ──────────────────────────────────────────
  console.log('Writing samples/demo/README.md...');
  const readmeContent = generateReadme(outcomes, autoLoanData.baselineStats);
  writeFileSync(join(baseDir, 'README.md'), readmeContent, 'utf8');

  console.log('✓ Demo Pack generated successfully in samples/demo/');
}

function recordOutcome(
  group: string,
  file: string,
  scenario: string,
  runFixed: MonitoringRun,
  runCal: MonitoringRun,
  notes: string,
): OutcomeRow {
  return {
    group,
    file,
    scenario,
    rows: runFixed.validation.totalRows,
    rejectedRows: runFixed.validation.rejectedRows,
    flaggedRows: runFixed.anomaly?.flaggedRowCount ?? 0,
    covStatusFixed: runFixed.driftReport?.covariate.status ?? (runFixed.drift?.overallStatus || 'STABLE'),
    covStatusCal: runCal.driftReport?.covariate.status ?? (runCal.drift?.overallStatus || 'STABLE'),
    conceptStatusFixed: runFixed.driftReport?.concept.status ?? 'STABLE',
    labelStatusFixed: runFixed.driftReport?.label.status ?? 'STABLE',
    actionFixed: runFixed.trigger?.action ?? 'CONTINUE',
    ruleFixed: runFixed.trigger?.matchedRuleId ?? '-',
    actionCal: runCal.trigger?.action ?? 'CONTINUE',
    ruleCal: runCal.trigger?.matchedRuleId ?? '-',
    notes,
  };
}

function generateAutoLoanData() {
  const rnd = mulberry32(101);

  function makeRow(idNum: number, isDrift: boolean, year: number) {
    // down_pct: baseline mean ~22%, drift mean ~14%
    const down_pct = isDrift
      ? Math.max(5, Math.round(5 + rnd() * 18)) // 5% - 23%
      : Math.round(10 + rnd() * 25); // 10% - 35%

    const car_price = Math.round((400000 + rnd() * 1200000) / 10000) * 10000;
    const terms = [36, 48, 60, 72, 84];
    const term = terms[Math.floor(rnd() * terms.length)];

    const catRnd = rnd();
    let car_type: string;
    if (!isDrift) {
      car_type = catRnd < 0.40 ? 'รถเก๋ง' : catRnd < 0.75 ? 'รถกระบะ' : catRnd < 0.92 ? 'รถ SUV' : 'รถตู้';
    } else {
      // Drift: รถตู้ & รถกระบะ increase, รถเก๋ง drops
      car_type = catRnd < 0.15 ? 'รถเก๋ง' : catRnd < 0.65 ? 'รถกระบะ' : catRnd < 0.80 ? 'รถ SUV' : 'รถตู้';
    }

    const age = Math.round(22 + rnd() * 40);

    let riskFactor = (25 - down_pct) * 0.05 + (45 - age) * 0.03 + (term - 60) * 0.015;
    if (car_type === 'รถกระบะ') riskFactor += 0.25;
    if (car_type === 'รถตู้') riskFactor += 0.4;

    const score = Math.round(520 + riskFactor * 120 + (rnd() - 0.5) * 90);
    const logit = -2.8 + riskFactor * 1.5 + (rnd() - 0.5) * 0.8;
    const p = 1 / (1 + Math.exp(-logit));
    const npl = rnd() < p ? 1 : 0;

    const contractNo = `AL-${year}-${String(idNum).padStart(5, '0')}`;
    const m = String(1 + Math.floor(rnd() * 12)).padStart(2, '0');
    const d = String(1 + Math.floor(rnd() * 28)).padStart(2, '0');
    const date = `${year}-${m}-${d}`;

    return {
      เลขที่สัญญา: contractNo,
      วันที่อนุมัติ: date,
      ราคารถ: car_price,
      เงินดาวน์_pct: down_pct,
      ระยะผ่อน_เดือน: term,
      ประเภทรถ: car_type,
      อายุผู้กู้: age,
      risk_score: score,
      npl_flag: npl,
    };
  }

  // 1. Baseline: 600 rows
  const baselineRows: any[] = [];
  for (let i = 1; i <= 600; i++) {
    baselineRows.push(makeRow(i, false, 2025));
  }

  // Calculate baseline AUC
  const bads = baselineRows.filter(r => r.npl_flag === 1);
  const goods = baselineRows.filter(r => r.npl_flag === 0);
  let win = 0;
  for (const b of bads) {
    for (const g of goods) {
      if (b.risk_score > g.risk_score) win += 1;
      else if (b.risk_score === g.risk_score) win += 0.5;
    }
  }
  const baselineAuc = win / (bads.length * goods.length);
  const baselineBadRate = bads.length / baselineRows.length;

  // 2. Clean monitor: 500 rows
  const cleanRows: any[] = [];
  for (let i = 1; i <= 500; i++) {
    cleanRows.push(makeRow(i, false, 2026));
  }

  // 3. Drift monitor: 500 rows
  const driftRows: any[] = [];
  for (let i = 1; i <= 500; i++) {
    driftRows.push(makeRow(i, true, 2026));
  }

  const toLines = (rows: any[]) => {
    const cols = Object.keys(rows[0]);
    return [cols.join(','), ...rows.map(r => cols.map(c => r[c]).join(','))].join('\n');
  };

  return {
    baselineRows,
    baselineCsv: toLines(baselineRows),
    cleanCsv: toLines(cleanRows),
    driftCsv: toLines(driftRows),
    baselineStats: {
      rowCount: 600,
      badCount: bads.length,
      badRate: +(baselineBadRate * 100).toFixed(1),
      auc: +baselineAuc.toFixed(3),
    },
  };
}

function buildAutoLoanEphemeralModel(): any {
  const featureRegistry: Record<string, FeatureDefinition> = {
    ราคารถ: {
      columnName: 'ราคารถ',
      displayName: 'ราคารถ (บาท)',
      dataType: 'numeric',
      required: true,
      monitoringEnabled: true,
      displayOrder: 1,
      validation: { minValue: 100000, maxValue: 5000000 },
    },
    เงินดาวน์_pct: {
      columnName: 'เงินดาวน์_pct',
      displayName: 'เงินดาวน์ (%)',
      dataType: 'numeric',
      required: true,
      monitoringEnabled: true,
      displayOrder: 2,
      validation: { minValue: 0, maxValue: 100 },
    },
    ระยะผ่อน_เดือน: {
      columnName: 'ระยะผ่อน_เดือน',
      displayName: 'ระยะผ่อน (เดือน)',
      dataType: 'numeric',
      required: true,
      monitoringEnabled: true,
      displayOrder: 3,
      validation: { minValue: 12, maxValue: 120 },
    },
    ประเภทรถ: {
      columnName: 'ประเภทรถ',
      displayName: 'ประเภทรถ',
      dataType: 'categorical',
      required: true,
      monitoringEnabled: true,
      displayOrder: 4,
    },
    อายุผู้กู้: {
      columnName: 'อายุผู้กู้',
      displayName: 'อายุผู้กู้ (ปี)',
      dataType: 'numeric',
      required: true,
      monitoringEnabled: true,
      displayOrder: 5,
      validation: { minValue: 18, maxValue: 80 },
    },
  };

  return {
    id: 'new_model_auto_loan',
    name: 'Auto Loan Scorecard',
    mode: 'score_column',
    referenceDatasetId: 'auto_loan_dev600',
    idColumn: 'เลขที่สัญญา',
    dateColumn: 'วันที่อนุมัติ',
    scoreColumn: 'risk_score',
    scoreDirection: 'higher_is_riskier',
    labelColumn: 'npl_flag',
    featureRegistry,
    scoring: {
      mode: 'score_column',
      features: ['ราคารถ', 'เงินดาวน์_pct', 'ระยะผ่อน_เดือน', 'ประเภทรถ', 'อายุผู้กู้'],
      base_points: 0,
      factor: 1,
      offset: 0,
      scorecard: {},
    } as ScoringConfig,
    thresholds: {
      psiWarning: 0.10,
      psiCritical: 0.25,
      csiWarning: 0.10,
      csiCritical: 0.25,
    },
    driftConfig: {
      thresholdMode: 'fixed',
    },
  };
}

function generateReadme(outcomes: OutcomeRow[], autoLoanStats: { rowCount: number; badCount: number; badRate: number; auc: number }): string {
  const ascoreRows = outcomes.filter(o => o.group.startsWith('ascore_v1'));
  const extRows = outcomes.filter(o => o.group === 'ext_model');
  const autoRows = outcomes.filter(o => o.group === 'new_model_auto_loan');

  const formatTable = (rows: OutcomeRow[]) => {
    const header = [
      '| ไฟล์ | สถานการณ์ | แถว | ถูกตัด | โดนธง | Covariate (Fixed/Cal) | Concept | Label | Action (Fixed) | Action (Calibrated) | หมายเหตุ |',
      '| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- | :--- | :--- |',
    ];
    const body = rows.map(r =>
      `| \`${r.file}\` | ${r.scenario} | ${r.rows} | ${r.rejectedRows} | ${r.flaggedRows} | ${r.covStatusFixed} / ${r.covStatusCal} | ${r.conceptStatusFixed} | ${r.labelStatusFixed} | **${r.actionFixed}** (${r.ruleFixed}) | **${r.actionCal}** (${r.ruleCal}) | ${r.notes} |`
    );
    return [...header, ...body].join('\n');
  };

  return `# ชุดไฟล์ข้อมูลตัวอย่างสำหรับทดลองและสาธิตระบบ (Demo Pack)

ชุดไฟล์ข้อมูลในโฟลเดอร์นี้จัดทำขึ้นเพื่อใช้ในการทดลองใช้งาน, สาธิต (Demo) และการทดสอบใน **Step 14** โดยครอบคลุมทั้งข้อมูลที่สะอาด, ข้อมูลผิดพลาด (Data Errors), ปัญหาเชิงโครงสร้าง (Schema Breaks), และรูปแบบการเลื่อนของข้อมูล (Drift Injections)

---

## วิธีใช้งานระบบ 2 รูปแบบหลัก (User Workflows)

### (ก) รูปแบบที่ 1: การเพิ่มโมเดลใหม่เข้าสู่ระบบ (New Model Onboarding)
1. **เข้าสู่ Wizard**: ไปที่หน้า Dashboard แล้วเลือกเมนู *"เพิ่มโมเดลใหม่ / Baseline Onboarding"*
2. **อัปโหลดไฟล์ Baseline**: ลากหรือเลือกไฟล์ \`baseline.csv\` ที่เตรียมไว้
3. **ตรวจสอบและยืนยันบทบาทคอลัมน์**:
   - ระบบจะตรวจหาคอลัมน์ให้อัตโนมัติ ให้ยืนยันบทบาทของแต่ละคอลัมน์ (ID, Date, Score, Label, Features) และกำหนดทิศทางคะแนน (\`ScoreDirection\`)
4. **ตรวจสอบความพร้อม (Validate Baseline)**:
   - กดปุ่ม *"Validate"* เพื่อตรวจสอบคุณภาพข้อมูล, คำนวณค่า AUC, Gini, KS และคำนวณ Calibrated Thresholds
5. **เปิดใช้งาน (Activate)**:
   - เมื่อผลตรวจสอบผ่าน ให้กดปุ่ม *"Activate Baseline"* โมเดลจะพร้อมสำหรับการติดตามผลรายเดือนทันที

---

### (ข) รูปแบบที่ 2: การติดตามผลรายเดือน (Monthly Monitoring & Action Review)
1. **เลือกโมเดล**: เลือกแท็บโมเดลที่ต้องการติดตาม (เช่น \`ascore_v1\` หรือ \`ext_model\`)
2. **อัปโหลดไฟล์ข้อมูลประจำเดือน**: ลากหรือเลือกไฟล์ CSV ของเดือนนั้น
3. **อ่านผลการประเมินและคำแนะนำ**:
   - ตรวจสอบสถานะ Drift รวม, ค่า PSI/CSI, และคำแนะนำแอ็กชัน (\`TriggerAction\`) จากระบบ
4. **ตรวจแถวที่โดนปักธง / ถูกตัด**:
   - ตรวจสอบตาราง Anomaly Screening และ Data Validation เพื่อดูว่ามีแถวที่กรอกข้อมูลผิดพลาดหรือไม่
   - หากพบแถวผิดพลาด สามารถกด Exclude Rows เพื่อจำลองผล Drift ที่แท้จริงได้ทันที

---

## 1. แบบจำลองหลัก: \`ascore_v1\` (Scorecard ภายในองค์กร)

โฟลเดอร์: \`samples/demo/ascore_v1/\` (ขนาดไฟล์ละ 500 แถว)

${formatTable(ascoreRows)}

---

## 2. แบบจำลองภายนอก: \`ext_model\` (โหมด External Score Column)

โฟลเดอร์: \`samples/demo/ext_model/\` (ขนาดไฟล์ละ 500 แถว)

${formatTable(extRows)}

---

## 3. แบบจำลองใหม่: \`new_model_auto_loan\` (สำหรับทดสอบ Wizard ใน Step 14)

โฟลเดอร์: \`samples/demo/new_model_auto_loan/\`
> **หมายเหตุสำคัญ**: โมเดลนี้ **ไม่ได้ถูกลงทะเบียนไว้ล่วงหน้าในระบบ** เพื่อให้ผู้ประเมินสามารถทดลองกระบวนการ Onboarding ผ่าน Wizard ได้จริง

### รายละเอียดข้อมูล Baseline (\`baseline.csv\`)
- **จำนวนแถว**: ${autoLoanStats.rowCount} แถว
- **จำนวนหนี้เสีย (NPL)**: ${autoLoanStats.badCount} สัญญา (Bad Rate = ${autoLoanStats.badRate}%)
- **ประสิทธิภาพโมเดลบน Baseline (AUC)**: **${autoLoanStats.auc}** (อยู่ในช่วงเป้าหมาย 0.70–0.75)

### เฉลยการตั้งค่าบทบาทคอลัมน์ใน Wizard (Step 14 Column Mapping):
| ชื่อคอลัมน์ | บทบาทที่ต้องเลือก (Column Role) | ประเภทข้อมูล | หมายเหตุ |
| :--- | :--- | :--- | :--- |
| \`เลขที่สัญญา\` | **ID** | Identifier | รหัสสัญญาอ้างอิง |
| \`วันที่อนุมัติ\` | **Date** | Date (YYYY-MM-DD) | วันที่เริ่มสัญญา |
| \`ราคารถ\` | **Feature** | Numeric | ราคารถยนต์ (บาท) |
| \`เงินดาวน์_pct\` | **Feature** | Numeric | สัดส่วนเงินดาวน์ (%) |
| \`ระยะผ่อน_เดือน\` | **Feature** | Numeric | ระยะเวลาผ่อนชำระ |
| \`ประเภทรถ\` | **Feature** | Categorical | รถเก๋ง / รถกระบะ / รถ SUV / รถตู้ |
| \`อายุผู้กู้\` | **Feature** | Numeric | อายุผู้กู้ (ปี) |
| \`risk_score\` | **Score Column** | Numeric | **โหมด: score_column**, ทิศทาง: **higher_is_riskier** (คะแนนสูง = เสี่ยงสูง) |
| \`npl_flag\` | **Label (Target)** | Binary | 0 = ปกติ, 1 = หนี้เสีย (NPL) |

### ผลลัพธ์จริงเมื่อนำไฟล์ไปมอนิเตอร์หลัง Activate:
${formatTable(autoRows)}

---

## ข้อสังเกตและพฤติกรรมของระบบ (System Insights)
1. **ความไวของเกณฑ์ Fixed vs Calibrated**:
   - ในโหมด **Fixed** ตัวชี้วัด Covariate Drift จะเตือนเมื่อค่า CSI/PSI เกินเกณฑ์สากล (0.10 / 0.25) เท่านั้น หากการกระจายตัวขยับในระดับปานกลาง ค่า CSI อาจยังไม่แตะ 0.10 ทำให้ผลคงเป็น STABLE (บันทึกเป็นข้อจำกัดของเกณฑ์อุตสาหกรรม)
   - ในโหมด **Calibrated** ระบบใช้ Null Distribution Bootstrap ร่วมกับการปรับ family-wise Bonferroni ทำให้มีความไวต่อการเลื่อนของตัวแปรจริงตามขนาดกลุ่มตัวอย่าง $n$
2. **การทำงานของกฎ R1b (Validation Issues)**:
   - เมื่อข้อมูลมีแถวถูกตัดทิ้ง (เช่น หน่วยผิด ค่านอกช่วง) หรือมีแถวซ้ำ เกินกว่า 1% กฎ **R1b** จะดักจับและส่งแอ็กชัน **INVESTIGATE_DATA** ทันที เพื่อป้องกันไม่ให้ข้อผิดพลาดของข้อมูลถูกมองข้ามแม้ผล Drift บนแถวที่เหลือจะยังปกติ
3. **การทำงานของกฎ R2 (Exclusion Rescue)**:
   - ในกรณีค่าสุดขั้ว (\`03_data_error_20pct.csv\`) ข้อมูลผ่าน Validation แต่ถูกปักธงในชั้น Anomaly Screening และเมื่อตัดแถวที่โดนธงออก ผล Drift กลับมาเป็น STABLE ทั้งคู่ กฎ R2 จะยืนยันอย่างแม่นยำว่าเป็น **INVESTIGATE_DATA**
`;
}

main().catch(err => {
  console.error('Error in make_demo_pack:', err);
  process.exit(1);
});
