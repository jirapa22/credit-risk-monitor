/**
 * Input validation rules per feature.
 *
 * ⚠️  These rules are PREPARED but NOT YET ENFORCED at runtime.
 *     When validation is implemented, the intake/upload route should
 *     iterate over this array and apply each rule to incoming rows.
 *
 * Strategy guide:
 *   'mean'   — replace missing value with the baseline mean
 *   'median' — replace missing value with the baseline median
 *   'zero'   — replace missing value with 0
 *   'reject' — reject the entire row if the value is missing
 */

import type { ValidationRule } from './types';

export const validationRules: ValidationRule[] = [
  {
    featureId: 'feat_income',
    minValue: 0,
    maxValue: 10_000_000,   // Upper cap to flag data-entry errors
    allowNull: false,
    defaultValue: null,
    missingValueStrategy: 'median',
  },
  {
    featureId: 'feat_emp_duration',
    minValue: 0,
    maxValue: 600,          // 50 years — safeguard against typos
    allowNull: true,        // Some applicants are self-employed / unemployed
    defaultValue: 0,
    missingValueStrategy: 'zero',
  },
  {
    featureId: 'feat_age',
    minValue: 18,           // Legal minimum for loan application
    maxValue: 80,
    allowNull: false,
    defaultValue: null,
    missingValueStrategy: 'reject',
  },
];

/**
 * Convenience: look up validation rules for a given featureId.
 */
export function getValidationByFeatureId(
  featureId: string
): ValidationRule | undefined {
  return validationRules.find((r) => r.featureId === featureId);
}
