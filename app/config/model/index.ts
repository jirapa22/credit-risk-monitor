/**
 * Barrel export — single import point for the model configuration module.
 *
 * Usage:
 *   import { modelConfiguration, features, scorecardParams } from '@/config/model';
 */

export * from './types';
export { modelInfo, configMeta } from './model.config';
export { features, getFeatureByColumn, getMonitoredFeatures, findBin } from './features.config';
export { scorecardParams, modelPerformance } from './scorecard.config';
export { thresholds } from './thresholds.config';
export { baseline, getBaselineByFeatureId } from './baseline.config';
export { validationRules, getValidationByFeatureId } from './validation.config';

// ---------------------------------------------------------------------------
// Assembled root configuration object
// ---------------------------------------------------------------------------

import { modelInfo, configMeta } from './model.config';
import { features } from './features.config';
import { scorecardParams, modelPerformance } from './scorecard.config';
import { thresholds } from './thresholds.config';
import { baseline } from './baseline.config';
import { validationRules } from './validation.config';
import type { ModelConfiguration } from './types';

export const modelConfiguration: ModelConfiguration = {
  meta: configMeta,
  model: modelInfo,
  features,
  scorecard: scorecardParams,
  performance: modelPerformance,
  thresholds,
  baseline,
  validation: validationRules,
};
