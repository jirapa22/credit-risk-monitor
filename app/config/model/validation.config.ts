/**
 * Input validation rules per feature.
 *
 * ⚠️  These rules are PREPARED but NOT YET ENFORCED at runtime.
 *     When validation is implemented, the intake/upload route should
 *     iterate over this array and apply each rule to incoming rows.
 *
 * CSV schema for monitoring uploads (accepted columns):
 *   monthly_income  — gross monthly income (THB)
 *   loan_amount     — requested loan amount (THB)
 *   dti_ratio       — existing_monthly_debt / monthly_income
 *   default_flag    — outcome variable: 1 = Default/Bad, 0 = Non-default/Good
 *
 * Excluded columns (data leakage — reject uploads containing these):
 *   credit_score, risk_grade, interest_rate_pct, current_dpd, outstanding_balance
 *
 * Missing value strategies:
 *   'mean'   — replace missing with baseline mean
 *   'median' — replace missing with baseline median
 *   'zero'   — replace missing with 0
 *   'reject' — reject the entire row if the value is missing
 */

import type { ValidationRule } from './types';

export const validationRules: ValidationRule[] = [
  {
    featureId: 'feat_001',         // monthly_income
    minValue: 0,
    maxValue: 10_000_000,          // Upper cap to flag data-entry errors
    allowNull: false,
    defaultValue: null,
    missingValueStrategy: 'median',
  },
  {
    featureId: 'feat_002',         // loan_amount
    minValue: 1000,                // Minimum meaningful loan amount
    maxValue: 10_000_000,
    allowNull: false,
    defaultValue: null,
    missingValueStrategy: 'median',
  },
  {
    featureId: 'feat_003',         // dti_ratio
    minValue: 0,
    maxValue: 10,                  // DTI > 10 is almost certainly a data error
    allowNull: true,               // Derivable if raw debt/income columns present
    defaultValue: null,
    missingValueStrategy: 'median',
  },
];

/** Convenience: look up validation rules for a given featureId. */
export function getValidationByFeatureId(
  featureId: string
): ValidationRule | undefined {
  return validationRules.find((r) => r.featureId === featureId);
}
