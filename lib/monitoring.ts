/**
 * Monitoring pipeline (server side):
 *
 *   CSV ─► parseCsv ─► [1] Validation ─► [2] Anomaly Screening ─► [3] Scoring ─► [4] Drift ─► MonitoringRun
 *                          │ blocked        (warning-only flags)                   ├─ drift                 (official; minus user excludeRows)
 *                          └─► run (drift = null, anomaly = null)                  └─ driftExcludingFlagged (what-if; minus all flagged rows)
 *
 * Each stage is a pure function in lib/; this module only wires them together
 * so the same pipeline can be reused by the Sandbox (with injected anomalies).
 */
import type { DriftSectionStatus, FeatureDefinition, MonitoringRun, MonitoringThresholds, ScoringConfig } from './types';
import {
  DEFAULT_DATE_COLUMN,
  DEFAULT_ID_COLUMN,
  LEGACY_SCORE_KEY,
  resolveModelColumns,
} from './defaults';
import { parseCsv } from './csv';
import { validateDataset, isValidDate, type CleanRow } from './validation';
import { calculateAScore, scoreToPD } from './scoring';
import { getReferenceProfile, type ReferenceProfile } from './reference';
import { runDriftDetection, resolveCsiFeatures, type DriftDetectionOptions } from './drift';
import { buildDriftReport, computeDistributionStats } from './driftReport';
import { evaluateTrigger } from './trigger';
import { getMonitoringHistorySync, recordTriggerEventSync } from './storage/repositories';
import { getBinIndex } from './stats';
import { runAnomalyScreening, truncateAnomalyResult, resolveAnomalyConfig, referenceFlaggedIndices, referenceWithout } from './anomaly';

export interface MonitoringInput {
  model: any;                       // effective model (bundled + overrides)
  fileName: string;
  csvText?: string;
  rows?: Record<string, unknown>[]; // alternative to csvText (legacy clients)
  /** Rows (1-based, = CleanRow.row) the user chose to drop from the official drift. */
  excludeRows?: number[];
  /** Run layers 3–4 (default true). */
  anomalyScreening?: boolean;
  /** Max flaggedRows kept in the stored run (default anomalyConfig.maxStoredRows ?? 500). */
  maxStoredFlaggedRows?: number;
  /** Max row-level validation issues kept (default 200). Experiments pass Infinity for exact row metrics. */
  maxValidationIssues?: number;
  /** Prior monitoring runs for evaluating persistence rules (defaults to stored runs for modelId + referenceId + configVersion). */
  history?: MonitoringRun[];
  /** Whether to persist non-CONTINUE TriggerEvent to storage (default true; false in synthetic sandbox trials). */
  recordTriggerEvent?: boolean;
}

const UNKNOWN_PERIOD = 'ไม่ระบุวันที่';

function toPeriod(raw: unknown): string | null {
  if (raw === null || raw === undefined || !isValidDate(raw)) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = s.match(/^\d{1,2}\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[2]}-${m[1].padStart(2, '0')}` : null;
}

export function buildUploadSummary(
  rows: Record<string, unknown>[],
  registry: Record<string, FeatureDefinition>,
  dateColumn: string | null = DEFAULT_DATE_COLUMN,
) {
  const total = rows.length || 1;
  const periodCounts: Record<string, number> = {};
  for (const r of rows) {
    const p = (dateColumn ? toPeriod(r[dateColumn]) : null) ?? UNKNOWN_PERIOD;
    periodCounts[p] = (periodCounts[p] || 0) + 1;
  }
  const periods = Object.entries(periodCounts)
    .sort(([a], [b]) => (a === UNKNOWN_PERIOD ? 1 : b === UNKNOWN_PERIOD ? -1 : a.localeCompare(b)))
    .map(([period, count]) => ({ period, count, pct: +((count / total) * 100).toFixed(1) }));
  const missingData = Object.entries(registry).map(([key, def]) => {
    const col = def.columnName || key;
    const missingCount = rows.filter(r => r[col] === undefined || r[col] === null || String(r[col]).trim() === '').length;
    return { column: col, label: def.displayName || col, missingCount, missingPct: +((missingCount / total) * 100).toFixed(1) };
  });
  return { totalRows: rows.length, periods, missingData };
}

/**
 * Compute risk grade distribution.
 * - If customGrades (`model.riskGrades`) is provided, uses those thresholds.
 * - Otherwise derives deciles D1–D10 from Reference score boundaries ordered by
 *   `scoreDirection` so D1 is always the lowest-risk (safest) decile.
 * - When scores are unavailable (`scores.length === 0`), returns `[]`.
 */
export function riskGradeDistribution(
  scores: number[],
  customGrades?: { grade: string; minScore: number }[],
  referenceBoundaries: number[] = [],
  scoreDirection: 'higher_is_safer' | 'higher_is_riskier' = 'higher_is_safer',
): { grade: string; count: number; pct: number }[] {
  if (scores.length === 0) return [];
  const n = scores.length || 1;

  if (customGrades && customGrades.length > 0) {
    const sortedGrades = [...customGrades].sort((a, b) => b.minScore - a.minScore);
    const counts: Record<string, number> = Object.fromEntries(customGrades.map(g => [g.grade, 0]));
    for (const s of scores) {
      const match = sortedGrades.find(g => s >= g.minScore) ?? sortedGrades[sortedGrades.length - 1];
      if (match) counts[match.grade]++;
    }
    return customGrades.map(g => ({
      grade: g.grade,
      count: counts[g.grade],
      pct: +((counts[g.grade] / n) * 100).toFixed(1),
    }));
  }

  const numBins = referenceBoundaries.length > 0 ? referenceBoundaries.length + 1 : 10;
  const binCounts = new Array<number>(numBins).fill(0);
  for (const s of scores) {
    const idx = referenceBoundaries.length > 0 ? getBinIndex(s, referenceBoundaries) : 0;
    binCounts[idx]++;
  }
  // Bucket 0 is lowest score, bucket (numBins - 1) is highest score.
  // D1 = safest decile:
  //  - higher_is_safer:   D1 = bucket (numBins - 1), ..., D10 = bucket 0
  //  - higher_is_riskier: D1 = bucket 0, ..., D10 = bucket (numBins - 1)
  return Array.from({ length: numBins }, (_, dIdx) => {
    const grade = `D${dIdx + 1}`;
    const bucketIdx = scoreDirection === 'higher_is_riskier' ? dIdx : numBins - 1 - dIdx;
    const count = binCounts[bucketIdx] ?? 0;
    return {
      grade,
      count,
      pct: +((count / n) * 100).toFixed(1),
    };
  });
}

function extractRowScore(
  r: CleanRow,
  rawRows: Record<string, unknown>[],
  scoreColumn?: string | null,
): number | null {
  if (!scoreColumn) return null;
  const fromValues = r.values[scoreColumn];
  if (typeof fromValues === 'number' && Number.isFinite(fromValues)) return fromValues;
  const raw = rawRows[r.row - 1]?.[scoreColumn];
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function runMonitoring(input: MonitoringInput) {
  const { model: rawModel, fileName, anomalyScreening = true } = input;
  const modelId: string = rawModel.modelId ?? rawModel.id ?? 'unknown_model';
  const configVersion: string = rawModel.version ?? rawModel.configVersion ?? '1.0.0';
  const resolvedCols = resolveModelColumns(rawModel);
  const idColumn = resolvedCols.idColumn;
  const dateColumn = resolvedCols.dateColumn;
  const labelColumn = resolvedCols.labelColumn ?? undefined;
  const scoreColumn = resolvedCols.scoreColumn ?? undefined;
  const scoreDirection: 'higher_is_safer' | 'higher_is_riskier' =
    rawModel.scoreDirection === 'higher_is_riskier' ? 'higher_is_riskier' : 'higher_is_safer';

  const model = {
    ...rawModel,
    id: modelId,
    modelId,
    configVersion,
    version: configVersion,
    idColumn,
    dateColumn,
    labelColumn,
    scoreColumn,
    scoreDirection,
  };
  const scoring = (model.scoring ?? { base_points: 0, factor: 1, offset: 0, features: [], scorecard: {} }) as ScoringConfig;
  const registry = (model.featureRegistry ?? {}) as Record<string, FeatureDefinition>;
  const thresholds = model.thresholds as MonitoringThresholds;
  const referenceId: string = model.referenceDatasetId;

  const reference = getReferenceProfile(referenceId, scoring, { labelColumn, scoreColumn });
  const referenceStats: Record<string, { mean: number; median: number }> = {};
  for (const [k, vals] of Object.entries(reference.features)) {
    const st = computeDistributionStats(vals);
    referenceStats[k] = { mean: st.mean, median: st.median };
  }

  // ── Parse ──
  let headers: string[]; let rows: Record<string, unknown>[]; let malformedRows: { row: number; expected: number; actual: number }[] = [];
  if (typeof input.csvText === 'string') {
    const p = parseCsv(input.csvText);
    headers = p.headers; rows = p.rows; malformedRows = p.malformedRows;
  } else {
    rows = input.rows ?? [];
    headers = rows.length ? Object.keys(rows[0]) : [];
  }

  // ── [1] Validation ──
  const { result: validation, rows: clean } = validateDataset(rows, headers, registry, {
    scoringFeatures: scoring.features ?? [],
    idColumn,
    dateColumn: dateColumn ?? '',
    labelColumn: labelColumn ?? '',
    scoreColumn,
    referenceStats,
    malformedRows,
    ...(input.maxValidationIssues !== undefined ? { maxIssues: input.maxValidationIssues } : {}),
  });
  const uploadSummary = buildUploadSummary(rows, registry, dateColumn);

  const run: MonitoringRun = {
    runId: `mon_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    kind: 'monitoring',
    createdAt: new Date().toISOString(),
    model: { modelId: model.id, configVersion: model.configVersion ?? '1.0.0' },
    modelName: model.name,
    referenceId,
    fileName,
    thresholdsSnapshot: thresholds,
    validation,
    drift: null,
    anomaly: null,
    driftExcludingFlagged: null,
    driftReport: null,
    trigger: null,
    excludedRows: [],
    uploadSummary,
  };
  const history = input.history ?? getMonitoringHistorySync(model.id, referenceId, model.configVersion);
  const shouldRecordEvent = input.recordTriggerEvent !== false;
  if (!validation.ok) {
    run.trigger = evaluateTrigger(run, model, history);
    if (shouldRecordEvent) recordTriggerEventSync(run);
    return {
      run,
      scored: [] as ReturnType<typeof scoreRows>,
      riskGradeDist: [],
      riskGradeStatus: 'NOT_AVAILABLE' as DriftSectionStatus,
      skipped: {},
    };
  }

  // ── [2] Anomaly screening (warning-only, on CleanRow) ──
  let flagged = new Set<number>();
  if (anomalyScreening) {
    const full = runAnomalyScreening(reference, clean, model);
    flagged = new Set(full.flaggedRows.map(f => f.row));
    run.anomaly = full;
  }

  // ── User exclusions (audit trail) ──
  const cleanRowNos = new Set(clean.map(r => r.row));
  const excludeSet = new Set((input.excludeRows ?? []).filter(n => cleanRowNos.has(n)));
  run.excludedRows = [...excludeSet].sort((a, b) => a - b);
  const official = excludeSet.size ? clean.filter(r => !excludeSet.has(r.row)) : clean;

  // ── [3] Scoring ──
  const hasScorecard = Boolean(
    model.mode !== 'score_column' &&
    !scoreColumn &&
    scoring.scorecard && Object.keys(scoring.scorecard).length > 0 && (scoring.features?.length ?? 0) > 0,
  );
  const scoreColPresentInUpload = Boolean(scoreColumn && headers.includes(scoreColumn));
  const scored = scoreRows(official, rows, scoring, scoreColPresentInUpload ? scoreColumn : undefined, hasScorecard);
  const officialScores: number[] = hasScorecard
    ? scored.map(s => Number(s[LEGACY_SCORE_KEY])).filter(Number.isFinite)
    : scoreColPresentInUpload && scoreColumn
      ? official.map(r => extractRowScore(r, rows, scoreColumn)).filter((v): v is number => v !== null)
      : [];

  const driftOpts: DriftDetectionOptions = {
    labelColumn: labelColumn ?? null,
    scoreColumn: scoreColumn ?? null,
    idColumn,
    dateColumn,
  };

  // ── [4] Drift (official) ──
  const minRows = ValidationDefaults.minRowsForDrift;
  let skipped: Record<string, string> = {};
  if (official.length > 0) {
    const r = driftFor(reference, official, officialScores, registry, thresholds, driftOpts);
    skipped = r.skipped; run.drift = r.drift;
    run.driftReport = buildDriftReport(reference, model, {
      cleanRows: official,
      rawRows: rows,
      driftResult: run.drift,
      actualScores: officialScores,
    });
  }

  // ── [4b] What-if drift without flagged rows ──
  if (run.anomaly && flagged.size > 0) {
    const kept = official.filter(r => !flagged.has(r.row));
    if (kept.length === 0) {
      run.anomaly.warnings.push('ทุกแถวโดนธง — คำนวณ drift แบบตัดแถวที่โดนธงไม่ได้');
    } else {
      if (kept.length < minRows) run.anomaly.warnings.push(`หลังตัดแถวที่โดนธงเหลือ ${kept.length} แถว (< ${minRows}) — ค่า PSI/CSI แบบตัดแถวอาจแกว่งสูง`);
      const keptScores: number[] = hasScorecard
        ? kept.map(r => calculateAScore(scoring, r.values))
        : scoreColPresentInUpload && scoreColumn
          ? kept.map(r => extractRowScore(r, rows, scoreColumn)).filter((v): v is number => v !== null)
          : [];
      // Symmetric: drop reference rows flagged by the same rules, keep the ORIGINAL bins.
      const refKept = referenceWithout(reference, referenceFlaggedIndices(reference, model));
      const frozen = freezeCsiBins(registry, thresholds, reference, driftOpts);
      run.driftExcludingFlagged = driftFor(refKept, kept, keptScores, registry, frozen, driftOpts).drift;
    }
  }

  if (run.anomaly) run.anomaly = truncateAnomalyResult(run.anomaly, input.maxStoredFlaggedRows ?? resolveAnomalyConfig(model, reference).maxStoredRows);

  // ── [5] Trigger & Recommended Actions (Step 9) ──
  run.trigger = evaluateTrigger(run, model, history);
  if (shouldRecordEvent) recordTriggerEventSync(run);

  const riskGradeDist = riskGradeDistribution(
    officialScores,
    model.riskGrades,
    reference.scoreBoundaries,
    scoreDirection,
  );
  const riskGradeStatus: DriftSectionStatus = officialScores.length > 0 ? 'STABLE' : 'NOT_AVAILABLE';

  return { run, scored, riskGradeDist, riskGradeStatus, skipped };
}

const ValidationDefaults = { minRowsForDrift: 100 };   // keep in sync with validateDataset default

/** Pin every CSI feature's bins/labels/threshold to what the FULL reference resolves to (no re-binning on a reduced reference). */
function freezeCsiBins(
  registry: Record<string, FeatureDefinition>,
  thresholds: MonitoringThresholds,
  fullRef: ReferenceProfile,
  options?: DriftDetectionOptions,
): MonitoringThresholds {
  const csi_features: MonitoringThresholds['csi_features'] = {};
  for (const f of resolveCsiFeatures(registry, thresholds, fullRef, options)) {
    if (f.skipped) continue;
    csi_features[f.key] = { label: f.displayName, source: f.source, threshold: f.threshold, bins: f.bins, bin_labels: f.labels };
  }
  return { ...thresholds, csi_features };
}

function driftFor(
  reference: ReferenceProfile,
  rows: CleanRow[],
  scores: number[],
  registry: Record<string, FeatureDefinition>,
  thresholds: MonitoringThresholds,
  options?: DriftDetectionOptions,
) {
  const actualFeatures: Record<string, number[]> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.values)) (actualFeatures[k] ??= []).push(v);
  const { skipped, ...drift } = runDriftDetection(reference, scores, actualFeatures, registry, thresholds, options);
  return { drift, skipped };
}

function scoreRows(
  clean: CleanRow[],
  rawRows: Record<string, unknown>[],
  scoring: ScoringConfig,
  scoreColumn?: string,
  hasCard = false,
): Array<Record<string, any>> {
  return clean.map(r => {
    const extScore = scoreColumn ? extractRowScore(r, rawRows, scoreColumn) : null;
    const scoreValue = hasCard
      ? calculateAScore(scoring, r.values)
      : extScore ?? 0;
    const bins: Record<string, number> = {};
    if (hasCard) {
      for (const f of scoring.features) {
        if (scoring.scorecard[f]?.bins) bins[`${f}_bin`] = getBinIndex(r.values[f], scoring.scorecard[f].bins);
      }
    }
    return {
      row: r.row,
      [DEFAULT_ID_COLUMN]: r.id,
      id: r.id,
      ...Object.fromEntries((scoring.features ?? []).map(f => [f, r.values[f]])),
      ...bins,
      [LEGACY_SCORE_KEY]: scoreValue,
      score: extScore ?? (hasCard ? scoreValue : null),
      pd: hasCard ? scoreToPD(scoring, scoreValue) : 0,
      defaultLabel: r.label,
      imputed: r.imputed,
    };
  });
}
