/**
 * Baseline distribution statistics for each monitored feature.
 *
 * These values were computed from the training/baseline dataset
 * (`personal_loan_mock_data.xlsx`) and serve as the reference distribution
 * for PSI / CSI drift calculations.
 *
 * Update these values whenever a new baseline dataset is established
 * (e.g., after model retraining or a scheduled baseline refresh).
 */

import type { BaselineStats } from './types';

export const baseline: BaselineStats[] = [
  {
    featureId: 'feat_income',
    mean: 35000,
    std: 12500,
    median: 32000,
    p25: 25000,
    p75: 43000,
    min: 8000,
    max: 120000,
    missingPct: 0.003,   // 0.3 % of baseline rows had missing income
    uniqueCount: 3820,
  },
  {
    featureId: 'feat_emp_duration',
    mean: 42,
    std: 28,
    median: 36,
    p25: 18,
    p75: 60,
    min: 0,
    max: 240,
    missingPct: 0.015,   // 1.5 % of baseline rows had missing employment duration
    uniqueCount: 162,
  },
  {
    featureId: 'feat_age',
    mean: 34.2,
    std: 8.6,
    median: 33,
    p25: 27,
    p75: 40,
    min: 20,
    max: 65,
    missingPct: 0.0,
    uniqueCount: 46,
  },
];

/**
 * Convenience: look up baseline stats for a given featureId.
 */
export function getBaselineByFeatureId(
  featureId: string
): BaselineStats | undefined {
  return baseline.find((b) => b.featureId === featureId);
}
