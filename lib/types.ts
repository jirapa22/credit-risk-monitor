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
export type ScoreDirection = 'higher_is_safer' | 'higher_is_riskier';
export type MissingStrategy = 'reject' | 'fillMean' | 'fillMedian' | 'fillMode' | 'fillDefault' | 'ignore';

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
  /** Allowed category labels for categorical features (if omitted, derived from Reference dataset). */
  allowedCategories?: string[];
  /** Categories occurring in < rareCategoryThreshold of Reference rows are grouped into '__OTHER__' (default 0.01). */
  rareCategoryThreshold?: number;
  validation?: {
    minValue?: number | null;
    maxValue?: number | null;
    allowNull?: boolean;
    defaultValue?: number | string | null;
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
  | 'UNSEEN_CATEGORY'
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
  warningRows?: number;
  warningRowPct?: number;
  blockingErrors: ValidationIssue[];   // file-level problems (e.g. missing required column)
  warnings: ValidationIssue[];         // file-level, non-blocking (e.g. optional column missing, small sample)
  groups: ValidationIssueGroup[];      // row-level problems, grouped for display
  issues: ValidationIssue[];           // first N row-level issues (detail)
}

// ─── Drift detection ─────────────────────────────────────────────────────────
export type DriftStatus = 'STABLE' | 'WARNING' | 'CRITICAL';
export type DriftSectionStatus = DriftStatus | 'NOT_AVAILABLE';

export type DriftThresholdMode = 'fixed' | 'calibrated';

export interface DriftConfig {
  /** Mode for drift thresholds: 'fixed' (default industry standards) | 'calibrated' (null distribution bootstrap). */
  thresholdMode?: DriftThresholdMode;
  /** KS two-sample D thresholds (ค่าเริ่มต้นชั่วคราว 0.10 / 0.20 — จะปรับให้แม่นขึ้นใน Step 11). */
  ksWarning?: number;
  ksCritical?: number;
  /** Wasserstein-1 (scaled by Reference MAD/0.6745) thresholds (ค่าเริ่มต้นชั่วคราว 0.10 / 0.25 — จะปรับให้แม่นขึ้นใน Step 11). */
  wassersteinWarning?: number;
  wassersteinCritical?: number;
  /** Jensen–Shannon distance thresholds for categorical features (ค่าเริ่มต้นชั่วคราว 0.10 / 0.20). */
  jsWarning?: number;
  jsCritical?: number;
  /** Missing-rate increase thresholds in proportion (0.02 = 2 จุด%, 0.05 = 5 จุด%). */
  missingDeltaWarning?: number;
  missingDeltaCritical?: number;
  /** Minimum labeled rows in new data to evaluate label/concept drift (default 100). */
  minLabeledRows?: number;
  /** Relative bad-rate change thresholds (0.20 = 20%, 0.50 = 50%) when p < labelPValueThreshold. */
  labelRelChangeWarning?: number;
  labelRelChangeCritical?: number;
  labelPValueThreshold?: number;
  /** Minimum bads per bin on both Reference and actual to judge bin-level concept drift (default 5). */
  minBadsPerBin?: number;
  /** Relative Gini drop thresholds (0.10 = 10%, 0.25 = 25%). */
  giniRelDropWarning?: number;
  giniRelDropCritical?: number;
}

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
  status: DriftSectionStatus;
  threshold: { warning: number; critical: number };
  bins: BinContribution[];
}

export interface DriftResult {
  referenceId: string;
  // on total score (status = 'NOT_AVAILABLE' when score is unavailable)
  psi: StabilityResult;
  csi: Record<string, StabilityResult & { displayName: string; source?: string }>;
  overallStatus: DriftStatus;
  // e.g. ["psi", "csi:<feature>"]
  triggered: string[];
}

// ─── Full Drift Report (Step 8: covariate / missing / label / concept) ───────
export interface DistributionStats {
  n: number;
  mean: number;
  median: number;
  sd: number;
  iqr: number;
  p5: number;
  p95: number;
  skewness: number;
  excessKurtosis: number;
}

export interface CategoryProportionEntry {
  category: string;
  referenceCount: number;
  referencePct: number;
  actualCount: number;
  actualPct: number;
  deltaPct: number;
}

export interface DistributionProfile {
  reference: DistributionStats;
  actual: DistributionStats;
  pctChange: {
    mean: number | null;
    median: number | null;
    sd: number | null;
    iqr: number | null;
    p5: number | null;
    p95: number | null;
    skewness: number | null;
    excessKurtosis: number | null;
  };
  /** Present for categorical features: per-category counts and proportions (0–1). */
  categories?: CategoryProportionEntry[];
}

export interface KsTwoSampleResult {
  d: number;
  /** Asymptotic p-value — informational only, never used to determine status. */
  pValue: number;
  status: DriftStatus;
  threshold: { warning: number; critical: number };
}

export interface WassersteinResult {
  raw: number;
  /** Divided by Reference robust scale (MAD / 0.6745) on the transformed scale. */
  scaled: number;
  referenceScale: number;
  transform: AnomalyTransform;
  status: DriftStatus;
  threshold: { warning: number; critical: number };
}

export interface ChiSquareResult {
  statistic: number;
  df: number;
  /** Asymptotic p-value from chi-square distribution with df degrees of freedom. */
  pValue: number;
}

export interface JensenShannonResult {
  /** Jensen–Shannon distance = sqrt(JSD_base2) in [0, 1]. */
  distance: number;
  /** Jensen–Shannon divergence (base 2) in [0, 1]. */
  divergence: number;
  status: DriftStatus;
  threshold: { warning: number; critical: number };
}

export interface CovariateFeatureReport {
  key: string;
  displayName: string;
  kind: 'feature' | 'score';
  dataType?: FeatureDataType;
  status: DriftSectionStatus;
  statusFixed?: DriftSectionStatus;
  statusCalibrated?: DriftSectionStatus;
  reason: string;
  psiOrCsi: StabilityResult | null;
  distributionProfile: DistributionProfile | null;
  ks: KsTwoSampleResult | null;
  wasserstein: WassersteinResult | null;
  chiSquare?: ChiSquareResult | null;
  jensenShannon?: JensenShannonResult | null;
}

export interface MissingFeatureReport {
  key: string;
  displayName: string;
  referenceMissingRate: number;
  actualMissingRate: number;
  /** actualMissingRate - referenceMissingRate (in proportion, e.g. 0.02 = +2 percentage points). */
  deltaMissingRate: number;
  /** deltaMissingRate * 100 (percentage points). */
  deltaPercentagePoints: number;
  actualMissingCount: number;
  imputedCount: number;
  imputedRate: number;
  status: DriftStatus;
  reason: string;
}

export interface LabelDriftMetrics {
  referenceLabeledRows: number;
  referenceBadCount: number;
  referenceBadRate: number;
  actualLabeledRows: number;
  actualBadCount: number;
  actualBadRate: number;
  absoluteChange: number;
  relativeChange: number | null;
  zStat: number | null;
  pValue: number | null;
  threshold: {
    minLabeledRows: number;
    relChangeWarning: number;
    relChangeCritical: number;
    pValueThreshold: number;
  };
}

export interface ConceptBinBadRate {
  label: string;
  referenceTotal: number;
  referenceBads: number;
  referenceBadRate: number | null;
  actualTotal: number;
  actualBads: number;
  actualBadRate: number | null;
  ratio: number | null;
  deltaBadRate: number | null;
  lowSample: boolean;
  note?: string;
}

export interface ConceptFeatureReport {
  key: string;
  displayName: string;
  bins: ConceptBinBadRate[];
  maxBinRatio: number | null;
  status: DriftSectionStatus;
  reason: string;
}

export interface ConceptPerformanceReport {
  status: DriftSectionStatus;
  reason: string;
  reliable: boolean;
  reliabilityWarnings: string[];
  reference: { n: number; bads: number; auc: number; gini: number; ks: number } | null;
  actual: { n: number; bads: number; auc: number; gini: number; ks: number } | null;
  relativeChange: { auc: number | null; gini: number | null; ks: number | null } | null;
  thresholds: {
    auc_min: number;
    gini_min: number;
    ks_min: number;
    giniRelDropWarning: number;
    giniRelDropCritical: number;
  };
}

export interface DriftReportSection<T> {
  status: DriftSectionStatus;
  statusFixed?: DriftSectionStatus;
  statusCalibrated?: DriftSectionStatus;
  reason: string;
  metrics: T;
}

export interface DriftReportSummaryMetrics {
  overallStatus: DriftStatus;
  statusFixed?: DriftStatus;
  statusCalibrated?: DriftStatus;
  driftTypesDetected: string[];
  notAvailable: { section: string; reason: string }[];
}

export interface DriftReport {
  model: ModelVersionRef;
  referenceId: string;
  statusFixed?: DriftStatus;
  statusCalibrated?: DriftStatus;
  covariate: DriftReportSection<{
    features: Record<string, CovariateFeatureReport>;
    score: CovariateFeatureReport;
  }>;
  missing: DriftReportSection<{
    features: Record<string, MissingFeatureReport>;
    threshold: { warningDelta: number; criticalDelta: number };
  }>;
  label: DriftReportSection<LabelDriftMetrics | null>;
  concept: DriftReportSection<{
    features: Record<string, ConceptFeatureReport>;
    performance: ConceptPerformanceReport;
    minBadsPerBin: number;
  } | null>;
  summary: DriftReportSection<DriftReportSummaryMetrics> & DriftReportSummaryMetrics;
}

// ─── Anomaly detection (layers 3–4) ─────────────────────────────────────────
/** A warning-only flag: rows are never removed automatically; the user decides. */
export type AnomalyMethod = 'iqr' | 'mad' | 'cross_field' | 'unseen_category' | 'isolation_forest' | 'lof';

export interface AnomalyFlag {
  row: number;            // CleanRow.row (1-based data row)
  method: AnomalyMethod;
  // feature key, or rule id for cross_field
  feature: string;
  value: number;          // observed value (ratio for cross_field, 1 for unseen_category)
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
  excludedCategoricalFeatures?: string[];
  warnings?: string[];
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

// ─── Trigger & Recommended Actions (Step 9: MLOps Monitoring → Trigger) ──────
export type TriggerAction =
  | 'CONTINUE'
  | 'MONITOR_CLOSELY'
  | 'INVESTIGATE_DATA'
  | 'INVESTIGATE_DRIFT'
  | 'RECALIBRATE'
  | 'CONSIDER_RETRAIN'
  | 'BLOCKED_INVALID_DATA';

export type TriggerSeverity = 'info' | 'warning' | 'critical';

export type TriggerSectionName = 'covariate' | 'missing' | 'label' | 'concept' | 'overall';

export type TriggerCondition =
  | { type: 'validationBlocked' }
  | { type: 'validationIssuesAbove'; rejectedPct?: number; warningRowPct?: number }
  | { type: 'sectionStatus'; section: TriggerSectionName; atLeast: 'WARNING' | 'CRITICAL' }
  | { type: 'driftResolvedByExclusion' }
  | { type: 'flaggedPctAbove'; multiplierOfReference: number }
  | { type: 'persistence'; section: TriggerSectionName; atLeast: 'WARNING' | 'CRITICAL'; runs: number }
  | { type: 'not'; condition: TriggerCondition };

export interface TriggerRule {
  id: string;
  priority: number;
  when: TriggerCondition[];
  action: TriggerAction;
  severity: TriggerSeverity;
  message: string;
  recommendedSteps: string[];
}

export interface TriggerConfig {
  rules?: TriggerRule[];
}

export interface TriggerEvidence {
  validation?: {
    ok: boolean;
    totalRows: number;
    validRows: number;
    rejectedRows: number;
    rejectedPct: number;
    warningRows?: number;
    warningRowPct?: number;
    blockingErrorCount: number;
  } | null;
  anomaly?: {
    flaggedRowCount: number;
    flaggedPct: number;
    referenceFlaggedCount: number;
    referenceFlaggedPct: number;
    byMethod: AnomalyResult['byMethod'];
  } | null;
  driftReport?: {
    overallStatus?: DriftStatus;
    driftTypesDetected?: string[];
    covariateStatus?: DriftSectionStatus;
    missingStatus?: DriftSectionStatus;
    labelStatus?: DriftSectionStatus;
    conceptStatus?: DriftSectionStatus;
    officialDriftStatus?: DriftStatus | null;
    driftExcludingFlaggedStatus?: DriftStatus | null;
  } | null;
}

export interface TriggerDecision {
  action: TriggerAction;
  severity: TriggerSeverity;
  matchedRuleId: string;
  reasons: string[];
  evidence: TriggerEvidence;
  recommendedSteps: string[];
  requiresHumanReview: boolean;
  configWarnings?: string[];
}

export type TriggerReviewDecision =
  | 'ACCEPTED'
  | 'DISMISSED'
  | 'RETRAIN_SCHEDULED'
  | 'RECALIBRATED';

export interface TriggerReview {
  decision: TriggerReviewDecision;
  note: string;
  reviewer: string;
  reviewedAt: string;
}

export type TriggerEventStatus = 'OPEN' | 'REVIEWED';

export interface TriggerEvent {
  eventId: string;
  runId: string;
  createdAt: string;
  model: ModelVersionRef;
  referenceId: string;
  decision: TriggerDecision;
  status: TriggerEventStatus;
  review: TriggerReview | null;
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
  /** Full drift report with every flagged row removed (symmetric). null when nothing was flagged. */
  driftReportExcludingFlagged?: DriftReport | null;
  /** Full 5-section drift report (covariate / missing / label / concept / summary). Optional for backward compatibility. */
  driftReport?: DriftReport | null;
  /** MLOps trigger decision (Step 9). Optional for backward compatibility. */
  trigger?: TriggerDecision | null;
  /** Audit trail: rows the user chose to exclude from the official drift. */
  excludedRows?: number[];
  uploadSummary?: unknown;
  notes?: string;
}

/** Sandbox anomaly types (see lib/injection.ts). Legacy 'outlier_injection' is accepted by the API as an alias of 'extreme_outlier'. */
export type AnomalyType =
  | 'none'                       // C: control run, used for false-alarm rate
  // A: data errors
  | 'unit_error'
  | 'extreme_outlier'
  | 'negative_value'
  | 'type_error'
  | 'missing_injection'
  | 'swapped_columns'
  | 'duplicate_rows'
  | 'multivariate_inconsistent'
  | 'schema_break'
  | 'unseen_category'
  // B: real drift
  | 'mean_shift'
  | 'variance_change'
  | 'category_shift'
  // Step 11a: new drift scenarios
  | 'label_shift'
  | 'concept_shift'
  | 'mix_shift'
  | 'missing_drift';

export type ExpectedLayer = 'validation' | 'anomaly' | 'drift' | 'none';
export type DriftSectionName = 'covariate' | 'label' | 'concept' | 'missing';

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
  expected: { shouldDetect: boolean; layer: ExpectedLayer };
  validation: Pick<ValidationResult, 'ok' | 'validRows' | 'rejectedRows' | 'rejectedPct'> | null;
  drift: Pick<DriftResult, 'overallStatus' | 'triggered'> & { psi: number; csi: Record<string, number> } | null;
  detected: boolean;
  outcome: 'TP' | 'FP' | 'TN' | 'FN';
  /** From lib/experiment.ts runTrial (absent in records created via plain POST). */
  rate?: number;
  metrics?: Record<string, { n: number; TP: number; FP: number; FN: number; TN: number; precision: number | null; recall: number | null; f1: number | null; flagRate: number | null }>;
  fileMetrics?: {
    blocked: boolean;
    alarm: boolean;
    alarmExcludingFlagged: boolean;
    falseAlarm: boolean | null;
    rescued: boolean | null;
    detected: boolean | null;
    preserved: boolean | null;
    routedLayer: ExpectedLayer;
    routingCorrect: boolean;
    sectionLeakage?: DriftSectionName[];
    expectedSection?: DriftSectionName;
    triggerCorrect?: boolean;
  };
  driftExcludingFlagged?: { overallStatus: DriftStatus; psi: number; csi: Record<string, number> } | null;
  triggerAction?: TriggerAction;
  notes?: string;
}

export type StoredRun = MonitoringRun | ExperimentRun;

// ─── Baseline Registry & Model Lifecycle (Step 10a) ──────────────────────────
export type BaselineStatus = 'DRAFT' | 'VALIDATED' | 'ACTIVE' | 'ARCHIVED';
export type BaselineMode = 'scorecard' | 'score_column';

export interface BaselineStatusHistoryEntry {
  from: BaselineStatus | null;
  to: BaselineStatus;
  at: string;
  by: string;
  note?: string;
}

export interface BaselineValidationIssue {
  code: string;
  field?: string;
  message: string;
}

export interface BaselineValidationReport {
  ok: boolean;
  validatedAt: string;
  referenceId: string;
  sha256: string;
  errors: BaselineValidationIssue[];
  warnings: BaselineValidationIssue[];
  computed: {
    rowCount: number;
    hasLabels: boolean;
    labeledRowCount: number;
    badCount: number;
    badRate: number | null;
    performance: {
      auc: number;
      gini: number;
      ks: number;
      reliable: boolean;
      warnings: string[];
    } | null;
    autoGeneratedBins: Record<string, { boundaries: number[]; binLabels: string[] }>;
    featureSkewness: Record<
      string,
      { skewness: number; anomalyTransform: AnomalyTransform; recommendLog1p: boolean }
    >;
    referenceFlaggedCount: number;
    referenceFlaggedPct: number;
    multivariateFitMs: number;
  };
}

export interface OnboardingLogEntry {
  field: string;
  suggested: unknown;
  chosen: unknown;
  provider: string;
}

export interface CalibratedThresholdPair {
  warning: number;
  critical: number;
}

export interface CalibratedMetricThresholds {
  psi?: CalibratedThresholdPair;
  csi: Record<string, CalibratedThresholdPair>;
  ks: Record<string, CalibratedThresholdPair>;
  wasserstein: Record<string, CalibratedThresholdPair>;
  js: Record<string, CalibratedThresholdPair>;
  concept?: {
    giniDrop?: CalibratedThresholdPair;
    worstBinRatio?: CalibratedThresholdPair;
    nullP95GiniDrop?: number;
    nullP99GiniDrop?: number;
  };
  label?: {
    badRateRelChange?: CalibratedThresholdPair;
  };
}

export interface CalibratedThresholds {
  calibratedAt: string;
  resamples: number;
  seed: number;
  sizes: number[];
  /** Number of decision metrics in the family used for Bonferroni adjustment. */
  k?: number;
  /** Family-wise calibrated thresholds (Bonferroni-adjusted: 1 - 0.05/k, 1 - 0.01/k). */
  bySize: Record<number | string, CalibratedMetricThresholds>;
  /** Unadjusted individual calibrated thresholds (p95, p99). */
  bySizeUnadjusted?: Record<number | string, CalibratedMetricThresholds>;
}

export interface BaselineVersion {
  modelId: string;
  version: string; // semver, e.g. "1.1.0"
  name: string;
  description: string;
  status: BaselineStatus;
  mode: BaselineMode;
  columns: {
    idColumn: string;
    dateColumn?: string | null;
    labelColumn?: string | null;
    scoreColumn?: string | null;
  };
  scoreDirection: 'higher_is_safer' | 'higher_is_riskier';
  featureRegistry: Record<string, FeatureDefinition>;
  scoring?: ScoringConfig;
  thresholds: MonitoringThresholds;
  anomalyConfig?: Record<string, unknown>;
  driftConfig?: DriftConfig;
  triggerConfig?: TriggerConfig;
  riskGrades?: { grade: string; minScore: number }[];
  experimentConfig?: { multivariateTargets?: string[] };
  referenceDatasetId: string;
  calibratedThresholds?: CalibratedThresholds;
  validationReport?: BaselineValidationReport | null;
  onboardingLog?: OnboardingLogEntry[];
  createdAt: string;
  createdBy: string;
  statusHistory: BaselineStatusHistoryEntry[];
  builtIn?: boolean;
}

export interface ModelMetadata {
  modelId: string;
  name: string;
  description: string;
  type?: string;
  createdAt: string;
  builtIn?: boolean;
}

export interface DetectedColumnSchema {
  name: string;
  column?: string;
  inferredType: FeatureDataType;
  nonNullCount: number;
  missingCount: number;
  missingRate: number;
  uniqueCount: number;
  sampleValues: (string | number)[];
  monitoringEnabled?: boolean;
  warning?: string;
}

export interface DeletionAuditEntry {
  id: string;
  action: 'delete_version' | 'archive_version' | 'delete_model';
  actor: string;
  timestamp: string;
  modelId: string;
  version?: string;
  previousStatus?: BaselineStatus;
  clearedCounts: {
    monitoringRuns: number;
    sandboxRuns: number;
    events: number;
    reviews: number;
    total: number;
  };
  referenceDatasetId?: string;
  blobDeleted: boolean;
  note?: string;
}

