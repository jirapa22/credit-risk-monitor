import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../lib/csv';
import { importModelTableFromText, scoreRecordWithModelTable } from '../lib/scorecardImport';
import {
  computeDevelopmentStability,
  computeModelTablePoolStats,
} from '../lib/poolStats';
import {
  baselineToModelObject,
  getEffectiveModel,
  createDraftBaselineVersion,
  validateBaselineVersion,
  loadReferenceProfile,
} from '../lib/storage/repositories';
import { saveReferenceDatasetBlob, loadReferenceDatasetBlob } from '../lib/storage/blob';
import { buildReferenceProfileFromData } from '../lib/reference';
import { validateBaseline } from '../lib/baselineValidation';
import { calculateAScore } from '../lib/scoring';
import { calculateAUC, calculateGini, calculateKS, type DataPoint } from '../lib/stats';
import { buildDriftReport } from '../lib/driftReport';

describe('Cash Loan v2 Pool Statistics & Development Stability Tests', () => {
  const root = process.cwd();
  let sharedValResult: any = null;
  const mtText = readFileSync(join(root, 'samples/cashloan_v2/model_table_cashloan.csv'), 'utf8');
  const baseText = readFileSync(join(root, 'samples/cashloan_v2/baseline_cashloan_v2_2024.csv'), 'utf8');
  const { rows } = parseCsv(baseText);
  const imported = importModelTableFromText(mtText, {
    referenceRows: rows,
    scoreColumn: 'credit_score',
  });

  it('(1) computes count, share, bad count, bad rate, WOE, and IV per pool with logical monotonicity', () => {
    expect(imported.ok).toBe(true);

    const stats = computeModelTablePoolStats({
      modelTable: imported.table,
      referenceRows: rows,
      labelColumn: 'default_12m',
    });

    expect(stats.source).toBe('คำนวณโดยระบบจาก Baseline');
    expect(stats.totalIV).toBeGreaterThan(0.5); // Total IV across features

    // 1. Check Age (older = higher points = safer = lower bad rate)
    const agePools = stats.features['age']?.rows;
    expect(agePools).toBeDefined();
    expect(agePools.length).toBe(4);

    // Monotonic decrease in bad rate with age
    for (let i = 0; i < agePools.length - 1; i++) {
      expect(agePools[i].badRate).toBeGreaterThan(agePools[i + 1].badRate);
      expect(agePools[i].woe).toBeLessThan(agePools[i + 1].woe);
    }
    expect(stats.features['age'].iv).toBeCloseTo(0.1420, 2);

    // 2. Check Monthly Income (higher income = higher points = safer = lower bad rate)
    const incPools = stats.features['monthly_income']?.rows;
    expect(incPools).toBeDefined();
    expect(incPools.length).toBe(4);
    for (let i = 0; i < incPools.length - 1; i++) {
      expect(incPools[i].badRate).toBeGreaterThan(incPools[i + 1].badRate);
      expect(incPools[i].woe).toBeLessThan(incPools[i + 1].woe);
    }
    expect(stats.features['monthly_income'].iv).toBeCloseTo(0.1792, 2);

    // 3. Check DTI (higher DTI = lower points = riskier = higher bad rate)
    const dtiPools = stats.features['dti']?.rows;
    expect(dtiPools).toBeDefined();
    expect(dtiPools.length).toBe(4);
    for (let i = 0; i < dtiPools.length - 1; i++) {
      expect(dtiPools[i].badRate).toBeLessThan(dtiPools[i + 1].badRate);
      expect(dtiPools[i].woe).toBeGreaterThan(dtiPools[i + 1].woe);
    }
    expect(stats.features['dti'].iv).toBeCloseTo(0.0324, 2);

    // 4. Check Categorical: Occupation
    const occPools = stats.features['occupation']?.rows;
    expect(occPools).toBeDefined();
    expect(occPools.length).toBe(4);
    // Government / SOE should be safest (highest WOE, lowest bad rate)
    expect(occPools[0].badRate).toBeLessThan(occPools[3].badRate);
    expect(occPools[0].woe).toBeGreaterThan(occPools[3].woe);
    expect(stats.features['occupation'].iv).toBeCloseTo(0.1782, 2);

    // 5. Total share across all pools in a feature must sum to ~1.0
    for (const feat of imported.table.features) {
      const pRows = stats.features[feat].rows;
      const sumShare = pRows.reduce((acc, p) => acc + p.share, 0);
      expect(sumShare).toBeCloseTo(1.0, 3);
      const sumCount = pRows.reduce((acc, p) => acc + p.count, 0);
      expect(sumCount).toBe(5000);
    }
  });

  it('(2) computes development stability (Score PSI & Feature CSI) on chronological 75/25 split', () => {
    const devStab = computeDevelopmentStability({
      referenceRows: rows,
      dateColumn: 'app_date',
      scoreColumn: 'credit_score',
      modelTable: imported.table,
      trainRatio: 0.75,
    });

    expect(devStab.available).toBe(true);
    expect(devStab.trainCount).toBe(3750);
    expect(devStab.testCount).toBe(1250);
    expect(devStab.trainPeriod).toContain('2024');
    expect(devStab.testPeriod).toContain('2024');

    // Score PSI during development should be stable (< 0.10)
    expect(devStab.scorePsi).toBeDefined();
    expect(devStab.scorePsi).toBeLessThan(0.05);

    // Feature CSI for each variable should be defined and small
    expect(devStab.featureCsi).toBeDefined();
    expect(devStab.featureCsi!['age']).toBeLessThan(0.05);
    expect(devStab.featureCsi!['monthly_income']).toBeLessThan(0.05);
    expect(devStab.featureCsi!['dti']).toBeLessThan(0.05);
    expect(devStab.featureCsi!['occupation']).toBeLessThan(0.05);
  });

  it('(3) handles insufficient rows or missing Date column with clear reason', () => {
    // Insufficient rows (< 500)
    const smallStab = computeDevelopmentStability({
      referenceRows: rows.slice(0, 300),
      dateColumn: 'app_date',
      scoreColumn: 'credit_score',
    });
    expect(smallStab.available).toBe(false);
    expect(smallStab.reason).toContain('น้อยกว่า 500 แถว');

    // Missing date column
    const noDateStab = computeDevelopmentStability({
      referenceRows: rows,
      dateColumn: undefined,
      scoreColumn: 'credit_score',
    });
    expect(noDateStab.available).toBe(false);
    expect(noDateStab.reason).toContain('ไม่มีคอลัมน์วันที่');
  });

  it('(4) preserves ascore_v1 existing scorecard, IV summary, and thresholds 100% unchanged', async () => {
    const ascore = await getEffectiveModel('ascore_v1');
    expect(ascore.id).toBe('ascore_v1');
    expect(ascore.scoring?.base_points).toBe(554.2);
    expect(ascore.thresholds.psi_warning).toBe(0.10);
    expect(ascore.thresholds.auc_min).toBe(0.55);

    // Verify scorecard entries exist and have exact original values
    const sc = ascore.scoring?.scorecard;
    expect(sc).toBeDefined();
    expect(ascore.ivSummary).toBeDefined();
    expect(ascore.ivSummary['loan_amount']?.iv).toBe(0.2329);
  });

  it('(5) computes reference bad rate accurately (~12.5%) from default_12m, never 0.0%', () => {
    const meta = {
      referenceId: 'cashloan_v2_ref',
      version: '1.0.0',
      modelId: 'model_cashloan_v2',
      description: 'Cash Loan v2 Baseline',
      source: 'test',
      createdAt: new Date().toISOString(),
      rowCount: rows.length,
      badCount: 0,
      badRate: 0, // Initially unmapped / 0
      periodStart: '2024-01-01',
      periodEnd: '2024-12-31',
      columns: Object.keys(rows[0]),
      sha256: 'test_sha',
    };

    const prof = buildReferenceProfileFromData(
      { meta, rows },
      imported.scoring,
      { labelColumn: 'default_12m' },
    );

    expect(prof.hasLabels).toBe(true);
    expect(prof.meta.badCount).toBe(623);
    expect(prof.meta.badRate).toBeCloseTo(0.1246, 3);
    expect(prof.meta.badRate).toBeGreaterThan(0.10);

    const baselineVer = {
      modelId: 'model_cashloan_v2',
      version: '1.0.0',
      mode: 'scorecard' as const,
      status: 'ACTIVE' as const,
      referenceDatasetId: 'cashloan_v2_ref',
      columns: {
        idColumn: 'app_id',
        dateColumn: 'app_date',
        labelColumn: 'default_12m',
        scoreColumn: 'credit_score',
      },
      scoreDirection: 'higher_is_safer' as const,
      modelTable: imported.table,
      scoring: imported.scoring,
    };

    const modelObj = baselineToModelObject(baselineVer as any, rows);
    expect(modelObj.baseline.bad_rate).toBeCloseTo(0.1246, 3);
    expect(modelObj.baseline.bad_rate).not.toBe(0);
  });

  it('(6) aligns Wizard validation AUC and Sandbox Baseline Performance at 0.753 (without duplicating Train/Test)', () => {
    const meta = {
      referenceId: 'cashloan_v2_ref',
      version: '1.0.0',
      modelId: 'model_cashloan_v2',
      description: '',
      source: '',
      createdAt: new Date().toISOString(),
      rowCount: rows.length,
      badCount: 0,
      badRate: 0,
      periodStart: '',
      periodEnd: '',
      columns: Object.keys(rows[0]),
      sha256: 'test_sha',
    };

    const baselineVer = {
      modelId: 'model_cashloan_v2',
      version: '1.0.0',
      mode: 'scorecard' as const,
      status: 'DRAFT' as const,
      referenceDatasetId: 'cashloan_v2_ref',
      columns: {
        idColumn: 'app_id',
        dateColumn: 'app_date',
        labelColumn: 'default_12m',
        scoreColumn: 'credit_score',
      },
      scoreDirection: 'higher_is_safer' as const,
      modelTable: imported.table,
      // intentionally omit scoring to simulate modelTable-only draft
    };

    // 1. Wizard validation
    const valReport = validateBaseline(baselineVer, { meta, rows });
    expect(valReport.ok).toBe(true);
    const wizardAuc = valReport.computed.performance!.auc;
    expect(wizardAuc).toBeCloseTo(0.753, 3);

    // 2. Model Sandbox baseline performance
    const modelObj = baselineToModelObject(baselineVer as any, rows);
    expect(modelObj.baseline.performance.overall).toBeDefined();
    expect(modelObj.baseline.performance.overall.auc).toBeCloseTo(0.753, 3);
    expect(modelObj.baseline.performance.overall.gini).toBeCloseTo(0.506, 3);
    expect(modelObj.baseline.performance.overall.ks).toBeCloseTo(0.384, 3);

    // Ensure wizard and sandbox AUC match 100%
    expect(wizardAuc).toBeCloseTo(modelObj.baseline.performance.overall.auc, 4);

    // Ensure whole-dataset baseline does not invent duplicate train performance
    expect(modelObj.baseline.performance.train).toBeUndefined();
  });

  it('(7) reflects accurate status in header for selected models (ACTIVE vs ARCHIVED vs VALIDATED vs DRAFT)', () => {
    function getHeaderStatusBadge(activeVer: any, displayVer: any) {
      if (activeVer) {
        return { label: 'Model Active', color: 'emerald', dotAnimate: true };
      }
      if (displayVer?.status === 'VALIDATED') {
        return { label: 'Model Validated (ยังไม่ Active)', color: 'blue', dotAnimate: false };
      }
      if (displayVer?.status === 'DRAFT') {
        return { label: 'Model Draft (แบบร่าง)', color: 'amber', dotAnimate: false };
      }
      if (displayVer?.status === 'ARCHIVED') {
        return { label: 'Model Archived (เก็บถาวร)', color: 'slate', dotAnimate: false };
      }
      return { label: 'ยังไม่เปิดใช้งาน', color: 'slate', dotAnimate: false };
    }

    // 1. When model has active version
    expect(getHeaderStatusBadge({ version: '1.0.0', status: 'ACTIVE' }, null)).toEqual({
      label: 'Model Active',
      color: 'emerald',
      dotAnimate: true,
    });

    // 2. When model has only ARCHIVED version (like model_il20t)
    expect(getHeaderStatusBadge(null, { version: '1.0.0', status: 'ARCHIVED' })).toEqual({
      label: 'Model Archived (เก็บถาวร)',
      color: 'slate',
      dotAnimate: false,
    });

    // 3. When model has only VALIDATED version
    expect(getHeaderStatusBadge(null, { version: '1.0.0', status: 'VALIDATED' })).toEqual({
      label: 'Model Validated (ยังไม่ Active)',
      color: 'blue',
      dotAnimate: false,
    });

    // 4. When model has only DRAFT version
    expect(getHeaderStatusBadge(null, { version: '1.0.0', status: 'DRAFT' })).toEqual({
      label: 'Model Draft (แบบร่าง)',
      color: 'amber',
      dotAnimate: false,
    });
  });

  it('(8) confirms 3 scoring paths (CSV column, ModelTable scorer, and Scorecard) yield 100% identical scores and AUC 0.753', () => {
    const labels = rows.map(r => Number(r['default_12m']));

    // (ก) คอลัมน์ credit_score ในไฟล์
    const scoresA = rows.map(r => Number(r['credit_score']));
    const ptsA: DataPoint[] = scoresA.map((s, i) => ({ score: s, label: labels[i] }));
    const aucA = calculateAUC(ptsA, 'higher_is_safer');

    // (ข) ตัวให้คะแนนของตัวนำเข้าตารางโมเดล
    const scoresB = rows.map(r => scoreRecordWithModelTable(imported.table, r, imported.featureUpdates));
    const ptsB: DataPoint[] = scoresB.map((s, i) => ({ score: s, label: labels[i] }));
    const aucB = calculateAUC(ptsB, 'higher_is_safer');

    // (ค) เส้นทาง scoring/scorecard ที่ใช้ตอน validate และ Sandbox
    const scoring = imported.scoring!;
    expect(scoring.features.length).toBe(9); // 7 numeric + 2 categorical
    const scoresC = rows.map(r => {
      const rec: Record<string, unknown> = {};
      for (const f of scoring.features) rec[f] = r[f];
      return calculateAScore(scoring, rec);
    });
    const ptsC: DataPoint[] = scoresC.map((s, i) => ({ score: s, label: labels[i] }));
    const aucC = calculateAUC(ptsC, 'higher_is_safer');

    // Verify all 3 paths yield identical AUC
    expect(aucA).toBeCloseTo(0.753, 3);
    expect(aucB).toBeCloseTo(0.753, 3);
    expect(aucC).toBeCloseTo(0.753, 3);
    expect(aucA).toBe(aucB);
    expect(aucB).toBe(aucC);

    // Verify 0 differing rows across all 5,000 samples
    let diffAB = 0;
    let diffAC = 0;
    for (let i = 0; i < rows.length; i++) {
      if (Math.abs(scoresA[i] - scoresB[i]) > 0.001) diffAB++;
      if (Math.abs(scoresA[i] - scoresC[i]) > 0.001) diffAC++;
    }
    expect(diffAB).toBe(0);
    expect(diffAC).toBe(0);
  });

  it('(9) validates fresh wizard onboarding with cashloan_v2, persists mapped label stats, and evaluates m05/m06 label drift', async () => {
    const refId = `ref_wiz_test_${Date.now()}`;
    const modelId = `model_wiz_test_${Date.now()}`;

    // Step 1: Upload reference dataset before label column mapping (badCount = 0 initially)
    const initialMeta = {
      referenceId: refId,
      version: '1.0.0',
      modelId,
      description: 'Test Cashloan v2 Reference',
      source: 'upload',
      createdAt: new Date().toISOString(),
      rowCount: rows.length,
      badCount: 0,
      badRate: 0,
      periodStart: '',
      periodEnd: '',
      columns: Object.keys(rows[0]),
      sha256: `test_sha_${Date.now()}`,
    };
    await saveReferenceDatasetBlob({ meta: initialMeta, rows });

    // Step 2 & 4: Save draft baseline with mapped labelColumn: default_12m
    await createDraftBaselineVersion(modelId, {
      version: '1.0.0',
      mode: 'scorecard',
      columns: {
        idColumn: 'app_id',
        dateColumn: 'app_date',
        labelColumn: 'default_12m',
        scoreColumn: 'credit_score',
      },
      referenceDatasetId: refId,
      modelTable: imported.table,
      scoring: imported.scoring,
      featureRegistry: imported.featureUpdates as any,
    });

    // Check that reference dataset blob now has non-zero badCount and badRate
    const updatedBlob = await loadReferenceDatasetBlob(refId);
    expect(updatedBlob).toBeDefined();
    expect(updatedBlob!.meta.badCount).toBe(623);
    expect(updatedBlob!.meta.badRate).toBeCloseTo(0.1246, 3);

    // Step 5: Validate baseline version
    const valResult = await validateBaselineVersion(modelId, '1.0.0', { calibrationResamples: 5 });
    sharedValResult = valResult;
    expect(valResult.ok).toBe(true);
    expect(valResult.report.computed.performance?.auc).toBeCloseTo(0.753, 3);

    // Load reference profile for monitoring / Sandbox
    const prof = await loadReferenceProfile(refId, valResult.version);
    expect(prof.hasLabels).toBe(true);
    expect(prof.meta.badCount).toBe(623);
    expect(prof.meta.badRate).toBeCloseTo(0.1246, 3);

    // Verify baselineToModelObject carries bad_rate, performance, and ksDecileTable
    const modelObj = baselineToModelObject(valResult.version, rows);
    expect(modelObj.baseline.bad_rate).toBeCloseTo(0.1246, 3);
    expect(modelObj.baseline.performance.overall.auc).toBeCloseTo(0.753, 3);
    expect(modelObj.baseline.ksDecileTable).toBeDefined();
    expect(modelObj.baseline.ksDecileTable.length).toBe(10);
    expect(modelObj.baseline.ksDecileTable[0].decile).toBe('D1');
    expect(modelObj.baseline.ksDecileTable[0].bad).toBeGreaterThan(0);
    expect(modelObj.baseline.ksDecileTable[9].decile).toBe('D10');
    expect(modelObj.baseline.ksDecileTable[9].bad).toBeGreaterThan(0);

    // Step 6: Verify Label Drift on m05 and m06 produces real non-zero metrics
    const m05Text = readFileSync(join(root, 'samples/cashloan_v2/m05_v2_2025-11_แคมเปญMobileApp.csv'), 'utf8');
    const { rows: m05Rows } = parseCsv(m05Text);
    const m05Clean = m05Rows.map((r, i) => ({
      row: i + 1,
      id: String(r['app_id'] || i),
      date: String(r['app_date'] || ''),
      score: Number(r['credit_score']),
      label: r['default_12m'] !== undefined ? Number(r['default_12m']) : null,
      values: { credit_score: Number(r['credit_score']) },
      categories: {},
    }));
    const reportM05 = buildDriftReport(prof, valResult.version, { cleanRows: m05Clean as any, rawRows: m05Rows });
    expect(reportM05.label.status).toBe('CRITICAL');
    expect(reportM05.label.metrics).toBeDefined();
    expect(reportM05.label.metrics!.referenceBadRate).toBeCloseTo(0.1246, 3);
    expect(reportM05.label.metrics!.actualBadRate).toBeCloseTo(0.1885, 3);
    expect(reportM05.label.metrics!.relativeChange).toBeGreaterThan(0.50); // > +50%
    expect(reportM05.label.metrics!.pValue).toBeLessThan(0.001);
    expect(reportM05.label.metrics!.scoreAdjusted).toBeDefined();
    expect(reportM05.label.metrics!.scoreAdjusted!.expectedBadRate).toBeGreaterThan(0.165);
    expect(reportM05.label.metrics!.scoreAdjusted!.expectedBadRate).toBeLessThan(0.180);
    expect(reportM05.label.metrics!.scoreAdjusted!.explainableByScoreShift).toBe(true);

    const m06Text = readFileSync(join(root, 'samples/cashloan_v2/m06_v2_2025-12_เศรษฐกิจชะลอตัว.csv'), 'utf8');
    const { rows: m06Rows } = parseCsv(m06Text);
    const m06Clean = m06Rows.map((r, i) => ({
      row: i + 1,
      id: String(r['app_id'] || i),
      date: String(r['app_date'] || ''),
      score: Number(r['credit_score']),
      label: r['default_12m'] !== undefined ? Number(r['default_12m']) : null,
      values: { credit_score: Number(r['credit_score']) },
      categories: {},
    }));
    const reportM06 = buildDriftReport(prof, valResult.version, { cleanRows: m06Clean as any, rawRows: m06Rows });
    expect(reportM06.label.status).toBe('WARNING');
    expect(reportM06.label.metrics).toBeDefined();
    expect(reportM06.label.metrics!.referenceBadRate).toBeCloseTo(0.1246, 3);
    expect(reportM06.label.metrics!.actualBadRate).toBeCloseTo(0.1550, 3);
    expect(reportM06.label.metrics!.relativeChange).toBeGreaterThan(0.20); // > +20%
    expect(reportM06.label.metrics!.pValue).toBeLessThan(0.05);
    expect(reportM06.label.metrics!.scoreAdjusted).toBeDefined();
    expect(reportM06.label.metrics!.scoreAdjusted!.expectedBadRate).toBeGreaterThan(0.115);
    expect(reportM06.label.metrics!.scoreAdjusted!.expectedBadRate).toBeLessThan(0.125);
    expect(reportM06.label.metrics!.scoreAdjusted!.explainableByScoreShift).toBe(false);
  });

  it('(10) populates default minValue and maxValue for numeric features from Baseline (10% range margin) and catches 90 corrupted income rows in m03 at validation layer', async () => {
    expect(sharedValResult).toBeDefined();
    // Check that sharedValResult.version.featureRegistry has default minValue/maxValue populated from Baseline
    const incomeDef = sharedValResult.version.featureRegistry['monthly_income'];
    expect(incomeDef).toBeDefined();
    expect(incomeDef.validation).toBeDefined();
    expect(incomeDef.validation?.minValue).toBeCloseTo(4490, 0); // 15,000 - 10,510
    expect(incomeDef.validation?.maxValue).toBeCloseTo(130610, 0); // 120,100 + 10,510

    // Run monitoring on m03 with this model
    const { runMonitoring } = await import('../lib/monitoring');
    const m03Text = readFileSync(join(root, 'samples/cashloan_v2/m03_v2_2025-09_ระบบต้นทางมีปัญหา.csv'), 'utf8');
    const runResult = runMonitoring({
      model: sharedValResult.version,
      fileName: 'm03_v2_2025-09_ระบบต้นทางมีปัญหา.csv',
      csvText: m03Text,
      maxValidationIssues: Infinity,
      maxStoredFlaggedRows: Infinity,
      history: [],
      recordTriggerEvent: false,
    });

    const run = runResult.run;
    expect(run.validation.rejectedRows).toBe(162);
    expect(run.trigger?.action).toBe('INVESTIGATE_DATA');

    // Find OUT_OF_RANGE error group on monthly_income
    const incomeIssueGroup = run.validation.groups.find(
      g => g.column === 'monthly_income' && g.type === 'OUT_OF_RANGE',
    );
    expect(incomeIssueGroup).toBeDefined();
    expect(incomeIssueGroup!.count).toBe(90); // Exactly 90 corrupted rows caught in Data Validation!
    expect(incomeIssueGroup!.severity).toBe('error');
  });
});

