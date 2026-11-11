/**
 * Pure, client-safe constants for the Sandbox injector (no server/data imports),
 * so UI components can show severity values without bundling the pipeline.
 * Re-exported by lib/injection.ts.
 */
import type { AnomalySeverity, AnomalyType, DriftSectionName, ExpectedLayer, TriggerAction } from './types';

export type InjectionKind = 'data_error' | 'drift' | 'clean';
export type Sev = Exclude<AnomalySeverity, 'none'>;

// ─── Severity constants (thesis table) ──────────────────────────────────────
export const SEVERITY_TABLE = {
  unit_error:        { low: 10, medium: 100, high: 1000 },                 // value × factor
  extreme_outlier:   { low: 1.5, medium: 3, high: 10 },                    // value = Reference p99 × factor
  negative_value:    { low: -0.01, medium: -1, high: -10 },                // value × factor (always < 0)
  type_error:        { low: '<value> บาท', medium: 'N/A', high: '#VALUE!' }, // replaced by text
  missing_injection: { low: '', medium: '', high: '' },                    // blank cell
  swapped_columns:   { low: 'swap', medium: 'swap', high: 'swap' },        // feature pair swapped in the same row
  duplicate_rows:    { low: 'copy', medium: 'copy', high: 'copy' },        // exact copy (same row id) appended
  multivariate_inconsistent: {                                             // Reference quantiles: income ≤ p, loan ≥ p, dti ≤ p
    low:    { income: 0.10, loan: 0.95, dti: 0.05 },
    medium: { income: 0.07, loan: 0.97, dti: 0.03 },
    high:   { income: 0.05, loan: 0.99, dti: 0.02 },
  },
  schema_break:      { low: 'rename_case', medium: 'rename_typo', high: 'drop_column' }, // file-level
  mean_shift:        { low: -0.10, medium: -0.20, high: -0.40 },           // value × (1 + δ)
  variance_change:   { low: 1.25, medium: 1.5, high: 2 },                  // spread around Reference median × factor (log scale for log1p features)
  category_shift:    { low: 0.10, medium: 0.20, high: 0.40 },              // percentage-point share shifted from one category to another
  unseen_category:   { low: 'typo_low', medium: 'typo_med', high: 'typo_high' }, // unseen category injected (e.g. typo)
  // Step 11a: new drift scenarios
  label_shift:       { low: 1.25, medium: 1.5, high: 2.0 },                 // bad rate × factor
  concept_shift:     { low: 0.25, medium: 0.50, high: 1.0 },               // proportion of rows whose labels are shuffled
  mix_shift:         { low: 0.10, medium: 0.20, high: 0.40 },              // percentage-point share increase in lower quartile (<= p25)
  missing_drift:     { low: 0.05, medium: 0.10, high: 0.20 },              // percentage-point increase in missing values of imputable features
} as const;

const BASE_ANOMALY_KIND: Record<string, InjectionKind> = {
  none: 'clean',
  unit_error: 'data_error', extreme_outlier: 'data_error', negative_value: 'data_error', type_error: 'data_error',
  missing_injection: 'data_error', swapped_columns: 'data_error', duplicate_rows: 'data_error',
  multivariate_inconsistent: 'data_error', schema_break: 'data_error',
  mean_shift: 'drift', variance_change: 'drift',
  label_shift: 'drift', concept_shift: 'drift', mix_shift: 'drift', missing_drift: 'drift',
};
Object.defineProperties(BASE_ANOMALY_KIND, {
  unseen_category: { value: 'data_error', enumerable: false, configurable: true, writable: true },
  category_shift: { value: 'drift', enumerable: false, configurable: true, writable: true },
});
export const ANOMALY_KIND = BASE_ANOMALY_KIND as Record<AnomalyType, InjectionKind>;

/** Hypothesis: which layer should catch each type (may depend on severity). */
const BASE_EXPECTED_LAYER: Record<string, ExpectedLayer | Record<Sev, ExpectedLayer>> = {
  none: 'none',
  type_error: 'validation', missing_injection: 'validation', negative_value: 'validation', schema_break: 'validation',
  duplicate_rows: 'validation',            // DUPLICATE_ID (warning)
  // Depends on monthly_income.validation.maxValue in model-config.json (500,000):
  // ×10 stays in range → anomaly layer; ×100 / ×1000 exceed maxValue → OUT_OF_RANGE in validation.
  unit_error: { low: 'anomaly', medium: 'validation', high: 'validation' },
  extreme_outlier: 'anomaly', swapped_columns: 'anomaly', multivariate_inconsistent: 'anomaly',
  mean_shift: 'drift', variance_change: 'drift',
  label_shift: 'drift', concept_shift: 'drift', mix_shift: 'drift', missing_drift: 'drift',
};
Object.defineProperties(BASE_EXPECTED_LAYER, {
  unseen_category: { value: 'anomaly', enumerable: false, configurable: true, writable: true },
  category_shift: { value: 'drift', enumerable: false, configurable: true, writable: true },
});
export const EXPECTED_LAYER = BASE_EXPECTED_LAYER as Record<AnomalyType, ExpectedLayer | Record<Sev, ExpectedLayer>>;

export const EXPECTED_SECTION: Partial<Record<AnomalyType, DriftSectionName>> = {
  mean_shift: 'covariate',
  variance_change: 'covariate',
  category_shift: 'covariate',
  mix_shift: 'covariate',
  label_shift: 'label',
  concept_shift: 'concept',
  missing_drift: 'missing',
};

export const EXPECTED_ACTION: Record<AnomalyType, TriggerAction | TriggerAction[]> = {
  none: ['CONTINUE', 'MONITOR_CLOSELY'],
  unit_error: ['INVESTIGATE_DATA', 'BLOCKED_INVALID_DATA'],
  extreme_outlier: ['INVESTIGATE_DATA', 'BLOCKED_INVALID_DATA'],
  negative_value: ['INVESTIGATE_DATA', 'BLOCKED_INVALID_DATA'],
  type_error: ['INVESTIGATE_DATA', 'BLOCKED_INVALID_DATA'],
  missing_injection: ['INVESTIGATE_DATA', 'BLOCKED_INVALID_DATA'],
  swapped_columns: ['INVESTIGATE_DATA', 'BLOCKED_INVALID_DATA'],
  duplicate_rows: ['INVESTIGATE_DATA', 'BLOCKED_INVALID_DATA'],
  multivariate_inconsistent: ['INVESTIGATE_DATA', 'BLOCKED_INVALID_DATA'],
  schema_break: ['BLOCKED_INVALID_DATA', 'INVESTIGATE_DATA'],
  unseen_category: ['INVESTIGATE_DATA', 'BLOCKED_INVALID_DATA'],
  mean_shift: 'INVESTIGATE_DRIFT',
  variance_change: 'INVESTIGATE_DRIFT',
  category_shift: 'INVESTIGATE_DRIFT',
  mix_shift: 'INVESTIGATE_DRIFT',
  label_shift: 'RECALIBRATE',
  concept_shift: 'CONSIDER_RETRAIN',
  missing_drift: 'INVESTIGATE_DATA',
};

export function expectedFor(
  type: AnomalyType,
  severity?: AnomalySeverity,
): {
  layer: ExpectedLayer;
  section?: DriftSectionName;
  shouldAlarm: boolean;
  expectedAction?: TriggerAction | TriggerAction[];
} {
  const e = EXPECTED_LAYER[type] ?? 'none';
  const layer = typeof e === 'string' ? e : e[(severity && severity !== 'none' ? severity : 'medium') as Sev];
  if (type === 'none') {
    return { layer: 'none', shouldAlarm: false };
  }
  const section = EXPECTED_SECTION[type];
  const expectedAction = EXPECTED_ACTION[type] ?? ['CONTINUE', 'MONITOR_CLOSELY'];
  return { layer, section, shouldAlarm: true, expectedAction };
}
