import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../lib/csv';
import {
  applyModelTableToBaseline,
  importModelTableFromText,
} from '../lib/scorecardImport';
import { validateBaseline } from '../lib/baselineValidation';

describe('Cash Loan v2 Real Data Import & Consistency Tests', () => {
  const modelTablePath = join(process.cwd(), 'samples/model_table_cashloan.csv');
  const baselineCsvPath = join(process.cwd(), 'samples/baseline_cashloan_v2_2024.csv');

  const modelTableText = readFileSync(modelTablePath, 'utf8');
  const baselineCsvText = readFileSync(baselineCsvPath, 'utf8');
  const { rows: baselineRows } = parseCsv(baselineCsvText);

  it('(1) imports model_table_cashloan.csv with 9 variables, base_points 453, and 100% score match on 5,000 baseline rows', () => {
    const res = importModelTableFromText(modelTableText, {
      referenceRows: baselineRows,
      scoreColumn: 'credit_score',
    });

    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.table.base_points).toBe(453);
    expect(res.table.features.length).toBe(9);
    expect(res.table.features).toEqual([
      'age',
      'employment_years',
      'monthly_income',
      'dti',
      'ncb_inquiries_6m',
      'ncb_max_dpd_12m',
      'credit_util_pct',
      'occupation',
      'residence_type',
    ]);

    // Total pools (rows including base_points)
    expect(res.table.rows.length).toBe(32);

    // Consistency check vs Reference credit_score: exactly 100% match, maxAbsDiff = 0
    expect(res.scoreComparison).not.toBeNull();
    expect(res.scoreComparison!.comparedRows).toBe(5000);
    expect(res.scoreComparison!.matchedWithinHalfPointCount).toBe(5000);
    expect(res.scoreComparison!.matchWithinHalfPointPct).toBe(100);
    expect(res.scoreComparison!.maxAbsDiff).toBe(0);

    // ScoringConfig is generated for numeric scorecard features
    expect(res.scoring).toBeDefined();
    expect(res.scoring!.base_points).toBe(453);
    expect(res.scoring!.features).toContain('age');
    expect(res.scoring!.features).toContain('monthly_income');
  });

  it('(2) applyModelTableToBaseline correctly sets in-model flags and pool CSI bins', () => {
    const importRes = importModelTableFromText(modelTableText, {
      referenceRows: baselineRows,
      scoreColumn: 'credit_score',
    });

    const initialBaseline: any = {
      modelId: 'cashloan_v2',
      version: '1.0.0',
      mode: 'scorecard',
      referenceDatasetId: 'ref_cashloan_v2',
      columns: {
        idColumn: 'app_id',
        dateColumn: 'app_date',
        labelColumn: 'default_12m',
        scoreColumn: 'credit_score',
      },
      scoreDirection: 'higher_is_safer',
      featureRegistry: {
        age: { columnName: 'age', displayName: 'อายุ', dataType: 'numeric', required: true, monitoringEnabled: true },
        employment_years: { columnName: 'employment_years', displayName: 'อายุงาน', dataType: 'numeric', required: true, monitoringEnabled: true },
        monthly_income: { columnName: 'monthly_income', displayName: 'รายได้ต่อเดือน', dataType: 'numeric', required: true, monitoringEnabled: true },
        dti: { columnName: 'dti', displayName: 'DTI', dataType: 'numeric', required: true, monitoringEnabled: true },
        ncb_inquiries_6m: { columnName: 'ncb_inquiries_6m', displayName: 'NCB Inquiries', dataType: 'numeric', required: true, monitoringEnabled: true },
        ncb_max_dpd_12m: { columnName: 'ncb_max_dpd_12m', displayName: 'Max DPD', dataType: 'numeric', required: true, monitoringEnabled: true },
        credit_util_pct: { columnName: 'credit_util_pct', displayName: 'Credit Util', dataType: 'numeric', required: true, monitoringEnabled: true },
        occupation: { columnName: 'occupation', displayName: 'อาชีพ', dataType: 'categorical', required: true, monitoringEnabled: true },
        residence_type: { columnName: 'residence_type', displayName: 'ที่อยู่อาศัย', dataType: 'categorical', required: true, monitoringEnabled: true },
        branch_region: { columnName: 'branch_region', displayName: 'ภาค', dataType: 'categorical', required: false, monitoringEnabled: true },
        channel: { columnName: 'channel', displayName: 'ช่องทาง', dataType: 'categorical', required: false, monitoringEnabled: true },
        loan_amount: { columnName: 'loan_amount', displayName: 'วงเงินขอสินเชื่อ', dataType: 'numeric', required: true, monitoringEnabled: true },
        term_months: { columnName: 'term_months', displayName: 'ระยะเวลากู้', dataType: 'numeric', required: true, monitoringEnabled: true },
        existing_debt_payment: { columnName: 'existing_debt_payment', displayName: 'ภาระหนี้เดิม', dataType: 'numeric', required: false, monitoringEnabled: true },
      },
      thresholds: {
        psi_warning: 0.1,
        psi_critical: 0.25,
        csi_features: {},
      },
      driftConfig: { thresholdMode: 'fixed' },
    };

    const updated = applyModelTableToBaseline(initialBaseline, importRes);

    // In-model variables (9 features)
    expect(updated.featureRegistry.age.usedInModel).toBe(true);
    expect(updated.featureRegistry.monthly_income.usedInModel).toBe(true);
    expect(updated.featureRegistry.occupation.usedInModel).toBe(true);

    // Out-of-model variables
    expect(updated.featureRegistry.branch_region.usedInModel).toBe(false);
    expect(updated.featureRegistry.channel.usedInModel).toBe(false);
    expect(updated.featureRegistry.loan_amount.usedInModel).toBe(false);

    // CSI bins labeled "pool ของโมเดล"
    expect(updated.thresholds.csi_features.age.source).toBe('pool ของโมเดล');
    expect(updated.thresholds.csi_features.age.bins).toEqual([28, 35, 45]);
    expect(updated.thresholds.csi_features.monthly_income.bins).toEqual([18000, 25000, 35000]);

    // Categorical pools
    expect(updated.featureRegistry.occupation.categoryPools?.length).toBe(4);
    expect(updated.featureRegistry.occupation.poolPoints).toEqual([39, 14, 7, 0]);

    // Validation passes consistency check
    const valRes = validateBaseline(updated, baselineRows);
    expect(valRes.ok).toBe(true);
    expect(valRes.errors).toEqual([]);
  });

  it('(3) error reporting surfaces actual cause, row, and column when model table is malformed', () => {
    const malformedCsv = `variable,type,pool_id,lower,upper,categories,points
base_points,,,,,,NOT_A_NUM
bad_var,numeric,Pool_1,,abc,,10
`;
    const res = importModelTableFromText(malformedCsv);
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors.some(e => e.includes('base_points') && e.includes('NOT_A_NUM'))).toBe(true);
    expect(res.errors.some(e => e.includes('bad_var') && e.includes('upper') && e.includes('abc'))).toBe(true);
  });

  it('(4) auto-detects model-table format vs legacy scorecard in POST /api/registry/scorecard/import route', async () => {
    const { POST } = await import('../app/api/registry/scorecard/import/route');

    // 1. Send model_table_cashloan.csv to scorecard/import
    const reqModelTable = new Request('http://localhost:3000/api/registry/scorecard/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        csvText: modelTableText,
        fileName: 'model_table_cashloan.csv',
        referenceRows: baselineRows,
        scoreColumn: 'credit_score',
      }),
    });
    const resMt = await POST(reqModelTable);
    expect(resMt.status).toBe(200);
    const dataMt = await resMt.json();
    expect(dataMt.ok).toBe(true);
    expect(dataMt.format).toBe('model_table');
    expect(dataMt.table.features.length).toBe(9);
    expect(dataMt.scoreComparison.matchWithinHalfPointPct).toBe(100);

    // 2. Send legacy scorecard format (with upper_bound & bin_label)
    const legacyCsv = `variable,upper_bound,points,bin_label
base_points,,500,
score_feature,20,10,Low
score_feature,50,25,Mid
score_feature,,40,High
`;
    const reqLegacy = new Request('http://localhost:3000/api/registry/scorecard/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        csvText: legacyCsv,
        fileName: 'scorecard.csv',
      }),
    });
    const resLeg = await POST(reqLegacy);
    expect(resLeg.status).toBe(200);
    const dataLeg = await resLeg.json();
    expect(dataLeg.ok).toBe(true);
    expect(dataLeg.format).toBe('scorecard');
    expect(dataLeg.scoring.features).toEqual(['score_feature']);
  });
});
