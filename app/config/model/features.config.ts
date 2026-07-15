/**
 * Feature configuration for the Ascore Personal Loan model.
 *
 * Each entry is a fully-described feature: its column name in the dataset,
 * display metadata, monitoring settings, and the regression coefficient
 * (weight) used in the scoring equation inside the risk-score API route.
 *
 * Adding a new feature in the future only requires adding one object here —
 * no other file needs to change for the weight to be picked up.
 */

import type { FeatureConfig } from './types';

export const features: FeatureConfig[] = [
  {
    featureId: 'feat_income',
    displayName: 'Monthly Income',
    columnName: 'income',
    description:
      'Applicant gross monthly income in THB. Primary affordability signal.',
    dataType: 'Numeric',
    required: true,
    monitoringEnabled: true,
    csiThreshold: 0.1,
    displayOrder: 1,
    editable: true,
    // Logistic-regression coefficient (negative = higher income → lower risk)
    weight: -0.000002,
  },
  {
    featureId: 'feat_emp_duration',
    displayName: 'Employment Duration (months)',
    columnName: 'emp_duration',
    description:
      'Number of months the applicant has been continuously employed at current employer.',
    dataType: 'Numeric',
    required: true,
    monitoringEnabled: true,
    csiThreshold: 0.1,
    displayOrder: 2,
    editable: true,
    weight: -0.02,
  },
  {
    featureId: 'feat_age',
    displayName: 'Age',
    columnName: 'age',
    description: 'Applicant age in years at the time of application.',
    dataType: 'Numeric',
    required: true,
    monitoringEnabled: true,
    csiThreshold: 0.1,
    displayOrder: 3,
    editable: true,
    weight: -0.005,
  },
];

/**
 * Convenience: look up a single feature by its column name.
 * Used by the risk-score route to resolve weights without looping externally.
 */
export function getFeatureByColumn(
  columnName: string
): FeatureConfig | undefined {
  return features.find((f) => f.columnName === columnName);
}

/**
 * Returns all features that have monitoring enabled, sorted by displayOrder.
 */
export function getMonitoredFeatures(): FeatureConfig[] {
  return features
    .filter((f) => f.monitoringEnabled)
    .sort((a, b) => a.displayOrder - b.displayOrder);
}
