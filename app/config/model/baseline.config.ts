/**
 * Baseline distribution statistics for each monitored feature.
 *
 * These values were computed from the training dataset
 * (personal_loan_mock_data.xlsx, period 2024-01 to 2024-09, n = 598)
 * and serve as the reference distribution for PSI / CSI drift calculations.
 *
 * These are the ACTUAL statistics of the baseline/training data —
 * NOT alert thresholds. They describe the population the model was trained on.
 *
 * Update these values whenever a new baseline dataset is established
 * (e.g. after model retraining or a scheduled baseline refresh).
 */

import type { BaselineStats } from './types';

export const baseline: BaselineStats[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // Monthly Income (THB)
  // Range: wide right-skewed distribution; most applicants earn 15k-36k THB/mo
  // High max (103,900) reflects genuine high-income applicants in mock data
  // ─────────────────────────────────────────────────────────────────────────
  {
    featureId: 'feat_001',
    mean: 28165,
    std: 13457,
    median: 24900,
    p25: 18600,
    p75: 33700,
    min: 15000,
    max: 103900,
    missingPct: 0.0,
    uniqueCount: 521,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Loan Amount (THB)
  // Range: 20,000–403,000 THB; median ~72k reflects typical personal loan size
  // High std (≈50k) and wide max indicate presence of large-loan applicants
  // ─────────────────────────────────────────────────────────────────────────
  {
    featureId: 'feat_002',
    mean: 84268,
    std: 49997,
    median: 72000,
    p25: 50000,
    p75: 104000,
    min: 20000,
    max: 403000,
    missingPct: 0.0,
    uniqueCount: 388,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // DTI Ratio (existing_monthly_debt / monthly_income)
  // Range: 0.05–2.15; values > 1.0 indicate debt exceeds income (high risk)
  // Mean 0.46 and max 2.15 are plausible for a personal-loan portfolio
  // where some applicants carry heavy existing obligations
  // ─────────────────────────────────────────────────────────────────────────
  {
    featureId: 'feat_003',
    mean: 0.46,
    std: 0.23,
    median: 0.43,
    p25: 0.30,
    p75: 0.57,
    min: 0.05,
    max: 2.15,
    missingPct: 0.008,
    uniqueCount: 142,
  },
];

/** Convenience: look up baseline stats for a given featureId. */
export function getBaselineByFeatureId(
  featureId: string
): BaselineStats | undefined {
  return baseline.find((b) => b.featureId === featureId);
}
