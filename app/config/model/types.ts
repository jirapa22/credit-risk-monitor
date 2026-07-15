/**
 * Credit Risk Monitor — Model Configuration Types
 *
 * Single source of truth for every interface used across the config modules.
 * Import from here; never redefine these shapes elsewhere.
 */

// ---------------------------------------------------------------------------
// Model identity & lifecycle
// ---------------------------------------------------------------------------

export type ModelStatus = 'Draft' | 'Testing' | 'Published';

export interface ModelInfo {
  /** Unique identifier for the model (matches the key in legacy model-config.json) */
  modelId: string;
  /** Human-readable display name */
  name: string;
  /** Semantic version string, e.g. "1.0.0" */
  version: string;
  /** Team or person responsible for this model */
  owner: string;
  /** ISO-8601 date string — when training data was cut */
  trainingDate: string;
  /** Name / path of the dataset used for baseline statistics */
  baselineDataset: string;
  /** ISO-8601 date string — when this config entry was first created */
  createdDate: string;
  /** ISO-8601 date string — when this config entry was last updated */
  updatedDate: string;
  /** Lifecycle status of the model */
  status: ModelStatus;
}

// ---------------------------------------------------------------------------
// Feature-level configuration
// ---------------------------------------------------------------------------

export type DataType = 'Numeric' | 'Categorical' | 'Binary';

export interface FeatureConfig {
  /** Stable machine-readable identifier, e.g. "feat_income" */
  featureId: string;
  /** Label shown in the UI */
  displayName: string;
  /** Exact column name in the upstream dataset */
  columnName: string;
  /** Short description of what the feature represents */
  description: string;
  /** Data type governing encoding and validation behaviour */
  dataType: DataType;
  /** Whether this feature must be present for a valid prediction */
  required: boolean;
  /** Whether CSI monitoring is active for this feature */
  monitoringEnabled: boolean;
  /** CSI alert threshold for this specific feature */
  csiThreshold: number;
  /** Rendering order in configuration and monitoring UIs */
  displayOrder: number;
  /** Whether this feature's configuration can be edited via the UI */
  editable: boolean;
  /**
   * Logistic-regression coefficient used in the scoring equation.
   * Kept here so the risk-score route derives the equation from config only.
   */
  weight: number;
}

// ---------------------------------------------------------------------------
// Threshold configuration (PSI / CSI alerts)
// ---------------------------------------------------------------------------

export interface ThresholdConfig {
  /** PSI value above which a warning alert is raised */
  psiWarnThreshold: number;
  /** PSI value above which a critical alert is raised */
  psiCriticalThreshold: number;
  /** Global CSI drift threshold (applies to all features without a feature-level override) */
  csiThreshold: number;
  /** Minimum acceptable AUC — below this triggers a model performance alert */
  minAuc: number;
  /** Minimum acceptable Gini coefficient (= 2 × AUC − 1) */
  minGini: number;
  /** Minimum acceptable KS statistic */
  minKs: number;
}

// ---------------------------------------------------------------------------
// Baseline statistics (per feature)
// ---------------------------------------------------------------------------

export interface BaselineStats {
  featureId: string;
  mean: number;
  std: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  /** Proportion of rows where this feature was null/missing (0–1) */
  missingPct: number;
  uniqueCount: number;
}

// ---------------------------------------------------------------------------
// Validation rules (prepared for future use — not yet enforced at runtime)
// ---------------------------------------------------------------------------

export type MissingValueStrategy = 'mean' | 'median' | 'zero' | 'reject';

export interface ValidationRule {
  featureId: string;
  minValue: number | null;
  maxValue: number | null;
  allowNull: boolean;
  defaultValue: number | string | null;
  missingValueStrategy: MissingValueStrategy;
}

// ---------------------------------------------------------------------------
// Configuration metadata (versioning & audit trail)
// ---------------------------------------------------------------------------

export type ConfigStatus = 'Draft' | 'Published';

export interface ConfigMeta {
  /** Monotonically increasing config version, e.g. "1.0.0" */
  configVersion: string;
  /** ISO-8601 date string — when this config version was created */
  createdDate: string;
  /** ISO-8601 date string — when this config version was last modified */
  updatedDate: string;
  /** Lifecycle status of this configuration snapshot */
  status: ConfigStatus;
  /** Team or person who created this configuration snapshot */
  createdBy: string;
  /** Team or person who last updated this configuration snapshot */
  updatedBy: string;
}

// ---------------------------------------------------------------------------
// Root configuration object (aggregates all modules)
// ---------------------------------------------------------------------------

export interface ModelConfiguration {
  meta: ConfigMeta;
  model: ModelInfo;
  features: FeatureConfig[];
  thresholds: ThresholdConfig;
  baseline: BaselineStats[];
  validation: ValidationRule[];
}
