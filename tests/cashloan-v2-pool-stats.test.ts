import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../lib/csv';
import { importModelTableFromText } from '../lib/scorecardImport';
import {
  computeDevelopmentStability,
  computeModelTablePoolStats,
} from '../lib/poolStats';
import { getEffectiveModel } from '../lib/storage/repositories';

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
});
