/**
 * Sandbox experiment runner — one trial = inject (seeded) → runMonitoring → metrics.
 *
 * Row-level metrics (positive = ground-truth kind 'data_error'), per detector:
 *   validation        rows rejected OR with any issue (incl. warnings such as DUPLICATE_ID);
 *                     a blocked file counts every row as detected. Universe = all rows.
 *   iqr | mad | cross_field | isolation_forest | lof | anomaly_any
 *                     Universe = rows that PASSED validation (only those reach layers 3–4);
 *                     recall is therefore "of the errors that reached the layer".
 *   all_layers        validation OR anomaly_any. Universe = all rows.
 * Undefined ratios (0/0) are null, never NaN.
 *
 * File-level: alarm = drift.overallStatus ≠ STABLE (and not blocked).
 * The Isolation Forest seed is fixed at 42; only the injection seed varies.
 */
import type { AnomalyMethod, AnomalySeverity, AnomalyType, DriftResult, DriftSectionName, DriftSectionStatus, DriftStatus, ExpectedLayer, MonitoringRun, TriggerAction } from './types';
import { injectAnomaly, expectedFor, type InjectionParams, type InjectionSpec, type InjectionKind } from './injection';
import { runMonitoring } from './monitoring';

export const DETECTORS = ['validation', 'iqr', 'mad', 'cross_field', 'isolation_forest', 'lof', 'anomaly_any', 'all_layers'] as const;
export type Detector = typeof DETECTORS[number];
const ANOMALY_METHODS: AnomalyMethod[] = ['iqr', 'mad', 'cross_field', 'isolation_forest', 'lof'];

export const TRIGGER_ACTIONS: readonly TriggerAction[] = [
  'CONTINUE',
  'MONITOR_CLOSELY',
  'INVESTIGATE_DATA',
  'INVESTIGATE_DRIFT',
  'RECALIBRATE',
  'CONSIDER_RETRAIN',
  'BLOCKED_INVALID_DATA',
] as const;

export interface DetectorMetrics {
  n: number;                 // rows in this detector's universe (= TP+FP+FN+TN)
  TP: number; FP: number; FN: number; TN: number;
  precision: number | null; recall: number | null; f1: number | null;
  flagRate: number | null;   // (TP+FP)/n — for drift/none this is "real customers flagged"
}

export interface FileMetrics {
  blocked: boolean;
  alarm: boolean;
  alarmExcludingFlagged: boolean;
  statusFixed?: DriftStatus | 'BLOCKED';
  statusCalibrated?: DriftStatus | 'BLOCKED';
  falseAlarm: boolean | null;     // data_error / none
  rescued: boolean | null;        // data_error
  detected: boolean | null;       // drift (fixed)
  detectedCalibrated?: boolean | null; // drift (calibrated)
  preserved: boolean | null;      // drift
  routedLayer: ExpectedLayer;     // layer that caught most injected rows (drift: 'drift' if detected)
  routingCorrect: boolean;
  sectionLeakage?: DriftSectionName[];
  expectedSection?: DriftSectionName;
  triggerCorrect?: boolean;
}

export interface DriftSnapshot { status: string; psi: number; csi: Record<string, number> }

export interface TrialResult {
  spec: InjectionSpec;
  expected: {
    layer: ExpectedLayer;
    section?: DriftSectionName;
    shouldAlarm: boolean;
    expectedAction?: TriggerAction | TriggerAction[];
  };
  kind: InjectionKind;
  rowCount: number;
  injectedCount: number;
  detectors: Record<Detector, DetectorMetrics>;
  file: FileMetrics;
  drift: DriftSnapshot | null;
  driftExcludingFlagged: DriftSnapshot | null;
  triggerAction: TriggerAction;
  statusFixed?: DriftStatus | 'BLOCKED';
  statusCalibrated?: DriftStatus | 'BLOCKED';
  sectionLeakage: DriftSectionName[];
  triggerCorrect: boolean;
  timingMs: number;
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

export function confusion(universe: number[], positives: Set<number>, detected: Set<number>): DetectorMetrics {
  let TP = 0, FP = 0, FN = 0, TN = 0;
  for (const r of universe) {
    const p = positives.has(r), d = detected.has(r);
    if (p && d) TP++; else if (!p && d) FP++; else if (p) FN++; else TN++;
  }
  const precision = ratio(TP, TP + FP), recall = ratio(TP, TP + FN);
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
  return { n: universe.length, TP, FP, FN, TN, precision, recall, f1, flagRate: ratio(TP + FP, universe.length) };
}

const snap = (d: DriftResult | null | undefined): DriftSnapshot | null =>
  d ? { status: d.overallStatus, psi: d.psi.value, csi: Object.fromEntries(Object.entries(d.csi).map(([k, v]) => [k, v.value])) } : null;
const isAlarm = (d: DriftResult | null | undefined) => !!d && d.overallStatus !== 'STABLE';

function withFixedForestSeed(model: any) {
  return model?.anomalyConfig?.seed === 42 ? model : { ...model, anomalyConfig: { ...(model.anomalyConfig ?? {}), seed: 42 } };
}

export function evaluateTrial(run: MonitoringRun, inj: ReturnType<typeof injectAnomaly>): Omit<TrialResult, 'timingMs'> {
  const all = inj.groundTruth.map(g => g.row);
  const positives = new Set(inj.groundTruth.filter(g => g.injected && g.kind === 'data_error').map(g => g.row));
  const injected = inj.groundTruth.filter(g => g.injected).map(g => g.row);
  const blocked = !run.validation.ok;

  const validationHit = new Set<number>();
  const rejected = new Set<number>();
  if (blocked) all.forEach(r => validationHit.add(r));
  for (const is of run.validation.issues) {
    if (is.row === undefined) continue;
    // UNSEEN_CATEGORY is mapped to __UNSEEN__ in Layer 2 and flagged as an anomaly in Layer 3 (unseen_category).
    if (is.type !== 'UNSEEN_CATEGORY') {
      validationHit.add(is.row);
    }
    if (is.severity === 'error') rejected.add(is.row);
  }
  const passed = blocked ? [] : all.filter(r => !rejected.has(r));

  const byMethod: Record<string, Set<number>> = Object.fromEntries(ANOMALY_METHODS.map(m => [m, new Set<number>()]));
  const anyAnomaly = new Set<number>();
  for (const f of run.anomaly?.flaggedRows ?? []) {
    anyAnomaly.add(f.row);
    for (const m of f.methods) byMethod[m]?.add(f.row);
  }
  const allLayers = new Set([...validationHit, ...anyAnomaly]);

  const detectors = {
    validation: confusion(all, positives, validationHit),
    ...Object.fromEntries(ANOMALY_METHODS.map(m => [m, confusion(passed, positives, byMethod[m])])),
    anomaly_any: confusion(passed, positives, anyAnomaly),
    all_layers: confusion(all, positives, allLayers),
  } as Record<Detector, DetectorMetrics>;

  const kind = inj.spec.kind;
  const alarm = !blocked && isAlarm(run.drift);
  const alarmEx = !blocked && isAlarm(run.driftExcludingFlagged ?? run.drift);   // no flags → same as drift
  const expected = inj.expected;

  let routedLayer: ExpectedLayer;
  if (kind === 'drift') routedLayer = alarm ? 'drift' : 'none';
  else if (kind === 'clean') routedLayer = alarm ? 'drift' : 'none';
  else {
    const v = injected.filter(r => validationHit.has(r)).length;
    const a = injected.filter(r => anyAnomaly.has(r)).length;
    routedLayer = v === 0 && a === 0 ? 'none' : v >= a ? 'validation' : 'anomaly';
  }

  const sectionStatuses: Record<DriftSectionName, DriftSectionStatus> = {
    covariate: run.driftReport?.covariate?.status ?? 'STABLE',
    label: run.driftReport?.label?.status ?? 'STABLE',
    concept: run.driftReport?.concept?.status ?? 'STABLE',
    missing: run.driftReport?.missing?.status ?? 'STABLE',
  };
  const isSectionAlarm = (s: DriftSectionStatus) => s === 'WARNING' || s === 'CRITICAL';

  let routingCorrect: boolean;
  let sectionLeakage: DriftSectionName[] = [];
  const expectedSection: DriftSectionName | undefined = expected.section;

  if (kind === 'drift') {
    if (expected.section) {
      const expStatus = sectionStatuses[expected.section];
      routingCorrect = isSectionAlarm(expStatus);
      sectionLeakage = (['covariate', 'missing', 'label', 'concept'] as DriftSectionName[]).filter(
        s => s !== expected.section && isSectionAlarm(sectionStatuses[s]),
      );
    } else {
      routingCorrect = alarm;
    }
  } else if (kind === 'clean') {
    routingCorrect = !alarm;
  } else {
    routingCorrect = routedLayer === expected.layer;
  }

  const triggerAction: TriggerAction =
    run.trigger?.action ?? (blocked ? 'BLOCKED_INVALID_DATA' : 'CONTINUE');

  const expectedActions = Array.isArray(expected.expectedAction)
    ? expected.expectedAction
    : [expected.expectedAction];
  const triggerCorrect = expectedActions.includes(triggerAction);

  const statusFixed: DriftStatus | 'BLOCKED' = blocked ? 'BLOCKED' : (run.driftReport?.statusFixed ?? run.drift?.overallStatus ?? 'STABLE');
  const statusCalibrated: DriftStatus | 'BLOCKED' = blocked ? 'BLOCKED' : (run.driftReport?.statusCalibrated ?? run.drift?.overallStatus ?? 'STABLE');

  const expSec = expected.section;
  let detected: boolean | null = null;
  let detectedCalibrated: boolean | null = null;
  let preserved: boolean | null = null;

  if (kind === 'drift') {
    const secRep = expSec && run.driftReport ? (run.driftReport as any)[expSec] : null;
    const secRepExcl = expSec && run.driftReportExcludingFlagged
      ? (run.driftReportExcludingFlagged as any)[expSec]
      : secRep;

    const sFixed = secRep?.statusFixed ?? secRep?.status ?? (alarm ? 'WARNING' : 'STABLE');
    const sCal = secRep?.statusCalibrated ?? secRep?.status ?? (alarm ? 'WARNING' : 'STABLE');
    const sExclFixed = secRepExcl?.statusFixed ?? secRepExcl?.status ?? (alarmEx ? 'WARNING' : 'STABLE');

    detected = !blocked && (sFixed === 'WARNING' || sFixed === 'CRITICAL');
    detectedCalibrated = !blocked && (sCal === 'WARNING' || sCal === 'CRITICAL');
    preserved = !blocked && (sExclFixed === 'WARNING' || sExclFixed === 'CRITICAL');
  }

  const file: FileMetrics = {
    blocked, alarm, alarmExcludingFlagged: alarmEx,
    statusFixed,
    statusCalibrated,
    falseAlarm: kind === 'drift' ? null : alarm,
    rescued: kind === 'data_error' ? alarm && !alarmEx : null,
    detected,
    detectedCalibrated,
    preserved,
    routedLayer,
    routingCorrect,
    sectionLeakage,
    expectedSection,
    triggerCorrect,
  };

  return {
    spec: inj.spec, expected, kind,
    rowCount: all.length, injectedCount: injected.length,
    detectors, file,
    drift: snap(run.drift), driftExcludingFlagged: snap(run.driftExcludingFlagged),
    triggerAction,
    statusFixed,
    statusCalibrated,
    sectionLeakage,
    triggerCorrect,
  };
}

export function runTrial(model: any, params: InjectionParams): TrialResult {
  const t0 = performance.now();
  const m = withFixedForestSeed(model);
  const inj = injectAnomaly(m, params);
  const { run } = runMonitoring({
    model: m, fileName: `trial_${params.type}.csv`, csvText: inj.csvText,
    maxValidationIssues: Infinity, maxStoredFlaggedRows: Infinity,
    history: [], recordTriggerEvent: false,
  });
  return { ...evaluateTrial(run, inj), timingMs: performance.now() - t0 };
}

/** Did this trial "detect" the problem, for ExperimentRun.detected (file-level). */
export function trialDetected(t: TrialResult): boolean {
  if (t.kind === 'drift') return !!t.file.detected;
  if (t.kind === 'clean') return t.file.alarm;
  return t.file.blocked || t.detectors.all_layers.TP > 0;
}

// ─── Aggregation helpers (shared by script + API) ───────────────────────────
export interface Stat { n: number; mean: number | null; sd: number | null; ciLow: number | null; ciHigh: number | null }
export function stat(values: (number | null | undefined)[]): Stat {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const n = v.length;
  if (n === 0) return { n, mean: null, sd: null, ciLow: null, ciHigh: null };
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const h = (1.96 * sd) / Math.sqrt(n);
  return { n, mean, sd, ciLow: mean - h, ciHigh: mean + h };
}
export const rate = (values: (boolean | null)[]) => stat(values.map(b => (b === null ? null : b ? 1 : 0)));

/** Proportion of each TriggerAction across a list of trials (for batch_summary.csv). */
export function summarizeTriggerActions(trials: TrialResult[]): Record<string, number> {
  const n = trials.length;
  const counts: Record<TriggerAction, number> = {
    CONTINUE: 0,
    MONITOR_CLOSELY: 0,
    INVESTIGATE_DATA: 0,
    INVESTIGATE_DRIFT: 0,
    RECALIBRATE: 0,
    CONSIDER_RETRAIN: 0,
    BLOCKED_INVALID_DATA: 0,
  };
  for (const t of trials) {
    if (t.triggerAction in counts) counts[t.triggerAction]++;
  }
  const out: Record<string, number> = {};
  for (const act of TRIGGER_ACTIONS) {
    out[`action_${act}_rate`] = n > 0 ? counts[act] / n : 0;
  }
  return out;
}

export type { AnomalySeverity, AnomalyType };
