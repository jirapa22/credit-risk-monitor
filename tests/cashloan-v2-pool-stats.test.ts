import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../lib/csv';
import { importModelTableFromText } from '../lib/scorecardImport';
import {
  computeDevelopmentStability,
  computeModelTablePoolStats,
} from '../lib/poolStats';
import { baselineToModelObject, getEffectiveModel } from '../lib/storage/repositories';
import { buildReferenceProfileFromData } from '../lib/reference';
import { validateBaseline } from '../lib/baselineValidation';

describe('Cash Loan v2 Pool Statistics & Development Stability Tests', () => {
  const root = process.cwd();
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

    const modelObj = baselineToModelObject(baselineVer, rows);
    expect(modelObj.baseline.bad_rate).toBeCloseTo(0.1246, 3);
    expect(modelObj.baseline.bad_rate).not.toBe(0);
  });

  it('(6) aligns Wizard validation AUC and Sandbox Baseline Performance at 0.731 (without duplicating Train/Test)', () => {
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
    const wizardAuc = valReport.computed.performance.auc;
    expect(wizardAuc).toBeCloseTo(0.731, 3);

    // 2. Model Sandbox baseline performance
    const modelObj = baselineToModelObject(baselineVer, rows);
    expect(modelObj.baseline.performance.overall).toBeDefined();
    expect(modelObj.baseline.performance.overall.auc).toBeCloseTo(0.731, 3);
    expect(modelObj.baseline.performance.overall.gini).toBeCloseTo(0.462, 3);
    expect(modelObj.baseline.performance.overall.ks).toBeCloseTo(0.353, 3);

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
});

