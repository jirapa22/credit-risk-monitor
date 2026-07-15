/**
 * Scorecard calibration parameters and model performance metrics.
 *
 * Scorecard formula (standard additive):
 *   Score  = offset + Σ bin_points_i  (one bin per feature)
 *   odds   = baseOdds × 2^((Score − baseScore) / PDO)
 *   PD     = 1 / (1 + odds)
 *
 * Parameter derivations:
 *   factor = PDO / ln(2)           = 20 / 0.6931 ≈ 28.854
 *   offset = baseScore − factor × ln(baseOdds)
 *          = 600 − 28.854 × ln(50) = 600 − 112.877 ≈ 487.123
 *
 * Interpretation of baseScore/baseOdds:
 *   At Score = 600, the expected good-to-bad odds = 50 : 1
 *   i.e. 1 bad account per 50 good accounts → PD ≈ 1.96 %
 *
 * The training population average score ≈ 554 (bad rate ≈ 9.4 %)
 *
 * Performance data source: personal_loan_mock_data.xlsx model report
 *   Train period: 2024-01 to 2024-09 (n = 598)
 *   Test  period: 2024-10 to 2024-12 (n = 257)
 *
 * ⚠️  Overfitting alert:
 *   Gini drops from 0.436 (Train) → 0.195 (Test) — a 55 % collapse.
 *   Investigate whether the test window has distribution shift or the model
 *   is over-fitted to the training period before using Test AUC as the
 *   production performance benchmark.
 */

import type { ScorecardParams, ModelPerformance } from './types';

// ---------------------------------------------------------------------------
// Scorecard calibration parameters
// ---------------------------------------------------------------------------

export const scorecardParams: ScorecardParams = {
  baseScore: 600,
  baseOdds: 50,
  pdo: 20,
  /** offset = baseScore − factor × ln(baseOdds) = 600 − 28.854 × 3.912 ≈ 487.123 */
  offset: 487.123,
  /** factor = PDO / ln(2) = 20 / 0.6931 ≈ 28.854 */
  factor: 28.854,
  intercept: -2.0,
};

// ---------------------------------------------------------------------------
// Model performance (Train vs Test)
// ---------------------------------------------------------------------------

export const modelPerformance: ModelPerformance = {
  train: {
    auc: 0.718,
    gini: 0.436,
    ks: 0.349,
    sampleSize: 598,
    badRate: 0.094,
    period: '2024-01 to 2024-09',
  },
  test: {
    auc: 0.597,
    gini: 0.195,
    ks: 0.238,
    sampleSize: 257,
    badRate: 0.094,
    period: '2024-10 to 2024-12',
  },
};
