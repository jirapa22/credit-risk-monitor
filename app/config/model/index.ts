/**
 * Barrel export — single import point for all model configuration modules.
 *
 * Usage in any other file:
 *   import { modelInfo, features, thresholds, baseline, validationRules } from '@/app/config/model';
 *   import type { ModelConfiguration, FeatureConfig } from '@/app/config/model';
 *
 * This keeps consumer imports clean and allows internal module reorganisation
 * without touching every import site.
 */

// ---- Types -----------------------------------------------------------------
export type {
  ModelStatus,
  ModelInfo,
  DataType,
  FeatureConfig,
  ThresholdConfig,
  BaselineStats,
  MissingValueStrategy,
  ValidationRule,
  ConfigStatus,
  ConfigMeta,
  ModelConfiguration,
} from './types';

// ---- Model identity & config metadata --------------------------------------
export { modelInfo, configMeta } from './model.config';

// ---- Feature definitions ---------------------------------------------------
export {
  features,
  getFeatureByColumn,
  getMonitoredFeatures,
} from './features.config';

// ---- Alert thresholds ------------------------------------------------------
export { thresholds } from './thresholds.config';

// ---- Baseline statistics ---------------------------------------------------
export { baseline, getBaselineByFeatureId } from './baseline.config';

// ---- Validation rules (prepared, not yet enforced) -------------------------
export {
  validationRules,
  getValidationByFeatureId,
} from './validation.config';

// ---- Assembled root config (convenience, for the /api/model-config route) ---
import { modelInfo, configMeta } from './model.config';
import { features } from './features.config';
import { thresholds } from './thresholds.config';
import { baseline } from './baseline.config';
import { validationRules } from './validation.config';
import type { ModelConfiguration } from './types';

export const modelConfiguration: ModelConfiguration = {
  meta: configMeta,
  model: modelInfo,
  features,
  thresholds,
  baseline,
  validation: validationRules,
};
