/**
 * Domain types shared by Monitoring, Sandbox (future) and storage.
 *
 * Design rules
 *  - Every persisted result carries a ModelVersionRef + referenceId so results
 *    of different model/config versions or different reference datasets never mix.
 *  - Data Validation (is the data well-formed?) and Drift Detection (did the
 *    distribution change?) are separate result objects.
 *  - Features are config-driven (featureRegistry) — nothing here hard-codes
 *    monthly_income / loan_amount / dti_ratio.
 */

// ─── Model / config ──────────────────────────────────────────────────────────
export interface ModelVersionRef {
  modelId: string;        // e.g. "ascore_v1"
  configVersion: string;  // e.g. "1.1.0" — bumped whenever thresholds/bins change
}

export type FeatureDataType = 'numeric' | 'binary' | 'date' | 'categorical' | 'string';
export type MissingStrategy = 'reject' | 'fillMean' | 'fillMedian' | 'fillDefault' | 'ignore';

export interface FeatureDefinition {
  featureId?: string;
  columnName: string;
  displayName: string;
  description?: string;
  source?: string;
  dataType: FeatureDataType;
  required: boolean;
  monitoringEnabled: boolean;
  displayOrder?: number;
  validation?: {
    minValue?: number | null;
    maxValue?: number | null;
    allowNull?: boolean;
    defaultValue?: number | null;
    missingStrategy?: MissingStrategy;
  };
  binning?: { method?: string; numBins?: number; boundaries: number[]; binLabels?: string[] };
  baselineDistribution?: Record<string, number | null>;
  csiThreshold?: number | null;
  /** Transform applied before univariate outlier stats (IQR/MAD). Default 'none'. */
  anomalyTransform?: AnomalyTransform;
}

export type AnomalyTransform = 'none' | 'log1p';

export interface ScorecardFeature {
  bins: number[];         // upper-inclusive boundaries: value <= bins[i] → bin i
  bin_labels?: string[];
  points: number[];       // length = bins.length + 1
  woe?: number[];
  count?: number[];
  bad_rate?: number[];
}

export interface ScoringConfig {
  base_points: number;
  pdo?: number;
  base_score?: number;
  base_odds?: number;
  factor: number;
  offset: number;
  features: string[];
  scorecard: Record<string, ScorecardFeature>;
}

export interface CsiFeatureThreshold {
  label?: string;
  source?: string;
  threshold: number;
  bins: number[];
  bin_labels?: string[];
}

export interface MonitoringThresholds {
  psi_warning: number;
  psi_critical: number;
  gini_min: number;
  auc_min: number;
  ks_min: number;
  csi_features: Record<string, CsiFeatureThreshold>;
}

// ─── Reference dataset ───────────────────────────────────────────────────────
export interface ReferenceDatasetMeta {
  referenceId: string;
  version: string;
  modelId: string;
  description: string;
  source: string;
  createdAt: string;
  rowCount: number;
  badCount: number;
  badRate: number;
  periodStart: string;
  periodEnd: string;
  columns: string[];
  sha256: string;
}

// ─── Data validation ─────────────────────────────────────────────────────────
export type ValidationIssueType =
  | 'EMPTY_FILE'
  | 'MISSING_COLUMN'
  | 'DUPLICATE_COLUMN'
  | 'MISSING_VALUE'
  | 'INVALID_TYPE'
  | 'OUT_OF_RANGE'
  | 'INVALID_DATE'
  | 'INVALID_BINARY'
  | 'DUPLICATE_ID'
  | 'MALFORMED_ROW';

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  type: ValidationIssueType;
  severity: ValidationSeverity;
  column?: string;
  row?: number;          // 1-based data row (excluding header) — matches the line in Excel minus 1
  value?: string;
  message: string;       // human-readable (Thai)
}

export interface ValidationIssueGroup {
  type: ValidationIssueType;
  severity: ValidationSeverity;
  column?: string;
  count: number;
  sampleRows: number[];
  message: string;
}

export interface ValidationResult {
  ok: boolean;                 // false → cannot run drift detection at all
  totalRows: number;
  validRows: number;
  rejectedRows: number;
  rejectedPct: number;
  blockingErrors: ValidationIssue[];   // file-level problems (e.g. missing required column)
  warnings: ValidationIssue[];         // file-level, non-blocking (e.g. optional column missing, small sample)
  groups: ValidationIssueGroup[];      // row-level problems, grouped for display
  issues: ValidationIssue[];           // first N row-level issues (detail)
}

// ─── Drift detection ─────────────────────────────────────────────────────────
export type DriftStatus = 'STABLE' | 'WARNING' | 'CRITICAL';

export interface BinContribution {
  label: string;
  expectedCount: number;
  actualCount: number;
  expectedPct: number;
  actualPct: number;
  contribution: number;
}

export interface StabilityResult {
  value: number;
  status: DriftStatus;
  threshold: { warning: number; critical: number };
  bins: BinContribution[];
}

export interface DriftResult {
  referenceId: string;
  psi: StabilityResult;                       // on total score
  csi: Record<string, StabilityResult & { displayName: string; source?: string }>;
  overallStatus: DriftStatus;
  triggered: string[];                        // e.g. ["psi", "csi:dti_ratio"]
}

// ─── Anomaly detection (layers 3–4) ─────────────────────────────────────────
/** A warning-only flag: rows are never removed automatically; the user decides. */
export type AnomalyMethod = 'iqr' | 'mad' | 'cross_field' | 'isolation_forest' | 'lof';

export interface AnomalyFlag {
  row: number;            // CleanRow.row (1-based data row)
  method: AnomalyMethod;
  feature: string;        // feature key, or rule id for cross_field (e.g. "loan_amount/monthly_income")
  value: number;          // observed value (ratio for cross_field)
  score: number;          // iqr: distance beyond fence in IQR units; mad: robust z; cross_field: value / threshold
  reason: string;         // human-readable (Thai)
  extreme?: boolean;      // score was ±Infinity/NaN (e.g. negative value on a log feature)
}

/** JSON-safe flag as stored in runs: non-finite scores become null + extreme: true. */
export type StoredAnomalyFlag = Omit<AnomalyFlag, 'score'> & { score: number | null };

export interface AnomalyFlaggedRow {
  row: number;
  id: string;
  methods: AnomalyMethod[];
  reasons: string[];
  flags: StoredAnomalyFlag[];
}

export interface AnomalyConfigSnapshot {
  iqrK: number;
  madThreshold: number;
  contamination: number;
  seed: number;
  k: number;
  nTrees: number;
  sampleSize: number;
  transforms: Record<string, AnomalyTransform>;
  crossFieldRules: { id?: string; numerator: string; denominator: string; op: '>' | '<'; threshold: number; label?: string }[];
}

export interface AnomalyResult {
  flaggedRows: AnomalyFlaggedRow[];        // one entry per row, sorted by #methods desc; may be truncated
  truncated: boolean;
  byMethod: Partial<Record<AnomalyMethod, number>>;   // unique rows per method (always full count)
  totalRows: number;
  flaggedRowCount: number;                 // always full count
  flaggedPct: number;
  /** Reference rows flagged by the same rules — removed from the reference side of driftExcludingFlagged. */
  referenceFlaggedCount: number;
  thresholds: { isolation_forest: number; lof: number } | null;
  warnings: string[];
  timing: { univariateMs: number; multivariateFitMs: number; multivariateScoreMs: number; fitCached: boolean; totalMs: number };
  configSnapshot: AnomalyConfigSnapshot;
}

// ─── Persisted runs ──────────────────────────────────────────────────────────
export interface MonitoringRun {
  runId: string;
  kind: 'monitoring';
  createdAt: string;
  model: ModelVersionRef;
  modelName: string;
  referenceId: string;
  fileName: string;
  thresholdsSnapshot: MonitoringThresholds;
  validation: ValidationResult;
  drift: DriftResult | null;                  // null when validation blocked the run
  /** Layer 3–4 screening (warning-only). null when validation blocked or screening disabled. Absent in older runs. */
  anomaly?: AnomalyResult | null;
  /** What-if: drift with every flagged row removed. null when nothing was flagged. */
  driftExcludingFlagged?: DriftResult | null;
  /** Audit trail: rows the user chose to exclude from the official drift. */
  excludedRows?: number[];
  uploadSummary?: unknown;
  notes?: string;
}

/** Future Sandbox experiment — structure only, no UI yet. */
export type AnomalyType =
  | 'none'               // control run, used for false-positive rate
  | 'mean_shift'
  | 'variance_change'
  | 'missing_injection'
  | 'outlier_injection'
  | 'category_shift'
  | 'schema_break'
  | 'custom';

export type AnomalySeverity = 'none' | 'low' | 'medium' | 'high';

export interface ExperimentRun {
  runId: string;
  kind: 'sandbox';
  createdAt: string;
  experimentId: string;                       // groups repeated trials
  model: ModelVersionRef;
  referenceId: string;
  anomaly: {
    type: AnomalyType;
    severity: AnomalySeverity;
    targetFeatures: string[];
    params: Record<string, number | string | boolean>;
    seed?: number;
  };
  thresholdsSnapshot: MonitoringThresholds;
  expected: { shouldDetect: boolean; layer: 'validation' | 'drift' | 'none' };
  validation: Pick<ValidationResult, 'ok' | 'validRows' | 'rejectedRows' | 'rejectedPct'> | null;
  drift: Pick<DriftResult, 'overallStatus' | 'triggered'> & { psi: number; csi: Record<string, number> } | null;
  detected: boolean;
  outcome: 'TP' | 'FP' | 'TN' | 'FN';
  notes?: string;
}

export type StoredRun = MonitoringRun | ExperimentRun;
