/**
 * Multi-Month Sequence Simulator for Drift Scenarios (Step 11a.2).
 *
 * Simulates a 12-month sequential monitoring timeline:
 *   - Bootstrap monthly batches from Reference dataset.
 *   - Injects gradual or sudden drift starting at `startMonth`.
 *   - Runs each month through `runMonitoring`, retaining an in-memory history
 *     so persistence rules (e.g. R6: 2 consecutive runs >= CRITICAL -> CONSIDER_RETRAIN)
 *     work authentically without touching production KV storage.
 *   - Computes detection delay, first alarm month, first retrain month, and false alarms.
 */
import type {
  AnomalyType,
  DriftStatus,
  MonitoringRun,
  TriggerAction,
} from './types';
import { injectAnomaly, toCsv } from './injection';
import { SEVERITY_TABLE } from './injection-meta';
import { runMonitoring } from './monitoring';
import { resolveModelColumns } from './defaults';
import { getEffectiveModel } from './storage/repositories';
import { loadReferenceDatasetBlob } from './storage/blob';
import { registerReferenceDataset } from './reference';

export interface SequenceSpec {
  type: AnomalyType;
  pattern: 'gradual' | 'sudden';
  startMonth?: number;     // 1-based index (default: 6)
  endMagnitude?: number;   // magnitude of injection (default: based on type)
  rowsPerMonth?: number;   // default: Reference row count
  seed?: number;           // default: 42
  monthsCount?: number;    // default: 12
}

export interface MonthlySequenceRow {
  month: number;
  injectedType: AnomalyType;
  injectedMagnitude: number;
  covariateStatus: DriftStatus | 'NOT_AVAILABLE';
  missingStatus: DriftStatus | 'NOT_AVAILABLE';
  labelStatus: DriftStatus | 'NOT_AVAILABLE';
  conceptStatus: DriftStatus | 'NOT_AVAILABLE';
  overallStatus: DriftStatus | 'NOT_AVAILABLE';
  psi: number | null;
  topCsi: number | null;
  topCsiFeature: string | null;
  ksD: number | null;
  wasserstein: number | null;
  auc: number | null;
  triggerAction: TriggerAction;
  matchedRuleId?: string;
  isAlarm: boolean;
}

export interface SequenceSummary {
  modelId: string;
  type: AnomalyType;
  pattern: 'gradual' | 'sudden';
  startMonth: number;
  endMagnitude: number;
  firstAlarmMonth: number | null;
  detectionDelay: number | null; // firstAlarmMonth - startMonth (or null if not detected on/after startMonth)
  firstRetrainMonth: number | null;
  falseAlarmsBeforeStart: number;
  totalMonths: number;
}

export interface SequenceResult {
  spec: Required<SequenceSpec>;
  summary: SequenceSummary;
  months: MonthlySequenceRow[];
  runs: MonitoringRun[];
}

export function getDefaultMagnitude(type: AnomalyType): number {
  switch (type) {
    case 'mean_shift':
      return SEVERITY_TABLE.mean_shift.medium; // -0.20
    case 'variance_change':
      return SEVERITY_TABLE.variance_change.medium; // 1.5
    case 'mix_shift':
      return SEVERITY_TABLE.mix_shift.high; // 0.40
    case 'label_shift':
      return SEVERITY_TABLE.label_shift.medium; // 1.5
    case 'concept_shift':
      return SEVERITY_TABLE.concept_shift.high; // 1.0
    case 'missing_drift':
      return SEVERITY_TABLE.missing_drift.high; // 0.20
    case 'category_shift':
      return SEVERITY_TABLE.category_shift.medium; // 0.20
    default:
      return 1.0;
  }
}

/**
 * Runs a multi-month sequential simulation on the given model.
 */
export async function runSequence(
  modelOrId: any,
  spec: SequenceSpec,
): Promise<SequenceResult> {
  let model = modelOrId;
  if (typeof modelOrId === 'string') {
    model = await getEffectiveModel(modelOrId);
  }

  // Ensure Reference dataset is registered in in-memory cache
  if (model.referenceDatasetId) {
    const refBlob = await loadReferenceDatasetBlob(model.referenceDatasetId);
    if (refBlob) {
      registerReferenceDataset(refBlob.meta, refBlob.rows);
    }
  }

  const modelId = String(model.id ?? model.modelId ?? 'unknown_model');
  const type = spec.type;
  const pattern = spec.pattern ?? 'sudden';
  const startMonth = spec.startMonth ?? 6;
  const endMagnitude = typeof spec.endMagnitude === 'number' ? spec.endMagnitude : getDefaultMagnitude(type);
  const rowsPerMonth = spec.rowsPerMonth;
  const seed = spec.seed ?? 42;
  const monthsCount = spec.monthsCount ?? 12;

  const fullSpec: Required<SequenceSpec> = {
    type,
    pattern,
    startMonth,
    endMagnitude,
    rowsPerMonth: rowsPerMonth ?? 855,
    seed,
    monthsCount,
  };

  const memoryHistory: MonitoringRun[] = [];
  const monthlyRows: MonthlySequenceRow[] = [];
  const dateCol = resolveModelColumns(model).dateColumn;

  for (let m = 1; m <= monthsCount; m++) {
    const isDriftMonth = m >= startMonth;
    let currentType: AnomalyType = 'none';
    let currentMagnitude = 0;

    if (isDriftMonth && type !== 'none') {
      currentType = type;
      if (pattern === 'sudden') {
        currentMagnitude = endMagnitude;
      } else {
        const totalRamp = monthsCount - startMonth + 1;
        const currentStep = m - startMonth + 1;
        const fraction = totalRamp > 0 ? currentStep / totalRamp : 1;
        currentMagnitude = +(endMagnitude * fraction).toFixed(4);
      }
    }

    // Inject batch for month m
    const inj = injectAnomaly(model, {
      type: currentType,
      severity: 'medium',
      rate: 1,
      n: rowsPerMonth,
      seed: seed + m * 1000,
      magnitude: currentMagnitude,
    });

    // Update date column to simulate real monthly chronological progression
    const monthStr = String(m).padStart(2, '0');
    if (dateCol) {
      for (const r of inj.rows) {
        if (dateCol in r || inj.columns.includes(dateCol)) {
          r[dateCol] = `2026-${monthStr}-15`;
        }
      }
    }
    const csvText = toCsv(inj.rows, inj.columns);

    // Run monitoring pipeline with isolated in-memory history
    const { run } = runMonitoring({
      model,
      fileName: `sequence_m${monthStr}_${currentType}.csv`,
      csvText,
      history: memoryHistory,
      recordTriggerEvent: false,
    });

    const covariateStatus = run.driftReport?.covariate?.status ?? 'STABLE';
    const missingStatus = run.driftReport?.missing?.status ?? 'STABLE';
    const labelStatus = run.driftReport?.label?.status ?? 'STABLE';
    const conceptStatus = run.driftReport?.concept?.status ?? 'STABLE';
    const overallStatus = run.driftReport?.summary?.status ?? run.drift?.overallStatus ?? 'STABLE';
    const isAlarm = overallStatus !== 'STABLE';
    const psi = run.drift?.psi?.value ?? null;

    // Top CSI
    const csiEntries = Object.entries(run.drift?.csi ?? {});
    let topCsi: number | null = null;
    let topCsiFeature: string | null = null;
    if (csiEntries.length > 0) {
      csiEntries.sort((a, b) => b[1].value - a[1].value);
      topCsi = csiEntries[0][1].value;
      topCsiFeature = csiEntries[0][0];
    }

    // KS and Wasserstein
    let ksD: number | null = null;
    let wasserstein: number | null = null;
    if (run.driftReport?.covariate?.metrics?.score && run.driftReport.covariate.metrics.score.status !== 'NOT_AVAILABLE') {
      ksD = run.driftReport.covariate.metrics.score.ks?.d ?? null;
      wasserstein = run.driftReport.covariate.metrics.score.wasserstein?.scaled ?? null;
    } else if (topCsiFeature && run.driftReport?.covariate?.metrics?.features?.[topCsiFeature]) {
      const fRep = run.driftReport.covariate.metrics.features[topCsiFeature];
      ksD = fRep.ks?.d ?? null;
      wasserstein = fRep.wasserstein?.scaled ?? null;
    }

    const auc = run.driftReport?.concept?.metrics?.performance?.actual?.auc ?? null;
    const triggerAction: TriggerAction = run.trigger?.action ?? (run.validation?.ok ? 'CONTINUE' : 'BLOCKED_INVALID_DATA');
    const matchedRuleId = run.trigger?.matchedRuleId;

    monthlyRows.push({
      month: m,
      injectedType: currentType,
      injectedMagnitude: currentMagnitude,
      covariateStatus,
      missingStatus,
      labelStatus,
      conceptStatus,
      overallStatus,
      psi,
      topCsi,
      topCsiFeature,
      ksD,
      wasserstein,
      auc,
      triggerAction,
      matchedRuleId,
      isAlarm,
    });

    memoryHistory.push(run);
  }

  // Summary
  let firstAlarmMonth: number | null = null;
  let firstRetrainMonth: number | null = null;
  let falseAlarmsBeforeStart = 0;

  for (const row of monthlyRows) {
    if (row.isAlarm && firstAlarmMonth === null && row.month >= startMonth) {
      firstAlarmMonth = row.month;
    }
    if (row.month < startMonth && row.isAlarm) {
      falseAlarmsBeforeStart++;
    }
    if (row.triggerAction === 'CONSIDER_RETRAIN' && firstRetrainMonth === null) {
      firstRetrainMonth = row.month;
    }
  }

  const detectionDelay = (firstAlarmMonth !== null && firstAlarmMonth >= startMonth)
    ? firstAlarmMonth - startMonth
    : null;

  const summary: SequenceSummary = {
    modelId,
    type,
    pattern,
    startMonth,
    endMagnitude,
    firstAlarmMonth,
    detectionDelay,
    firstRetrainMonth,
    falseAlarmsBeforeStart,
    totalMonths: monthsCount,
  };

  return {
    spec: fullSpec,
    summary,
    months: monthlyRows,
    runs: memoryHistory,
  };
}
