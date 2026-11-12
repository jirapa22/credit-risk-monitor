/**
 * Full Drift Report (Step 8) — covers all four MLOps drift families:
 *   (a) covariate : P(X) data distribution shift (CSI/PSI + distribution profile + KS D + scaled Wasserstein-1)
 *   (b) missing   : missing-as-a-feature (raw pre-validation missing rate delta + imputed rate)
 *   (c) label     : P(y) target / bad-rate shift (relative change + two-proportion z-test)
 *   (d) concept   : P(y|X) relationship shift (per-bin bad rate vs Reference rows + AUC/Gini/KS drop)
 *   (e) summary   : worst status across (a)–(d), detected drift types, and NOT_AVAILABLE reasons
 *
 * Permanent rules enforced:
 *   1. No hard-coded feature names, special column names, or thresholds.
 *   2. Optional data (label, date, score, scorecard) when absent returns NOT_AVAILABLE with a Thai reason.
 *   3. All reference statistics (moments, quantiles, MAD scale, bin bad rates, AUC/Gini/KS) are computed
 *      dynamically from Reference dataset rows — never from display-only config fields.
 */
import type {
  AnomalyTransform,
  CalibratedThresholds,
  CategoryProportionEntry,
  ConceptBinBadRate,
  ConceptFeatureReport,
  ConceptPerformanceReport,
  CovariateFeatureReport,
  DistributionProfile,
  DistributionStats,
  DriftConfig,
  DriftReport,
  DriftReportSummaryMetrics,
  DriftSectionStatus,
  DriftStatus,
  FeatureDefinition,
  JensenShannonResult,
  KsTwoSampleResult,
  LabelDriftMetrics,
  MissingFeatureReport,
  MonitoringThresholds,
  DriftResult,
  StabilityResult,
  WassersteinResult,
} from './types';
import type { ReferenceProfile } from './reference';
import type { CleanRow } from './validation';
import { DEFAULT_LABEL_COLUMN, resolveModelColumns } from './defaults';
import { classify, resolveCsiFeatures, runDriftDetection } from './drift';
import { getNearestSize } from './calibration';
import { calculateAScore } from './scoring';
import {
  assessMetricReliability,
  calculateAUC,
  calculateGini,
  calculateKS,
  chiSquareTwoSample,
  defaultBinLabels,
  formatCategoryDisplayLabel,
  getBinIndex,
  jensenShannonDistance,
  psiForCategories,
  type DataPoint,
  type ScoreDirection,
} from './stats';

// ─── Default thresholds (overridable via model.driftConfig) ──────────────────
export const DEFAULT_DRIFT_CONFIG: Required<DriftConfig> = {
  thresholdMode: 'fixed',
  // ค่าเริ่มต้นชั่วคราวสำหรับ KS D และ Wasserstein — จะปรับให้แม่นขึ้นใน Step 11
  ksWarning: 0.10,
  ksCritical: 0.20,
  wassersteinWarning: 0.10,
  wassersteinCritical: 0.25,
  jsWarning: 0.10,
  jsCritical: 0.20,
  missingDeltaWarning: 0.02,     // +2 จุด%
  missingDeltaCritical: 0.05,    // +5 จุด%
  minLabeledRows: 100,
  labelRelChangeWarning: 0.20,   // ±20% relative
  labelRelChangeCritical: 0.50,  // ±50% relative
  labelPValueThreshold: 0.05,
  minBadsPerBin: 5,
  giniRelDropWarning: 0.10,      // -10% relative
  giniRelDropCritical: 0.25,     // -25% relative
};

const DEFAULT_THRESHOLDS: MonitoringThresholds = {
  psi_warning: 0.10,
  psi_critical: 0.25,
  gini_min: 0.10,
  auc_min: 0.55,
  ks_min: 0.10,
  csi_features: {},
};

const STATUS_RANK: Record<DriftStatus, number> = {
  STABLE: 0,
  WARNING: 1,
  CRITICAL: 2,
};

function worstStatus(statuses: (DriftStatus | DriftSectionStatus)[]): DriftStatus {
  let worst: DriftStatus = 'STABLE';
  for (const s of statuses) {
    if (s === 'NOT_AVAILABLE') continue;
    if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  }
  return worst;
}

export function resolveDriftConfig(model: any): Required<DriftConfig> {
  const dc = (model?.driftConfig ?? {}) as DriftConfig;
  return {
    thresholdMode: dc.thresholdMode ?? DEFAULT_DRIFT_CONFIG.thresholdMode,
    ksWarning: dc.ksWarning ?? DEFAULT_DRIFT_CONFIG.ksWarning,
    ksCritical: dc.ksCritical ?? DEFAULT_DRIFT_CONFIG.ksCritical,
    wassersteinWarning: dc.wassersteinWarning ?? DEFAULT_DRIFT_CONFIG.wassersteinWarning,
    wassersteinCritical: dc.wassersteinCritical ?? DEFAULT_DRIFT_CONFIG.wassersteinCritical,
    jsWarning: dc.jsWarning ?? DEFAULT_DRIFT_CONFIG.jsWarning,
    jsCritical: dc.jsCritical ?? DEFAULT_DRIFT_CONFIG.jsCritical,
    missingDeltaWarning: dc.missingDeltaWarning ?? DEFAULT_DRIFT_CONFIG.missingDeltaWarning,
    missingDeltaCritical: dc.missingDeltaCritical ?? DEFAULT_DRIFT_CONFIG.missingDeltaCritical,
    minLabeledRows: dc.minLabeledRows ?? DEFAULT_DRIFT_CONFIG.minLabeledRows,
    labelRelChangeWarning: dc.labelRelChangeWarning ?? DEFAULT_DRIFT_CONFIG.labelRelChangeWarning,
    labelRelChangeCritical: dc.labelRelChangeCritical ?? DEFAULT_DRIFT_CONFIG.labelRelChangeCritical,
    labelPValueThreshold: dc.labelPValueThreshold ?? DEFAULT_DRIFT_CONFIG.labelPValueThreshold,
    minBadsPerBin: dc.minBadsPerBin ?? DEFAULT_DRIFT_CONFIG.minBadsPerBin,
    giniRelDropWarning: dc.giniRelDropWarning ?? DEFAULT_DRIFT_CONFIG.giniRelDropWarning,
    giniRelDropCritical: dc.giniRelDropCritical ?? DEFAULT_DRIFT_CONFIG.giniRelDropCritical,
  };
}

// ─── Statistical helpers ─────────────────────────────────────────────────────
export function linearQuantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

export function computeDistributionStats(values: number[]): DistributionStats {
  const valid = values.filter(v => Number.isFinite(v));
  const n = valid.length;
  if (n === 0) {
    return { n: 0, mean: 0, median: 0, sd: 0, iqr: 0, p5: 0, p95: 0, skewness: 0, excessKurtosis: 0 };
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const mean = valid.reduce((a, b) => a + b, 0) / n;
  const median = linearQuantile(sorted, 0.50);
  const p25 = linearQuantile(sorted, 0.25);
  const p75 = linearQuantile(sorted, 0.75);
  const iqr = p75 - p25;
  const p5 = linearQuantile(sorted, 0.05);
  const p95 = linearQuantile(sorted, 0.95);

  let m2 = 0, m3 = 0, m4 = 0;
  for (const v of valid) {
    const d = v - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  const variance = n > 1 ? m2 / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const popSd = Math.sqrt(m2 / n);
  const skewness = popSd > 1e-12 ? (m3 / n) / Math.pow(popSd, 3) : 0;
  const excessKurtosis = popSd > 1e-12 ? (m4 / n) / Math.pow(popSd, 4) - 3 : 0;

  return { n, mean, median, sd, iqr, p5, p95, skewness, excessKurtosis };
}

function pctChange(refVal: number, actVal: number): number | null {
  if (!Number.isFinite(refVal) || !Number.isFinite(actVal)) return null;
  if (Math.abs(refVal) < 1e-12) return null;
  return ((actVal - refVal) / Math.abs(refVal)) * 100;
}

export function buildDistributionProfile(refValues: number[], actValues: number[]): DistributionProfile {
  const reference = computeDistributionStats(refValues);
  const actual = computeDistributionStats(actValues);
  return {
    reference,
    actual,
    pctChange: {
      mean: pctChange(reference.mean, actual.mean),
      median: pctChange(reference.median, actual.median),
      sd: pctChange(reference.sd, actual.sd),
      iqr: pctChange(reference.iqr, actual.iqr),
      p5: pctChange(reference.p5, actual.p5),
      p95: pctChange(reference.p95, actual.p95),
      skewness: pctChange(reference.skewness, actual.skewness),
      excessKurtosis: pctChange(reference.excessKurtosis, actual.excessKurtosis),
    },
  };
}

/**
 * Two-sample Kolmogorov–Smirnov statistic D and asymptotic p-value.
 * Note: p-value is reported for informational purposes only and is NEVER used
 * to classify drift status because with large sample sizes p-value is always tiny.
 */
export function ksTwoSample(
  refValues: number[],
  actValues: number[],
  warning = DEFAULT_DRIFT_CONFIG.ksWarning,
  critical = DEFAULT_DRIFT_CONFIG.ksCritical,
): KsTwoSampleResult {
  const u = refValues.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  const v = actValues.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  const n1 = u.length;
  const n2 = v.length;
  if (n1 === 0 || n2 === 0) {
    return { d: 0, pValue: 1, status: 'STABLE', threshold: { warning, critical } };
  }

  let i = 0, j = 0, d = 0;
  while (i < n1 && j < n2) {
    const val = Math.min(u[i], v[j]);
    while (i < n1 && u[i] <= val) i++;
    while (j < n2 && v[j] <= val) j++;
    const diff = Math.abs(i / n1 - j / n2);
    if (diff > d) d = diff;
  }

  const nEff = (n1 * n2) / (n1 + n2);
  const sqrtNeff = Math.sqrt(nEff);
  const lambda = (sqrtNeff + 0.12 + 0.11 / sqrtNeff) * d;
  let pValue = 1;
  if (lambda > 0) {
    let sum = 0;
    for (let k = 1; k <= 100; k++) {
      const term = (k % 2 === 1 ? 1 : -1) * Math.exp(-2 * k * k * lambda * lambda);
      sum += term;
      if (Math.abs(term) < 1e-12) break;
    }
    pValue = Math.min(1, Math.max(0, 2 * sum));
  }

  return {
    d,
    pValue,
    status: classify(d, warning, critical),
    threshold: { warning, critical },
  };
}

function applyTransform(values: number[], transform: AnomalyTransform): number[] {
  if (transform === 'log1p') {
    return values.filter(v => Number.isFinite(v)).map(v => Math.log1p(Math.max(0, v)));
  }
  return values.filter(v => Number.isFinite(v));
}

function robustScaleFromValues(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const med = linearQuantile(sorted, 0.50);
  const absDevs = sorted.map(v => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = linearQuantile(absDevs, 0.50);
  const madScale = mad / 0.6745;
  if (madScale > 1e-12) return madScale;
  // Fallback if MAD is 0 (e.g., heavily tied discrete variable)
  const stats = computeDistributionStats(values);
  return stats.sd > 1e-12 ? stats.sd : 1;
}

/**
 * Exact 1D Wasserstein-1 (Earth Mover's) distance divided by Reference robust scale (MAD / 0.6745).
 * Computed on log1p scale when the feature specifies anomalyTransform = 'log1p'.
 */
export function wassersteinScaled(
  refValues: number[],
  actValues: number[],
  transform: AnomalyTransform = 'none',
  warning = DEFAULT_DRIFT_CONFIG.wassersteinWarning,
  critical = DEFAULT_DRIFT_CONFIG.wassersteinCritical,
): WassersteinResult {
  const u = applyTransform(refValues, transform).sort((a, b) => a - b);
  const v = applyTransform(actValues, transform).sort((a, b) => a - b);
  const n1 = u.length;
  const n2 = v.length;
  const referenceScale = robustScaleFromValues(u);
  if (n1 === 0 || n2 === 0) {
    return {
      raw: 0,
      scaled: 0,
      referenceScale,
      transform,
      status: 'STABLE',
      threshold: { warning, critical },
    };
  }

  // Merge sorted arrays to integrate |F_u(t) - F_v(t)| dt over all breakpoints
  let i = 0, j = 0, raw = 0;
  let prev = Math.min(u[0], v[0]);
  while (i < n1 || j < n2) {
    const nextU = i < n1 ? u[i] : Infinity;
    const nextV = j < n2 ? v[j] : Infinity;
    const curr = Math.min(nextU, nextV);
    if (curr > prev && Number.isFinite(curr)) {
      raw += (curr - prev) * Math.abs(i / n1 - j / n2);
      prev = curr;
    }
    while (i < n1 && u[i] <= curr) i++;
    while (j < n2 && v[j] <= curr) j++;
  }

  const scaled = raw / referenceScale;
  return {
    raw,
    scaled,
    referenceScale,
    transform,
    status: classify(scaled, warning, critical),
    threshold: { warning, critical },
  };
}

/** Standard normal two-sided p-value erfc(|z| / sqrt(2)). */
function normalTwoSidedPValue(z: number): number {
  const x = Math.abs(z);
  if (!Number.isFinite(x)) return 1;
  // Abramowitz & Stegun 7.1.26 approximation for normal CDF
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.min(1, Math.max(0, 2 * p));
}

// ─── Model & feature resolution (Rule 1: never hard-code names) ──────────────
interface ResolvedModelSpec {
  modelId: string;
  configVersion: string;
  idColumn: string;
  dateColumn: string | null;
  labelColumn: string;
  scoreColumn: string | null;
  scoreDirection: ScoreDirection;
  hasScorecard: boolean;
  registry: Record<string, FeatureDefinition>;
  scoringFeatures: string[];
  numericFeatures: string[];
  categoricalFeatures: string[];
  thresholds: MonitoringThresholds;
  driftConfig: Required<DriftConfig>;
  calibratedThresholds?: CalibratedThresholds;
}

function resolveModelSpec(model: any): ResolvedModelSpec {
  const modelId = String(model?.id ?? model?.modelId ?? 'unknown_model');
  const configVersion = String(model?.configVersion ?? model?.version ?? '1.0.0');
  const resolvedCols = resolveModelColumns(model);
  const idColumn = resolvedCols.idColumn;
  const dateColumn = resolvedCols.dateColumn;
  const labelColumn = resolvedCols.labelColumn ?? DEFAULT_LABEL_COLUMN;
  const scoreColumn = resolvedCols.scoreColumn;
  const scoreDirection: ScoreDirection =
    model?.scoreDirection === 'higher_is_riskier'
      ? 'higher_is_riskier'
      : 'higher_is_safer';

  const registry = (model?.featureRegistry ?? {}) as Record<string, FeatureDefinition>;
  const scoringFeatures: string[] = Array.isArray(model?.scoring?.features) ? model.scoring.features : [];
  const scorecard = model?.scoring?.scorecard;
  const hasScorecard = Boolean(
    model?.mode !== 'score_column' &&
    !scoreColumn &&
    scorecard && typeof scorecard === 'object' && Object.keys(scorecard).length > 0 && scoringFeatures.length > 0,
  );

  const specialCols = new Set<string>([idColumn, labelColumn]);
  if (dateColumn) specialCols.add(dateColumn);
  if (scoreColumn) specialCols.add(scoreColumn);

  const numericSet = new Set<string>();
  const categoricalSet = new Set<string>();
  for (const [key, def] of Object.entries(registry)) {
    if (specialCols.has(key) || specialCols.has(def.columnName)) continue;
    if (def.monitoringEnabled === false) continue;
    if (def.dataType === 'numeric') numericSet.add(key);
    else if (def.dataType === 'categorical') categoricalSet.add(key);
  }
  for (const f of scoringFeatures) {
    if (!specialCols.has(f) && !categoricalSet.has(f)) numericSet.add(f);
  }

  const thresholds: MonitoringThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(model?.thresholds ?? {}),
    csi_features: {
      ...(DEFAULT_THRESHOLDS.csi_features ?? {}),
      ...(model?.thresholds?.csi_features ?? {}),
    },
  };

  return {
    modelId,
    configVersion,
    idColumn,
    dateColumn,
    labelColumn,
    scoreColumn,
    scoreDirection,
    hasScorecard,
    registry,
    scoringFeatures,
    numericFeatures: [...numericSet],
    categoricalFeatures: [...categoricalSet],
    thresholds,
    driftConfig: resolveDriftConfig(model),
    calibratedThresholds: model?.calibratedThresholds ?? model?.baseline?.calibratedThresholds,
  };
}

const isBlankCell = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

export interface BuildDriftReportInput {
  /** Official CleanRows after validation (and after user excludedRows). */
  cleanRows: CleanRow[];
  /** Raw rows before validation — required for section (b) missing-as-a-feature. */
  rawRows?: Record<string, unknown>[];
  /** Pre-computed official DriftResult from drift.ts so PSI/CSI is never recomputed. */
  driftResult?: DriftResult | null;
  /** Pre-computed scores for cleanRows (if omitted, computed when scorecard or scoreColumn exists). */
  actualScores?: number[];
}

export function buildDriftReport(
  reference: ReferenceProfile,
  model: any,
  input: BuildDriftReportInput,
): DriftReport {
  const spec = resolveModelSpec(model);
  const { cleanRows, rawRows } = input;
  const dc = spec.driftConfig;

  // Build per-feature actual numeric arrays from cleanRows
  const actualFeatures: Record<string, number[]> = {};
  for (const f of spec.numericFeatures) {
    actualFeatures[f] = cleanRows
      .map(r => r.values[f])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  }

  // Build per-feature actual categorical arrays from cleanRows
  const actualCategories: Record<string, string[]> = {};
  for (const f of spec.categoricalFeatures) {
    actualCategories[f] = cleanRows
      .map(r => r.categories?.[f])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
  }

  // Determine whether scores exist on both Reference and actual data
  let actualScores: number[] = [];
  let hasActualScores = false;
  if (Array.isArray(input.actualScores)) {
    actualScores = input.actualScores.filter(v => Number.isFinite(v));
    hasActualScores = actualScores.length > 0;
  } else if (spec.scoreColumn) {
    const col = spec.scoreColumn;
    actualScores = cleanRows
      .map(r => {
        const v = r.values[col];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        const raw = rawRows?.[r.row - 1]?.[col];
        if (raw === null || raw === undefined || String(raw).trim() === '') return NaN;
        return Number(raw);
      })
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    hasActualScores = actualScores.length > 0;
  } else if (spec.hasScorecard) {
    actualScores = cleanRows.map(r => calculateAScore(model.scoring, r.values));
    hasActualScores = actualScores.length > 0;
  }
  const hasRefScores = Boolean(reference.hasScores && reference.scores.length > 0);
  const scoreAvailable = hasRefScores && hasActualScores;

  const driftOpts = {
    labelColumn: spec.labelColumn,
    scoreColumn: spec.scoreColumn,
    idColumn: spec.idColumn,
    dateColumn: spec.dateColumn,
    actualCategories,
  };

  // Reuse PSI/CSI from drift.ts (only call runDriftDetection if caller didn't pass driftResult)
  const driftResult: DriftResult =
    input.driftResult ??
    runDriftDetection(
      reference,
      scoreAvailable ? actualScores : [],
      actualFeatures,
      spec.registry,
      spec.thresholds,
      driftOpts,
    );

  // ── (a) Covariate Drift ───────────────────────────────────────────────────
  const calibrated = spec.calibratedThresholds;
  const thresholdMode = spec.driftConfig.thresholdMode;
  const nUpload = input.cleanRows.length;
  const nearestN = calibrated?.sizes ? getNearestSize(calibrated.sizes, nUpload) : null;
  const calThr = nearestN !== null ? (calibrated?.bySize?.[nearestN] ?? (calibrated?.bySize as any)?.[String(nearestN)]) : undefined;

  const covariateFeatures: Record<string, CovariateFeatureReport> = {};
  for (const key of spec.numericFeatures) {
    const def = spec.registry[key];
    const displayName =
      spec.thresholds.csi_features?.[key]?.label || def?.displayName || key;
    const refVals = reference.features[key] ?? [];
    const actVals = actualFeatures[key] ?? [];
    const csiEntry: StabilityResult | null = driftResult.csi[key] ?? null;

    if (refVals.length === 0 || actVals.length === 0) {
      covariateFeatures[key] = {
        key,
        displayName,
        kind: 'feature',
        status: 'NOT_AVAILABLE',
        statusFixed: 'NOT_AVAILABLE',
        statusCalibrated: 'NOT_AVAILABLE',
        reason:
          refVals.length === 0
            ? `ไม่มีตัวแปร "${displayName}" ใน Reference Dataset`
            : `ไม่มีข้อมูลตัวแปร "${displayName}" ในชุดข้อมูลใหม่`,
        psiOrCsi: null,
        distributionProfile: null,
        ks: null,
        wasserstein: null,
      };
      continue;
    }

    const transform: AnomalyTransform = def?.anomalyTransform ?? 'none';
    const distributionProfile = buildDistributionProfile(refVals, actVals);
    const ks = ksTwoSample(refVals, actVals, dc.ksWarning, dc.ksCritical);
    const wasserstein = wassersteinScaled(
      refVals,
      actVals,
      transform,
      dc.wassersteinWarning,
      dc.wassersteinCritical,
    );

    const fixedCsiWarn = spec.thresholds.csi_features?.[key]?.threshold ?? def?.csiThreshold ?? 0.10;
    const fixedCsiCrit = Math.max(spec.thresholds.psi_critical, fixedCsiWarn);
    const fixedKsWarn = dc.ksWarning;
    const fixedKsCrit = dc.ksCritical;
    const fixedWassWarn = dc.wassersteinWarning;
    const fixedWassCrit = dc.wassersteinCritical;

    const calCsiWarn = calThr?.csi?.[key]?.warning ?? fixedCsiWarn;
    const calCsiCrit = calThr?.csi?.[key]?.critical ?? fixedCsiCrit;
    const calKsWarn = calThr?.ks?.[key]?.warning ?? fixedKsWarn;
    const calKsCrit = calThr?.ks?.[key]?.critical ?? fixedKsCrit;
    const calWassWarn = calThr?.wasserstein?.[key]?.warning ?? fixedWassWarn;
    const calWassCrit = calThr?.wasserstein?.[key]?.critical ?? fixedWassCrit;

    // Fixed mode: status decided from CSI only. KS and Wasserstein are informational only.
    let fStatusFixed: DriftStatus = 'STABLE';
    if (csiEntry && csiEntry.status !== 'NOT_AVAILABLE') {
      fStatusFixed = classify(csiEntry.value, fixedCsiWarn, fixedCsiCrit);
    }

    const calStatuses: DriftStatus[] = [
      classify(ks.d, calKsWarn, calKsCrit),
      classify(wasserstein.scaled, calWassWarn, calWassCrit),
    ];
    if (csiEntry && csiEntry.status !== 'NOT_AVAILABLE') {
      calStatuses.push(classify(csiEntry.value, calCsiWarn, calCsiCrit));
    }
    const fStatusCalibrated = worstStatus(calStatuses);

    const fStatus = thresholdMode === 'calibrated' ? fStatusCalibrated : fStatusFixed;

    const triggeredMetrics: string[] = [];
    if (csiEntry && csiEntry.status !== 'STABLE' && csiEntry.status !== 'NOT_AVAILABLE') {
      triggeredMetrics.push(`CSI=${csiEntry.value.toFixed(4)} (${csiEntry.status})`);
    }
    if (ks.status !== 'STABLE') {
      triggeredMetrics.push(`KS D=${ks.d.toFixed(4)} (${ks.status})`);
    }
    if (wasserstein.status !== 'STABLE') {
      triggeredMetrics.push(`Wasserstein=${wasserstein.scaled.toFixed(4)} (${wasserstein.status})`);
    }

    covariateFeatures[key] = {
      key,
      displayName,
      kind: 'feature',
      dataType: 'numeric',
      status: fStatus,
      statusFixed: fStatusFixed,
      statusCalibrated: fStatusCalibrated,
      reason:
        triggeredMetrics.length > 0
          ? `พบการเลื่อนของการกระจายใน "${displayName}": ${triggeredMetrics.join(', ')}`
          : `การกระจายของ "${displayName}" ปกติ (CSI=${(csiEntry?.value ?? 0).toFixed(4)}, KS D=${ks.d.toFixed(4)}, Wasserstein=${wasserstein.scaled.toFixed(4)})`,
      psiOrCsi: csiEntry,
      distributionProfile,
      ks,
      wasserstein,
    };
  }

  for (const key of spec.categoricalFeatures) {
    const def = spec.registry[key];
    const displayName =
      spec.thresholds.csi_features?.[key]?.label || def?.displayName || key;
    const refCatVals = (reference.categoricalFeatures?.[key] ?? []).filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    const actCatVals = actualCategories[key] ?? [];
    const baseCats = reference.categorySpecs?.[key]?.categories ?? [];
    let csiEntry: StabilityResult | null = driftResult.csi[key] ?? null;

    if (refCatVals.length === 0 || actCatVals.length === 0) {
      covariateFeatures[key] = {
        key,
        displayName,
        kind: 'feature',
        dataType: 'categorical',
        status: 'NOT_AVAILABLE',
        statusFixed: 'NOT_AVAILABLE',
        statusCalibrated: 'NOT_AVAILABLE',
        reason:
          refCatVals.length === 0
            ? `ไม่มีตัวแปร "${displayName}" ใน Reference Dataset`
            : `ไม่มีข้อมูลตัวแปร "${displayName}" ในชุดข้อมูลใหม่`,
        psiOrCsi: null,
        distributionProfile: null,
        ks: null,
        wasserstein: null,
        chiSquare: null,
        jensenShannon: null,
      };
      continue;
    }

    const catPsi = psiForCategories(refCatVals, actCatVals, baseCats);
    if (!csiEntry) {
      const warnThr = spec.thresholds.csi_features?.[key]?.threshold ?? def?.csiThreshold ?? 0.10;
      const critThr = Math.max(spec.thresholds.psi_critical, warnThr);
      csiEntry = {
        value: catPsi.value,
        status: classify(catPsi.value, warnThr, critThr),
        threshold: { warning: warnThr, critical: critThr },
        bins: catPsi.bins.map((b, i) => ({ label: catPsi.labels[i] ?? `Cat ${i + 1}`, ...b })),
      };
    }

    const expectedCounts = catPsi.bins.map(b => b.expectedCount);
    const actualCounts = catPsi.bins.map(b => b.actualCount);
    const chiSquare = chiSquareTwoSample(expectedCounts, actualCounts);
    const jsRaw = jensenShannonDistance(expectedCounts, actualCounts);
    const jensenShannon: JensenShannonResult = {
      distance: jsRaw.distance,
      divergence: jsRaw.divergence,
      status: classify(jsRaw.distance, dc.jsWarning, dc.jsCritical),
      threshold: { warning: dc.jsWarning, critical: dc.jsCritical },
    };

    const categories: CategoryProportionEntry[] = catPsi.bins.map((b, idx) => ({
      category: catPsi.categories[idx],
      label: catPsi.labels[idx],
      referenceCount: b.expectedCount,
      referencePct: b.expectedPct,
      actualCount: b.actualCount,
      actualPct: b.actualPct,
      deltaPct: b.actualPct - b.expectedPct,
    }));

    const zeroStats = computeDistributionStats([]);
    const distributionProfile: DistributionProfile = {
      reference: { ...zeroStats, n: refCatVals.length },
      actual: { ...zeroStats, n: actCatVals.length },
      pctChange: {
        mean: null,
        median: null,
        sd: null,
        iqr: null,
        p5: null,
        p95: null,
        skewness: null,
        excessKurtosis: null,
      },
      categories,
    };

    const fixedCsiWarn = spec.thresholds.csi_features?.[key]?.threshold ?? def?.csiThreshold ?? 0.10;
    const fixedCsiCrit = Math.max(spec.thresholds.psi_critical, fixedCsiWarn);
    const fixedJsWarn = dc.jsWarning;
    const fixedJsCrit = dc.jsCritical;

    const calCsiWarn = calThr?.csi?.[key]?.warning ?? fixedCsiWarn;
    const calCsiCrit = calThr?.csi?.[key]?.critical ?? fixedCsiCrit;
    const calJsWarn = calThr?.js?.[key]?.warning ?? fixedJsWarn;
    const calJsCrit = calThr?.js?.[key]?.critical ?? fixedJsCrit;

    // Fixed mode: status decided from CSI only. JS is informational only.
    let fStatusFixed: DriftStatus = 'STABLE';
    if (csiEntry && csiEntry.status !== 'NOT_AVAILABLE') {
      fStatusFixed = classify(catPsi.value, fixedCsiWarn, fixedCsiCrit);
    }

    const calStatuses: DriftStatus[] = [
      classify(jsRaw.distance, calJsWarn, calJsCrit),
    ];
    if (csiEntry && csiEntry.status !== 'NOT_AVAILABLE') {
      calStatuses.push(classify(catPsi.value, calCsiWarn, calCsiCrit));
    }
    const fStatusCalibrated = worstStatus(calStatuses);

    const fStatus = thresholdMode === 'calibrated' ? fStatusCalibrated : fStatusFixed;

    const triggeredMetrics: string[] = [];
    if (csiEntry && csiEntry.status !== 'STABLE' && csiEntry.status !== 'NOT_AVAILABLE') {
      triggeredMetrics.push(`CSI=${csiEntry.value.toFixed(4)} (${csiEntry.status})`);
    }
    if (jensenShannon.status !== 'STABLE') {
      triggeredMetrics.push(`JS=${jensenShannon.distance.toFixed(4)} (${jensenShannon.status})`);
    }

    covariateFeatures[key] = {
      key,
      displayName,
      kind: 'feature',
      dataType: 'categorical',
      status: fStatus,
      statusFixed: fStatusFixed,
      statusCalibrated: fStatusCalibrated,
      reason:
        triggeredMetrics.length > 0
          ? `พบการเลื่อนของสัดส่วนหมวดใน "${displayName}": ${triggeredMetrics.join(', ')}, χ²=${chiSquare.statistic.toFixed(2)} (p=${chiSquare.pValue.toFixed(4)})`
          : `สัดส่วนหมวดของ "${displayName}" ปกติ (CSI=${(csiEntry?.value ?? 0).toFixed(4)}, JS=${jensenShannon.distance.toFixed(4)}, χ²=${chiSquare.statistic.toFixed(2)})`,
      psiOrCsi: csiEntry,
      distributionProfile,
      ks: null,
      wasserstein: null,
      chiSquare,
      jensenShannon,
    };
  }

  let scoreCovariate: CovariateFeatureReport;
  if (!scoreAvailable) {
    scoreCovariate = {
      key: 'score',
      displayName: spec.scoreColumn ?? 'Score',
      kind: 'score',
      status: 'NOT_AVAILABLE',
      statusFixed: 'NOT_AVAILABLE',
      statusCalibrated: 'NOT_AVAILABLE',
      reason: 'โมเดลไม่มีสกอร์การ์ดหรือคอลัมน์คะแนน จึงไม่สามารถคำนวณ Drift ของคะแนนรวมได้',
      psiOrCsi: null,
      distributionProfile: null,
      ks: null,
      wasserstein: null,
    };
  } else {
    const psiEntry = driftResult.psi;
    const dist = buildDistributionProfile(reference.scores, actualScores);
    const ks = ksTwoSample(reference.scores, actualScores, dc.ksWarning, dc.ksCritical);
    const wasserstein = wassersteinScaled(
      reference.scores,
      actualScores,
      'none',
      dc.wassersteinWarning,
      dc.wassersteinCritical,
    );

    const fixedPsiWarn = spec.thresholds.psi_warning;
    const fixedPsiCrit = spec.thresholds.psi_critical;
    const fixedKsWarn = dc.ksWarning;
    const fixedKsCrit = dc.ksCritical;
    const fixedWassWarn = dc.wassersteinWarning;
    const fixedWassCrit = dc.wassersteinCritical;

    const calPsiWarn = calThr?.psi?.warning ?? fixedPsiWarn;
    const calPsiCrit = calThr?.psi?.critical ?? fixedPsiCrit;
    const calKsWarn = calThr?.ks?.score?.warning ?? fixedKsWarn;
    const calKsCrit = calThr?.ks?.score?.critical ?? fixedKsCrit;
    const calWassWarn = calThr?.wasserstein?.score?.warning ?? fixedWassWarn;
    const calWassCrit = calThr?.wasserstein?.score?.critical ?? fixedWassCrit;

    // Fixed mode: status decided from PSI only. KS and Wasserstein are informational only.
    let sStatusFixed: DriftStatus = 'STABLE';
    if (psiEntry.status !== 'NOT_AVAILABLE') {
      sStatusFixed = classify(psiEntry.value, fixedPsiWarn, fixedPsiCrit);
    }

    const calStatuses: DriftStatus[] = [];
    if (psiEntry.status !== 'NOT_AVAILABLE') {
      calStatuses.push(classify(psiEntry.value, calPsiWarn, calPsiCrit));
    }
    const sStatusCalibrated = calStatuses.length > 0 ? worstStatus(calStatuses) : 'STABLE';

    const sStatus = thresholdMode === 'calibrated' ? sStatusCalibrated : sStatusFixed;

    const parts: string[] = [];
    if (psiEntry.status !== 'STABLE' && psiEntry.status !== 'NOT_AVAILABLE') parts.push(`PSI=${psiEntry.value.toFixed(4)} (${psiEntry.status})`);
    if (ks.status !== 'STABLE') parts.push(`KS D=${ks.d.toFixed(4)} (${ks.status})`);
    if (wasserstein.status !== 'STABLE') parts.push(`Wasserstein=${wasserstein.scaled.toFixed(4)} (${wasserstein.status})`);
    scoreCovariate = {
      key: 'score',
      displayName: spec.scoreColumn ?? 'Model Score',
      kind: 'score',
      status: sStatus,
      statusFixed: sStatusFixed,
      statusCalibrated: sStatusCalibrated,
      reason:
        parts.length > 0
          ? `คะแนนรวมมีการเลื่อนของการกระจาย: ${parts.join(', ')}`
          : `คะแนนรวมคงที่ (PSI=${psiEntry.value.toFixed(4)}, KS D=${ks.d.toFixed(4)}, Wasserstein=${wasserstein.scaled.toFixed(4)})`,
      psiOrCsi: psiEntry,
      distributionProfile: dist,
      ks,
      wasserstein,
    };
  }

  const availableCovariatesFixed = [
    ...Object.values(covariateFeatures).map(c => c.statusFixed ?? c.status),
    scoreCovariate.statusFixed ?? scoreCovariate.status,
  ].filter((s): s is DriftStatus => s !== 'NOT_AVAILABLE');
  const covariateStatusFixed: DriftSectionStatus =
    availableCovariatesFixed.length === 0 ? 'NOT_AVAILABLE' : worstStatus(availableCovariatesFixed);

  const availableCovariatesCalibrated = [
    ...Object.values(covariateFeatures).map(c => c.statusCalibrated ?? c.status),
    scoreCovariate.statusCalibrated ?? scoreCovariate.status,
  ].filter((s): s is DriftStatus => s !== 'NOT_AVAILABLE');
  const covariateStatusCalibrated: DriftSectionStatus =
    availableCovariatesCalibrated.length === 0 ? 'NOT_AVAILABLE' : worstStatus(availableCovariatesCalibrated);

  const covariateStatus: DriftSectionStatus =
    thresholdMode === 'calibrated' ? covariateStatusCalibrated : covariateStatusFixed;

  const availableCovariates = [
    ...Object.values(covariateFeatures),
    scoreCovariate,
  ].filter(c => c.status !== 'NOT_AVAILABLE');
  const driftedCovNames = availableCovariates
    .filter(c => c.status === 'WARNING' || c.status === 'CRITICAL')
    .map(c => `${c.displayName} (${c.status})`);
  const covariateReason =
    covariateStatus === 'NOT_AVAILABLE'
      ? 'ไม่มีตัวแปรที่สามารถคำนวณ Covariate Drift ได้'
      : driftedCovNames.length > 0
        ? `พบ Covariate Drift ใน: ${driftedCovNames.join(', ')}`
        : 'ไม่พบการเลื่อนของการกระจายในตัวแปรและคะแนนรวม';

  // ── (b) Missing-as-a-Feature ──────────────────────────────────────────────
  const missingFeatures: Record<string, MissingFeatureReport> = {};
  let missingStatus: DriftSectionStatus = 'STABLE';
  let missingReason = 'สัดส่วนค่าว่างของทุกตัวแปรอยู่ในเกณฑ์ปกติ';

  if (!rawRows || rawRows.length === 0) {
    missingStatus = 'NOT_AVAILABLE';
    missingReason = 'ไม่มีข้อมูลแถวดิบก่อน Validation จึงไม่สามารถคำนวณสัดส่วนค่าว่างเปรียบเทียบได้';
  } else {
    const rawTotal = rawRows.length;
    const cleanTotal = cleanRows.length;
    for (const key of [...spec.numericFeatures, ...spec.categoricalFeatures]) {
      const def = spec.registry[key];
      const col = def?.columnName || key;
      const displayName = def?.displayName || key;
      const refMissRate = reference.missingRate?.[col] ?? reference.missingRate?.[key] ?? 0;
      let actualMissingCount = 0;
      for (const r of rawRows) {
        if (isBlankCell(r[col])) actualMissingCount++;
      }
      const actualMissingRate = rawTotal > 0 ? actualMissingCount / rawTotal : 0;
      const deltaMissingRate = actualMissingRate - refMissRate;
      const deltaPercentagePoints = deltaMissingRate * 100;

      let imputedCount = 0;
      for (const r of cleanRows) {
        if (r.imputed?.includes(key)) imputedCount++;
      }
      const imputedRate = cleanTotal > 0 ? imputedCount / cleanTotal : 0;

      const fMissStatus = classify(
        Math.max(0, deltaMissingRate),
        dc.missingDeltaWarning,
        dc.missingDeltaCritical,
      );
      missingFeatures[key] = {
        key,
        displayName,
        referenceMissingRate: refMissRate,
        actualMissingRate,
        deltaMissingRate,
        deltaPercentagePoints,
        actualMissingCount,
        imputedCount,
        imputedRate,
        status: fMissStatus,
        reason:
          fMissStatus !== 'STABLE'
            ? `ค่าว่างของ "${displayName}" เพิ่มขึ้น +${deltaPercentagePoints.toFixed(2)} จุด% (Reference ${(refMissRate * 100).toFixed(2)}% → ใหม่ ${(actualMissingRate * 100).toFixed(2)}%, เติมค่า ${(imputedRate * 100).toFixed(2)}%)`
            : `ค่าว่างของ "${displayName}" ปกติ (Reference ${(refMissRate * 100).toFixed(2)}% → ใหม่ ${(actualMissingRate * 100).toFixed(2)}%)`,
      };
    }

    missingStatus = worstStatus(Object.values(missingFeatures).map(m => m.status));
    const triggeredMissing = Object.values(missingFeatures)
      .filter(m => m.status !== 'STABLE')
      .map(m => `${m.displayName} (+${m.deltaPercentagePoints.toFixed(1)} จุด%)`);
    if (triggeredMissing.length > 0) {
      missingReason = `พบสัดส่วนค่าว่างเพิ่มขึ้นเกินเกณฑ์ใน: ${triggeredMissing.join(', ')}`;
    }
  }

  // ── (c) Label Drift, P(y) ─────────────────────────────────────────────────
  const refValidLabels = reference.labels.filter((l): l is 0 | 1 => l === 0 || l === 1);
  const actLabeledRows = cleanRows.filter(r => r.label === 0 || r.label === 1);

  let labelSection: DriftReport['label'];
  if (!reference.hasLabels || refValidLabels.length === 0) {
    labelSection = {
      status: 'NOT_AVAILABLE',
      reason: `Reference Dataset ไม่มีข้อมูลคอลัมน์ผลลัพธ์ (${spec.labelColumn})`,
      metrics: null,
    };
  } else if (actLabeledRows.length < dc.minLabeledRows) {
    labelSection = {
      status: 'NOT_AVAILABLE',
      reason:
        actLabeledRows.length === 0
          ? `ข้อมูลใหม่ไม่มีคอลัมน์ผลลัพธ์ (${spec.labelColumn}) หรือค่าว่างทั้งหมด`
          : `ข้อมูลใหม่มีแถวที่มีผลลัพธ์ (${spec.labelColumn}) เพียง ${actLabeledRows.length} แถว ซึ่งน้อยกว่าเกณฑ์ขั้นต่ำ ${dc.minLabeledRows} แถว`,
      metrics: null,
    };
  } else {
    const refLabeledCount = refValidLabels.length;
    const refBadCount = refValidLabels.filter(l => l === 1).length;
    const refBadRate = refBadCount / refLabeledCount;

    const actLabeledCount = actLabeledRows.length;
    const actBadCount = actLabeledRows.filter(r => r.label === 1).length;
    const actBadRate = actBadCount / actLabeledCount;

    const absoluteChange = actBadRate - refBadRate;
    const relativeChange = refBadRate > 0 ? absoluteChange / refBadRate : null;

    const pooled = (refBadCount + actBadCount) / (refLabeledCount + actLabeledCount);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / refLabeledCount + 1 / actLabeledCount));
    const zStat = se > 1e-12 ? (actBadRate - refBadRate) / se : 0;
    const pValue = se > 1e-12 ? normalTwoSidedPValue(zStat) : 1;

    let lStatusFixed: DriftStatus = 'STABLE';
    const absRel = relativeChange !== null ? Math.abs(relativeChange) : 0;
    if (relativeChange !== null && pValue < dc.labelPValueThreshold) {
      if (absRel >= dc.labelRelChangeCritical) lStatusFixed = 'CRITICAL';
      else if (absRel >= dc.labelRelChangeWarning) lStatusFixed = 'WARNING';
    }

    const calLabel = calThr?.label;
    const calLabelWarn = calLabel?.badRateRelChange?.warning ?? dc.labelRelChangeWarning;
    const calLabelCrit = calLabel?.badRateRelChange?.critical ?? dc.labelRelChangeCritical;

    let lStatusCalibrated: DriftStatus = 'STABLE';
    if (relativeChange !== null) {
      if (absRel >= calLabelCrit) lStatusCalibrated = 'CRITICAL';
      else if (absRel >= calLabelWarn) lStatusCalibrated = 'WARNING';
    }

    const lStatus: DriftStatus = thresholdMode === 'calibrated' ? lStatusCalibrated : lStatusFixed;

    const relPctStr = relativeChange !== null ? `${(relativeChange * 100).toFixed(1)}%` : 'N/A';
    const lReason =
      lStatus !== 'STABLE'
        ? `อัตราผิดนัดชำระหนี้ (Bad Rate) เปลี่ยนแปลงอย่างมีนัยสำคัญ: Reference ${(refBadRate * 100).toFixed(2)}% → ใหม่ ${(actBadRate * 100).toFixed(2)}% (เปลี่ยนแปลง ${relPctStr}, p=${pValue.toFixed(4)})`
        : `อัตราผิดนัดชำระหนี้ (Bad Rate) อยู่ในเกณฑ์ปกติ: Reference ${(refBadRate * 100).toFixed(2)}% → ใหม่ ${(actBadRate * 100).toFixed(2)}% (เปลี่ยนแปลง ${relPctStr}, p=${pValue.toFixed(4)})`;

    const metrics: LabelDriftMetrics = {
      referenceLabeledRows: refLabeledCount,
      referenceBadCount: refBadCount,
      referenceBadRate: refBadRate,
      actualLabeledRows: actLabeledCount,
      actualBadCount: actBadCount,
      actualBadRate: actBadRate,
      absoluteChange,
      relativeChange,
      zStat,
      pValue,
      threshold: {
        minLabeledRows: dc.minLabeledRows,
        relChangeWarning: dc.labelRelChangeWarning,
        relChangeCritical: dc.labelRelChangeCritical,
        pValueThreshold: dc.labelPValueThreshold,
      },
    };
    labelSection = { status: lStatus, reason: lReason, metrics };
  }

  // ── (d) Concept Drift, P(y|X) ─────────────────────────────────────────────
  let conceptSection: DriftReport['concept'];
  if (!reference.hasLabels || refValidLabels.length === 0) {
    conceptSection = {
      status: 'NOT_AVAILABLE',
      reason: `Reference Dataset ไม่มีข้อมูลคอลัมน์ผลลัพธ์ (${spec.labelColumn}) จึงไม่สามารถตรวจ Concept Drift ได้`,
      metrics: null,
    };
  } else if (actLabeledRows.length < dc.minLabeledRows) {
    conceptSection = {
      status: 'NOT_AVAILABLE',
      reason:
        actLabeledRows.length === 0
          ? `ข้อมูลใหม่ไม่มีคอลัมน์ผลลัพธ์ (${spec.labelColumn}) จึงไม่สามารถตรวจ Concept Drift ได้`
          : `ข้อมูลใหม่มีแถวที่มีผลลัพธ์ (${spec.labelColumn}) เพียง ${actLabeledRows.length} แถว (< ${dc.minLabeledRows} แถว) จึงยังไม่สามารถตรวจ Concept Drift ได้`,
      metrics: null,
    };
  } else {
    // 1. Per-bin bad rate for each feature using the same bins as CSI (computed from Reference rows, never config bad_rate)
    const csiFeatureSpecs = resolveCsiFeatures(spec.registry, spec.thresholds, reference, driftOpts);
    const conceptFeatures: Record<string, ConceptFeatureReport> = {};

    for (const f of csiFeatureSpecs) {
      if (f.skipped) continue;
      if (f.dataType === 'categorical') {
        const refCatVals = reference.categoricalFeatures?.[f.key] ?? [];
        if (refCatVals.length === 0) continue;
        const baseCats = f.categories ?? reference.categorySpecs?.[f.key]?.categories ?? [];
        const orderedCats: string[] = [];
        const seenCat = new Set<string>();
        const addCat = (c: string) => {
          if (!seenCat.has(c)) {
            seenCat.add(c);
            orderedCats.push(c);
          }
        };
        for (const c of baseCats) {
          if (c !== '__OTHER__' && c !== '__UNSEEN__') addCat(c);
        }
        for (const c of refCatVals) {
          if (c && c !== '__OTHER__' && c !== '__UNSEEN__') addCat(c);
        }
        for (const r of actLabeledRows) {
          const c = r.categories?.[f.key];
          if (c && c !== '__OTHER__' && c !== '__UNSEEN__') addCat(c);
        }
        if (
          baseCats.includes('__OTHER__') ||
          refCatVals.includes('__OTHER__') ||
          actLabeledRows.some(r => r.categories?.[f.key] === '__OTHER__')
        ) {
          addCat('__OTHER__');
        }
        if (
          baseCats.includes('__UNSEEN__') ||
          refCatVals.includes('__UNSEEN__') ||
          actLabeledRows.some(r => r.categories?.[f.key] === '__UNSEEN__')
        ) {
          addCat('__UNSEEN__');
        }

        const catIdxMap = new Map<string, number>(orderedCats.map((c, i) => [c, i]));
        const numBins = orderedCats.length;
        const refTotalByBin = new Array<number>(numBins).fill(0);
        const refBadsByBin = new Array<number>(numBins).fill(0);
        for (let i = 0; i < refCatVals.length; i++) {
          const cat = refCatVals[i];
          const lbl = reference.labels[i];
          if (!cat || (lbl !== 0 && lbl !== 1)) continue;
          const bIdx = catIdxMap.get(cat);
          if (bIdx === undefined) continue;
          refTotalByBin[bIdx]++;
          if (lbl === 1) refBadsByBin[bIdx]++;
        }

        const actTotalByBin = new Array<number>(numBins).fill(0);
        const actBadsByBin = new Array<number>(numBins).fill(0);
        for (const r of actLabeledRows) {
          const cat = r.categories?.[f.key];
          if (!cat) continue;
          const bIdx = catIdxMap.get(cat);
          if (bIdx === undefined) continue;
          actTotalByBin[bIdx]++;
          if (r.label === 1) actBadsByBin[bIdx]++;
        }

        const bins: ConceptBinBadRate[] = [];
        let maxBinRatio: number | null = null;
        for (let b = 0; b < numBins; b++) {
          const rTot = refTotalByBin[b];
          const rBad = refBadsByBin[b];
          const aTot = actTotalByBin[b];
          const aBad = actBadsByBin[b];
          const rRate = rTot > 0 ? rBad / rTot : null;
          const aRate = aTot > 0 ? aBad / aTot : null;
          const ratio = rRate !== null && rRate > 0 && aRate !== null ? aRate / rRate : null;
          const deltaBadRate = rRate !== null && aRate !== null ? aRate - rRate : null;
          const lowSample = rBad < dc.minBadsPerBin || aBad < dc.minBadsPerBin;
          if (!lowSample && ratio !== null) {
            const deviation = Math.max(ratio, ratio > 0 ? 1 / ratio : 0);
            if (maxBinRatio === null || deviation > maxBinRatio) maxBinRatio = deviation;
          }
          bins.push({
            label: formatCategoryDisplayLabel(orderedCats[b]),
            referenceTotal: rTot,
            referenceBads: rBad,
            referenceBadRate: rRate,
            actualTotal: aTot,
            actualBads: aBad,
            actualBadRate: aRate,
            ratio,
            deltaBadRate,
            lowSample,
            ...(lowSample ? { note: 'ข้อมูลน้อย ไม่ใช้ตัดสินสถานะ' } : {}),
          });
        }

        let fConceptStatus: DriftStatus = 'STABLE';
        if (thresholdMode === 'calibrated' && calThr?.concept?.worstBinRatio && maxBinRatio !== null) {
          if (maxBinRatio >= calThr.concept.worstBinRatio.critical) {
            fConceptStatus = 'CRITICAL';
          } else if (maxBinRatio >= calThr.concept.worstBinRatio.warning) {
            fConceptStatus = 'WARNING';
          }
        }

        conceptFeatures[f.key] = {
          key: f.key,
          displayName: f.displayName,
          bins,
          maxBinRatio,
          status: fConceptStatus,
          reason:
            fConceptStatus !== 'STABLE'
              ? `สัดส่วน Bad Rate รายหมวดของ "${f.displayName}" เบี่ยงเบนเกินเกณฑ์ (${maxBinRatio?.toFixed(2)}x)`
              : `คำนวณ Bad Rate รายหมวดของ "${f.displayName}" เทียบกับ Reference เรียบร้อยแล้ว`,
        };
        continue;
      }
      if (!reference.features[f.key]) continue;
      const refVals = reference.features[f.key];
      const numBins = f.bins.length + 1;
      const labels = f.labels.length === numBins ? f.labels : defaultBinLabels(f.bins);

      const refTotalByBin = new Array<number>(numBins).fill(0);
      const refBadsByBin = new Array<number>(numBins).fill(0);
      for (let i = 0; i < refVals.length; i++) {
        const v = refVals[i];
        const lbl = reference.labels[i];
        if (!Number.isFinite(v) || (lbl !== 0 && lbl !== 1)) continue;
        const bIdx = getBinIndex(v, f.bins);
        refTotalByBin[bIdx]++;
        if (lbl === 1) refBadsByBin[bIdx]++;
      }

      const actTotalByBin = new Array<number>(numBins).fill(0);
      const actBadsByBin = new Array<number>(numBins).fill(0);
      for (const r of actLabeledRows) {
        const v = r.values[f.key];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        const bIdx = getBinIndex(v, f.bins);
        actTotalByBin[bIdx]++;
        if (r.label === 1) actBadsByBin[bIdx]++;
      }

      const bins: ConceptBinBadRate[] = [];
      let maxBinRatio: number | null = null;
      for (let b = 0; b < numBins; b++) {
        const rTot = refTotalByBin[b];
        const rBad = refBadsByBin[b];
        const aTot = actTotalByBin[b];
        const aBad = actBadsByBin[b];
        const rRate = rTot > 0 ? rBad / rTot : null;
        const aRate = aTot > 0 ? aBad / aTot : null;
        const ratio = rRate !== null && rRate > 0 && aRate !== null ? aRate / rRate : null;
        const deltaBadRate = rRate !== null && aRate !== null ? aRate - rRate : null;
        const lowSample = rBad < dc.minBadsPerBin || aBad < dc.minBadsPerBin;
        if (!lowSample && ratio !== null) {
          const deviation = Math.max(ratio, ratio > 0 ? 1 / ratio : 0);
          if (maxBinRatio === null || deviation > maxBinRatio) maxBinRatio = deviation;
        }
        bins.push({
          label: labels[b] ?? `Bin ${b + 1}`,
          referenceTotal: rTot,
          referenceBads: rBad,
          referenceBadRate: rRate,
          actualTotal: aTot,
          actualBads: aBad,
          actualBadRate: aRate,
          ratio,
          deltaBadRate,
          lowSample,
          ...(lowSample ? { note: 'ข้อมูลน้อย ไม่ใช้ตัดสินสถานะ' } : {}),
        });
      }

      let fConceptStatus: DriftStatus = 'STABLE';
      if (thresholdMode === 'calibrated' && calThr?.concept?.worstBinRatio && maxBinRatio !== null) {
        if (maxBinRatio >= calThr.concept.worstBinRatio.critical) {
          fConceptStatus = 'CRITICAL';
        } else if (maxBinRatio >= calThr.concept.worstBinRatio.warning) {
          fConceptStatus = 'WARNING';
        }
      }

      conceptFeatures[f.key] = {
        key: f.key,
        displayName: f.displayName,
        bins,
        maxBinRatio,
        status: fConceptStatus,
        reason:
          fConceptStatus !== 'STABLE'
            ? `สัดส่วน Bad Rate ราย Bin ของ "${f.displayName}" เบี่ยงเบนเกินเกณฑ์ (${maxBinRatio?.toFixed(2)}x)`
            : `คำนวณ Bad Rate ราย Bin ของ "${f.displayName}" เทียบกับ Reference เรียบร้อยแล้ว`,
      };
    }

    // 2. Model discrimination performance (AUC, Gini, KS) vs Reference
    let performance: ConceptPerformanceReport;
    if (!scoreAvailable) {
      performance = {
        status: 'NOT_AVAILABLE',
        reason: 'โมเดลไม่มีสกอร์การ์ดหรือคอลัมน์คะแนน จึงไม่สามารถคำนวณ AUC/Gini/KS ได้ (แต่คำนวณ Bad Rate ราย Bin ได้)',
        reliable: false,
        reliabilityWarnings: ['ไม่มีคะแนนโมเดล (Score)'],
        reference: null,
        actual: null,
        relativeChange: null,
        thresholds: {
          auc_min: spec.thresholds.auc_min,
          gini_min: spec.thresholds.gini_min,
          ks_min: spec.thresholds.ks_min,
          giniRelDropWarning: dc.giniRelDropWarning,
          giniRelDropCritical: dc.giniRelDropCritical,
        },
      };
    } else {
      const refPoints: DataPoint[] = reference.scores.map((s, i) => ({
        score: s,
        label: reference.labels[i],
      }));
      const refValidPts = refPoints.filter(p => p.label === 0 || p.label === 1);
      const refAuc = calculateAUC(refValidPts, spec.scoreDirection);
      const refGini = calculateGini(refValidPts, spec.scoreDirection);
      const refKs = calculateKS(refValidPts);

      // Pair each cleanRow with its score
      const actPoints: DataPoint[] = cleanRows.map((r, idx) => ({
        score: actualScores[idx] ?? null,
        label: r.label,
      }));
      const actValidPts = actPoints.filter(
        p => p.score !== null && Number.isFinite(p.score) && (p.label === 0 || p.label === 1),
      );
      const actBads = actValidPts.filter(p => p.label === 1).length;
      const actAuc = calculateAUC(actValidPts, spec.scoreDirection);
      const actGini = calculateGini(actValidPts, spec.scoreDirection);
      const actKs = calculateKS(actValidPts);

      const reliability = assessMetricReliability(actValidPts, actAuc, actKs);
      const relAuc = refAuc > 0 ? (actAuc - refAuc) / refAuc : null;
      const relGini = Math.abs(refGini) > 1e-12 ? (actGini - refGini) / Math.abs(refGini) : null;
      const relKs = refKs > 0 ? (actKs - refKs) / refKs : null;

      // Relative Gini drop (positive value means Gini decreased vs Reference)
      const giniDrop = relGini !== null ? -relGini : 0;
      const calConcept = calThr?.concept;
      const nullP95Gini = calConcept?.nullP95GiniDrop ?? 0.15;
      const nullP99Gini = calConcept?.nullP99GiniDrop ?? 0.25;

      const calGiniWarn = calConcept?.giniDrop?.warning ?? dc.giniRelDropWarning;
      const calGiniCrit = calConcept?.giniDrop?.critical ?? dc.giniRelDropCritical;

      // Fixed mode: alarm when exceeding original relative threshold AND exceeding natural null variation (p95)
      let perfStatusFixed: DriftStatus = 'STABLE';
      if ((giniDrop >= dc.giniRelDropCritical && giniDrop > nullP99Gini) || actGini < spec.thresholds.gini_min) {
        perfStatusFixed = 'CRITICAL';
      } else if (giniDrop >= dc.giniRelDropWarning && giniDrop > nullP95Gini) {
        perfStatusFixed = 'WARNING';
      }
      if (actAuc < spec.thresholds.auc_min) {
        perfStatusFixed = 'CRITICAL';
      }
      if (actKs < spec.thresholds.ks_min) {
        perfStatusFixed = worstStatus([perfStatusFixed, 'WARNING']);
      }

      // Calibrated mode: family percentile (Bonferroni per section)
      let perfStatusCalibrated: DriftStatus = 'STABLE';
      if (giniDrop >= calGiniCrit || actGini < spec.thresholds.gini_min) {
        perfStatusCalibrated = 'CRITICAL';
      } else if (giniDrop >= calGiniWarn) {
        perfStatusCalibrated = 'WARNING';
      }
      if (actAuc < spec.thresholds.auc_min) {
        perfStatusCalibrated = 'CRITICAL';
      }
      if (actKs < spec.thresholds.ks_min) {
        perfStatusCalibrated = worstStatus([perfStatusCalibrated, 'WARNING']);
      }

      let perfStatus = thresholdMode === 'calibrated' ? perfStatusCalibrated : perfStatusFixed;
      const reasons: string[] = [];

      if (perfStatus !== 'STABLE') {
        const activeWarnThr = thresholdMode === 'calibrated' ? calGiniWarn : dc.giniRelDropWarning;
        if (giniDrop >= activeWarnThr) {
          reasons.push(
            `Gini ลดลง ${(giniDrop * 100).toFixed(1)}% (Reference ${refGini.toFixed(3)} → ใหม่ ${actGini.toFixed(3)}${actGini < spec.thresholds.gini_min ? `, เกณฑ์ขั้นต่ำ ${spec.thresholds.gini_min}` : ''})`,
          );
        }
        if (actAuc < spec.thresholds.auc_min) {
          reasons.push(`AUC (${actAuc.toFixed(3)}) ต่ำกว่าเกณฑ์ขั้นต่ำ (${spec.thresholds.auc_min})`);
        }
        if (actKs < spec.thresholds.ks_min) {
          reasons.push(`KS (${actKs.toFixed(3)}) ต่ำกว่าเกณฑ์ขั้นต่ำ (${spec.thresholds.ks_min})`);
        }
      }

      // Cap at WARNING if metric is unreliable (e.g., too few bads)
      const lowBadsUnreliable = !reliability.reliable && actBads < 30;
      if (!reliability.reliable) {
        if (perfStatus === 'CRITICAL' && lowBadsUnreliable) {
          perfStatus = 'WARNING';
          reasons.push(`จำกัดสถานะสูงสุดที่ WARNING เนื่องจากจำนวน Bad น้อยเกินไป (${actBads} ราย)`);
        }
      }

      const perfReason =
        reasons.length > 0
          ? reasons.join(' | ')
          : `ประสิทธิภาพโมเดลคงที่ (AUC=${actAuc.toFixed(3)}, Gini=${actGini.toFixed(3)}, KS=${actKs.toFixed(3)})`;

      performance = {
        status: perfStatus,
        reason: perfReason,
        reliable: reliability.reliable,
        reliabilityWarnings: reliability.warnings,
        reference: {
          n: refValidPts.length,
          bads: refValidPts.filter(p => p.label === 1).length,
          auc: refAuc,
          gini: refGini,
          ks: refKs,
        },
        actual: {
          n: actValidPts.length,
          bads: actBads,
          auc: actAuc,
          gini: actGini,
          ks: actKs,
        },
        relativeChange: {
          auc: relAuc,
          gini: relGini,
          ks: relKs,
        },
        thresholds: {
          auc_min: spec.thresholds.auc_min,
          gini_min: spec.thresholds.gini_min,
          ks_min: spec.thresholds.ks_min,
          giniRelDropWarning: dc.giniRelDropWarning,
          giniRelDropCritical: dc.giniRelDropCritical,
        },
      };
    }

    const worstFeatStatus = worstStatus(Object.values(conceptFeatures).map(f => f.status));
    const conceptStatus: DriftSectionStatus =
      performance.status !== 'NOT_AVAILABLE'
        ? worstStatus([performance.status, worstFeatStatus])
        : Object.keys(conceptFeatures).length > 0
          ? worstFeatStatus
          : 'NOT_AVAILABLE';
    const conceptReason =
      conceptStatus !== 'STABLE'
        ? [
            performance.status !== 'STABLE' && performance.status !== 'NOT_AVAILABLE' ? performance.reason : null,
            ...Object.values(conceptFeatures).filter(f => f.status !== 'STABLE').map(f => f.reason),
          ].filter(Boolean).join(' | ')
        : performance.status !== 'NOT_AVAILABLE'
          ? performance.reason
          : 'คำนวณ Bad Rate ราย Bin เรียบร้อยแล้ว (ส่วนประสิทธิภาพ AUC/Gini/KS ไม่มีข้อมูลเนื่องจากโมเดลไม่มีคะแนนรวม)';

    conceptSection = {
      status: conceptStatus,
      reason: conceptReason,
      metrics: {
        features: conceptFeatures,
        performance,
        minBadsPerBin: dc.minBadsPerBin,
      },
    };
  }

  // ── (e) Summary ───────────────────────────────────────────────────────────
  const overallStatusFixed = worstStatus([
    covariateStatusFixed,
    missingStatus,
    labelSection.status,
    conceptSection.status,
  ]);
  const overallStatusCalibrated = worstStatus([
    covariateStatusCalibrated,
    missingStatus,
    labelSection.status,
    conceptSection.status,
  ]);
  const overallStatus: DriftStatus =
    thresholdMode === 'calibrated' ? overallStatusCalibrated : overallStatusFixed;

  const driftTypesDetected: string[] = [];
  for (const [k, f] of Object.entries(covariateFeatures)) {
    if (f.status === 'WARNING' || f.status === 'CRITICAL') {
      driftTypesDetected.push(`covariate:${k}`);
    }
  }
  if (scoreCovariate.status === 'WARNING' || scoreCovariate.status === 'CRITICAL') {
    driftTypesDetected.push('covariate:score');
  }
  for (const [k, m] of Object.entries(missingFeatures)) {
    if (m.status === 'WARNING' || m.status === 'CRITICAL') {
      driftTypesDetected.push(`missing:${k}`);
    }
  }
  if (labelSection.status === 'WARNING' || labelSection.status === 'CRITICAL') {
    driftTypesDetected.push('label');
  }
  if (conceptSection.status === 'WARNING' || conceptSection.status === 'CRITICAL') {
    driftTypesDetected.push('concept');
  }

  const notAvailable: { section: string; reason: string }[] = [];
  if (covariateStatus === 'NOT_AVAILABLE') {
    notAvailable.push({ section: 'covariate', reason: covariateReason });
  } else if (scoreCovariate.status === 'NOT_AVAILABLE') {
    notAvailable.push({ section: 'covariate:score', reason: scoreCovariate.reason });
  }
  if (missingStatus === 'NOT_AVAILABLE') {
    notAvailable.push({ section: 'missing', reason: missingReason });
  }
  if (labelSection.status === 'NOT_AVAILABLE') {
    notAvailable.push({ section: 'label', reason: labelSection.reason });
  }
  if (conceptSection.status === 'NOT_AVAILABLE') {
    notAvailable.push({ section: 'concept', reason: conceptSection.reason });
  } else if (conceptSection.metrics?.performance.status === 'NOT_AVAILABLE') {
    notAvailable.push({
      section: 'concept:performance',
      reason: conceptSection.metrics.performance.reason,
    });
  }

  const summaryReason =
    driftTypesDetected.length > 0
      ? `ตรวจพบสัญญาณ Drift (${overallStatus}): ${driftTypesDetected.join(', ')}`
      : 'ไม่พบสัญญาณ Drift ที่เกินเกณฑ์ในทุกส่วนที่มีข้อมูล';

  const summaryMetrics: DriftReportSummaryMetrics = {
    overallStatus,
    statusFixed: overallStatusFixed,
    statusCalibrated: overallStatusCalibrated,
    driftTypesDetected,
    notAvailable,
  };

  return {
    model: { modelId: spec.modelId, configVersion: spec.configVersion },
    referenceId: reference.meta.referenceId,
    statusFixed: overallStatusFixed,
    statusCalibrated: overallStatusCalibrated,
    covariate: {
      status: covariateStatus,
      statusFixed: covariateStatusFixed,
      statusCalibrated: covariateStatusCalibrated,
      reason: covariateReason,
      metrics: {
        features: covariateFeatures,
        score: scoreCovariate,
      },
    },
    missing: {
      status: missingStatus,
      statusFixed: missingStatus,
      statusCalibrated: missingStatus,
      reason: missingReason,
      metrics: {
        features: missingFeatures,
        threshold: {
          warningDelta: dc.missingDeltaWarning,
          criticalDelta: dc.missingDeltaCritical,
        },
      },
    },
    label: {
      ...labelSection,
      statusFixed: labelSection.status,
      statusCalibrated: labelSection.status,
    },
    concept: {
      ...conceptSection,
      statusFixed: conceptSection.status,
      statusCalibrated: conceptSection.status,
    },
    summary: {
      status: overallStatus,
      statusFixed: overallStatusFixed,
      statusCalibrated: overallStatusCalibrated,
      reason: summaryReason,
      metrics: summaryMetrics,
      ...summaryMetrics,
    },
  };
}
