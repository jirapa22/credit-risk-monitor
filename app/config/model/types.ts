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
  /** Unique identifier for the model */
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
// WOE Scorecard — bin-level structure
// ---------------------------------------------------------------------------

export interface ScorecardBin {
  /** Human-readable bin label, e.g. "≤17,800" or "17,801–22,300" */
  binLabel: string;
  /**
   * Exclusive lower bound (value must be strictly > lowerBound).
   * null means no lower limit (−∞).
   */
  lowerBound: number | null;
  /**
   * Inclusive upper bound (value must be ≤ upperBound).
   * null means no upper limit (+∞).
   */
  upperBound: number | null;
  /** Weight of Evidence: ln(pct_good / pct_bad) in this bin */
  woe: number;
  /** Additive score points contributed by this bin */
  points: number;
  /** Proportion of bad accounts in this bin (training set) */
  badRate: number;
  /** Number of observations in this bin (training set) */
  count: number;
  /**
   * Proportion of total training observations in this bin.
   * Stored as baseline distribution for CSI calculation.
   */
  pct: number;
}

// ---------------------------------------------------------------------------
// Scorecard calibration parameters
// ---------------------------------------------------------------------------

export interface ScorecardParams {
  /** Score assigned to the base odds (e.g. 600) */
  baseScore: number;
  /** Good-to-bad odds at the base score (e.g. 50 → 50 goods per 1 bad) */
  baseOdds: number;
  /** Points to Double the Odds (e.g. 20) */
  pdo: number;
  /**
   * Score offset = baseScore − factor × ln(baseOdds).
   * Pre-computed for efficient runtime scoring.
   */
  offset: number;
  /**
   * Scaling factor = PDO / ln(2).
   * Pre-computed for efficient runtime scoring.
   */
  factor: number;
  /** Logistic-regression intercept (in log-odds space) */
  intercept: number;
}

// ---------------------------------------------------------------------------
// Model performance metrics (one evaluation split)
// ---------------------------------------------------------------------------

export interface PerformanceMetrics {
  /** Area Under the ROC Curve */
  auc: number;
  /** Gini coefficient = 2 × AUC − 1 */
  gini: number;
  /** Kolmogorov–Smirnov statistic */
  ks: number;
  /** Total number of observations in this split */
  sampleSize: number;
  /** Proportion of bad accounts in this split */
  badRate: number;
  /** ISO-8601 date range, e.g. "2024-01 to 2024-09" */
  period: string;
}

export interface ModelPerformance {
  train: PerformanceMetrics;
  test: PerformanceMetrics;
}

// ---------------------------------------------------------------------------
// Feature-level configuration
// ---------------------------------------------------------------------------

export type DataType = 'Numeric' | 'Categorical' | 'Binary';

export interface FeatureConfig {
  /** Stable machine-readable identifier, e.g. "feat_001" */
  featureId: string;
  /** Label shown in the UI */
  displayName: string;
  /** Exact column name expected in the uploaded CSV */
  columnName: string;
  /** Where this value comes from (raw column or derived expression) */
  source: string;
  /** How the raw value is transformed before entering the model */
  transformation: string;
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
  /** Total Information Value for this feature (from training) */
  iv: number;
  /** WOE scorecard bins — ordered from lowest to highest bound */
  bins: ScorecardBin[];
}

// ---------------------------------------------------------------------------
// Threshold configuration (PSI / CSI / performance alerts)
// ---------------------------------------------------------------------------

export interface ThresholdConfig {
  /** PSI value above which a warning alert is raised */
  psiWarnThreshold: number;
  /** PSI value above which a critical alert is raised */
  psiCriticalThreshold: number;
  /** Global CSI threshold — applies to features without a feature-level override */
  csiThreshold: number;
  /** Minimum acceptable AUC — below this triggers a performance alert */
  minAuc: number;
  /** Minimum acceptable Gini coefficient (= 2 × AUC − 1) */
  minGini: number;
  /** Minimum acceptable KS statistic */
  minKs: number;
}

// ---------------------------------------------------------------------------
// Baseline statistics (per feature, from training/baseline dataset)
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
// Validation rules (prepared — not yet enforced at runtime)
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
  scorecard: ScorecardParams;
  performance: ModelPerformance;
  thresholds: ThresholdConfig;
  baseline: BaselineStats[];
  validation: ValidationRule[];
}
