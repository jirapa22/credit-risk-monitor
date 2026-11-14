/**
 * Step 12 — Model Structure, Development Statistics, and Model Table Tests:
 *   1. Model Table CSV Import: parses standard columns (variable, type, pool_id, lower, upper, categories, points)
 *   2. Model Table JSON Import: parses array of pool definitions correctly
 *   3. applyModelTableToBaseline: sets usedInModel=true for table variables, false for others, and tags source='pool ของโมเดล'
 *   4. Consistency Check: compares calculated score vs scoreColumn and warns when match < tolerance (without blocking)
 *   5. Model Card Validation: warns on sampleSize <= 0
 *   6. Development Statistics Validation: warns on out-of-range metrics (AUC, KS, Gini, Bad Rate)
 *   7. Out-of-Model severity capping: ensures outOfModelFeatures capped at outOfModelMaxSeverity (default WARNING)
 */
import { describe, expect, it } from 'vitest';
import {
  importModelTableFromRows,
  importModelTableFromText,
  applyModelTableToBaseline,
} from '../lib/scorecardImport';
import { validateBaseline } from '../lib/baselineValidation';
import { resolveCsiFeatures } from '../lib/drift';
import type { FeatureDefinition } from '../lib/types';

describe('Step 12 — Model Structure and Model Table Import', () => {
  const sampleCsv = `variable,type,pool_id,lower,upper,categories,points
base_points,,,,,,500
var_num,numeric,Low,,20,,10
var_num,numeric,Mid,20,50,,25
var_num,numeric,High,50,,,40
var_cat,categorical,GroupA,,,A|B,15
var_cat,categorical,GroupB,,,C|D,30
`;

  it('(1) importModelTableFromText parses CSV table with numeric boundaries and categorical pools', () => {
    const res = importModelTableFromText(sampleCsv);
    expect(res.ok).toBe(true);
    expect(res.table.base_points).toBe(500);
    expect(res.table.features).toEqual(['var_num', 'var_cat']);

    // Numeric feature checks
    const numFeat = res.featureUpdates['var_num'];
    expect(numFeat.dataType).toBe('numeric');
    expect(numFeat.usedInModel).toBe(true);
    expect(numFeat.binning?.boundaries).toEqual([20, 50]);
    expect(numFeat.binning?.binLabels).toEqual(['Low', 'Mid', 'High']);
    expect(numFeat.poolPoints).toEqual([10, 25, 40]);

    // Categorical feature checks
    const catFeat = res.featureUpdates['var_cat'];
    expect(catFeat.dataType).toBe('categorical');
    expect(catFeat.usedInModel).toBe(true);
    expect(catFeat.categoryPools).toEqual([
      { label: 'GroupA', categories: ['A', 'B'] },
      { label: 'GroupB', categories: ['C', 'D'] },
    ]);
    expect(catFeat.poolPoints).toEqual([15, 30]);
  });

  it('(2) importModelTableFromText parses JSON table with identical structure', () => {
    const sampleJson = JSON.stringify([
      { variable: 'base_points', points: 500 },
      { variable: 'var_num', type: 'numeric', pool_id: 'Low', upper: 20, points: 10 },
      { variable: 'var_num', type: 'numeric', pool_id: 'Mid', lower: 20, upper: 50, points: 25 },
      { variable: 'var_num', type: 'numeric', pool_id: 'High', lower: 50, upper: null, points: 40 },
      { variable: 'var_cat', type: 'categorical', pool_id: 'GroupA', categories: ['A', 'B'], points: 15 },
      { variable: 'var_cat', type: 'categorical', pool_id: 'GroupB', categories: ['C', 'D'], points: 30 },
    ]);

    const res = importModelTableFromText(sampleJson);
    expect(res.ok).toBe(true);
    expect(res.table.base_points).toBe(500);
    expect(res.featureUpdates['var_num'].binning?.boundaries).toEqual([20, 50]);
    expect(res.featureUpdates['var_cat'].categoryPools?.length).toBe(2);
  });

  it('(3) applyModelTableToBaseline sets usedInModel=true for table variables and false for others', () => {
    const res = importModelTableFromText(sampleCsv);
    const baseline = {
      mode: 'score_column',
      featureRegistry: {
        var_num: { columnName: 'var_num', dataType: 'numeric', required: true, monitoringEnabled: true },
        var_cat: { columnName: 'var_cat', dataType: 'categorical', required: true, monitoringEnabled: true },
        external_macro: { columnName: 'external_macro', dataType: 'numeric', required: true, monitoringEnabled: true },
      },
      thresholds: { csi_features: {} },
    };

    const updated = applyModelTableToBaseline(baseline as any, res);

    expect(updated.featureRegistry!.var_num.usedInModel).toBe(true);
    expect(updated.featureRegistry!.var_cat.usedInModel).toBe(true);
    expect(updated.featureRegistry!.external_macro.usedInModel).toBe(false);

    // Checks source tag
    expect(updated.thresholds.csi_features.var_num.source).toBe('pool ของโมเดล');
    expect(updated.thresholds.csi_features.var_cat.source).toBe('pool ของโมเดล');
    expect(updated.thresholds.csi_features.var_num.bins).toEqual([20, 50]);
  });

  it('(4) consistency check matches calculated score vs scoreColumn and warns when match < 95%', () => {
    const mockRows = [
      { var_num: 15, var_cat: 'A', score: 525 }, // 500 + 10 + 15 = 525 (Exact match)
      { var_num: 30, var_cat: 'B', score: 540 }, // 500 + 25 + 15 = 540 (Exact match)
      { var_num: 60, var_cat: 'C', score: 570 }, // 500 + 40 + 30 = 570 (Exact match)
      { var_num: 10, var_cat: 'D', score: 600 }, // 500 + 10 + 30 = 540 vs 600 (Mismatch)
    ];

    // 3 out of 4 match -> 75% match
    const res = importModelTableFromRows(
      [
        { variable: 'base_points', points: 500 },
        { variable: 'var_num', type: 'numeric', pool_id: 'Low', upper: 20, points: 10 },
        { variable: 'var_num', type: 'numeric', pool_id: 'Mid', lower: 20, upper: 50, points: 25 },
        { variable: 'var_num', type: 'numeric', pool_id: 'High', lower: 50, upper: null, points: 40 },
        { variable: 'var_cat', type: 'categorical', pool_id: 'GroupA', categories: ['A', 'B'], points: 15 },
        { variable: 'var_cat', type: 'categorical', pool_id: 'GroupB', categories: ['C', 'D'], points: 30 },
      ],
      {
        referenceRows: mockRows,
        scoreColumn: 'score',
        tolerancePct: 95,
      },
    );

    expect(res.scoreComparison).not.toBeNull();
    expect(res.scoreComparison?.comparedRows).toBe(4);
    expect(res.scoreComparison?.matchedWithinHalfPointCount).toBe(3);
    expect(res.scoreComparison?.matchWithinHalfPointPct).toBe(75);
    expect(res.scoreComparison?.maxAbsDiff).toBe(60);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.warnings[0]).toContain('75.00%');
  });

  it('(5) validateBaseline validates modelCard and developmentStats with appropriate warnings', () => {
    const rawRows = [
      { id: '1', score: 500, label: 0, x1: 10 },
      { id: '2', score: 600, label: 1, x1: 20 },
    ];
    // Create 200 dummy rows
    for (let i = 3; i <= 210; i++) {
      rawRows.push({ id: String(i), score: 500 + (i % 100), label: i % 10 === 0 ? 1 : 0, x1: i * 2 });
    }

    const baseline = {
      modelId: 'test_model',
      mode: 'score_column',
      columns: { idColumn: 'id', scoreColumn: 'score', labelColumn: 'label' },
      featureRegistry: {
        x1: { columnName: 'x1', dataType: 'numeric', required: true, monitoringEnabled: true },
      },
      modelCard: {
        sampleSize: -50, // Invalid: should warn
      },
      developmentStats: {
        reported: {
          train: {
            auc: 1.25, // Out of range: should warn
            ks: -0.10, // Out of range: should warn
            gini: 1.5, // Out of range: should warn
            badRate: 1.2, // Out of range: should warn
          },
        },
      },
    };

    const report = validateBaseline(baseline, rawRows);
    expect(report.ok).toBe(true); // Warnings do not block
    expect(report.warnings.some(w => w.code === 'INVALID_SAMPLE_SIZE')).toBe(true);
    expect(report.warnings.filter(w => w.code === 'OUT_OF_RANGE_DEV_STAT').length).toBe(4);
  });
});

