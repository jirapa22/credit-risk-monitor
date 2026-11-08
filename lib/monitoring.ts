/**
 * Monitoring pipeline (server side):
 *
 *   CSV ─► parseCsv ─► [1] Validation ─► [2] Anomaly Screening ─► [3] Scoring ─► [4] Drift ─► MonitoringRun
 *                          │ blocked        (warning-only flags)                   ├─ drift                 (official; minus user excludeRows)
 *                          └─► run (drift = null, anomaly = null)                  └─ driftExcludingFlagged (what-if; minus all flagged rows)
 *
 * Each stage is a pure function in lib/; this module only wires them together
 * so the same pipeline can be reused by the future Sandbox (with injected anomalies).
 */
import type { FeatureDefinition, MonitoringRun, MonitoringThresholds, ScoringConfig } from './types';
import { parseCsv } from './csv';
import { validateDataset, isValidDate, type CleanRow } from './validation';
import { calculateAScore, scoreToPD } from './scoring';
import { getReferenceProfile } from './reference';
import { runDriftDetection, resolveCsiFeatures } from './drift';
import { buildDriftReport, computeDistributionStats } from './driftReport';
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
  dateColumn: string | null = 'application_date',
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

/** Risk grades from the KS decile score bounds of the model report. */
const RISK_GRADES = [
  { grade: 'AAA', minScore: 586.5 }, { grade: 'AA+', minScore: 578 }, { grade: 'AA', minScore: 572 },
  { grade: 'AA-', minScore: 565.7 }, { grade: 'A+', minScore: 562 }, { grade: 'A', minScore: 551.7 },
  { grade: 'A-', minScore: 547.9 }, { grade: 'BBB+', minScore: 539.5 }, { grade: 'BBB', minScore: 533.2 },
  { grade: 'BBB-', minScore: -Infinity },
];
function riskGradeDistribution(scores: number[]) {
  const counts: Record<string, number> = Object.fromEntries(RISK_GRADES.map(g => [g.grade, 0]));
  for (const s of scores) counts[RISK_GRADES.find(g => s >= g.minScore)!.grade]++;
  const n = scores.length || 1;
  return RISK_GRADES.map(g => ({ grade: g.grade, count: counts[g.grade], pct: +((counts[g.grade] / n) * 100).toFixed(1) }));
}

export function runMonitoring(input: MonitoringInput) {
  const { model, fileName, anomalyScreening = true } = input;
  const scoring = (model.scoring ?? { base_points: 0, factor: 1, offset: 0, features: [], scorecard: {} }) as ScoringConfig;
  const registry = (model.featureRegistry ?? {}) as Record<string, FeatureDefinition>;
  const thresholds = model.thresholds as MonitoringThresholds;
  const referenceId: string = model.referenceDatasetId;
  const idColumn: string = model.idColumn ?? 'customer_id';
  const dateColumn: string | null = model.dateColumn === null || model.dateColumn === '' ? null : (model.dateColumn ?? 'application_date');
  const labelColumn: string = model.labelColumn ?? 'default_flag';
  const scoreColumn: string | undefined = model.scoreColumn ?? undefined;

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
    labelColumn,
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
    excludedRows: [],
    uploadSummary,
  };
  if (!validation.ok) return { run, scored: [] as ReturnType<typeof scoreRows>, riskGradeDist: [], skipped: {} };

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
    scoring.scorecard && Object.keys(scoring.scorecard).length > 0 && (scoring.features?.length ?? 0) > 0,
  );
  const scored = scoreRows(official, scoring);
  const officialScores = hasScorecard
    ? scored.map(s => s.aScore)
    : scoreColumn
      ? official.map(r => r.values[scoreColumn]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      : [];

  // ── [4] Drift (official) ──
  const minRows = ValidationDefaults.minRowsForDrift;
  let skipped: Record<string, string> = {};
  if (official.length > 0) {
    const r = driftFor(reference, official, officialScores, registry, thresholds);
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
      const keptScores = kept.map(r => calculateAScore(scoring, r.values));
      // Symmetric: drop reference rows flagged by the same rules, keep the ORIGINAL bins.
      const refKept = referenceWithout(reference, referenceFlaggedIndices(reference, model));
      const frozen = freezeCsiBins(registry, thresholds, reference);
      run.driftExcludingFlagged = driftFor(refKept, kept, keptScores, registry, frozen).drift;
    }
  }

  if (run.anomaly) run.anomaly = truncateAnomalyResult(run.anomaly, input.maxStoredFlaggedRows ?? resolveAnomalyConfig(model, reference).maxStoredRows);

  return { run, scored, riskGradeDist: riskGradeDistribution(scored.map(s => s.aScore)), skipped };
}

const ValidationDefaults = { minRowsForDrift: 100 };   // keep in sync with validateDataset default

/** Pin every CSI feature's bins/labels/threshold to what the FULL reference resolves to (no re-binning on a reduced reference). */
function freezeCsiBins(registry: Record<string, FeatureDefinition>, thresholds: MonitoringThresholds, fullRef: ReturnType<typeof getReferenceProfile>): MonitoringThresholds {
  const csi_features: MonitoringThresholds['csi_features'] = {};
  for (const f of resolveCsiFeatures(registry, thresholds, fullRef)) {
    if (f.skipped) continue;
    csi_features[f.key] = { label: f.displayName, source: f.source, threshold: f.threshold, bins: f.bins, bin_labels: f.labels };
  }
  return { ...thresholds, csi_features };
}

function driftFor(
  reference: ReturnType<typeof getReferenceProfile>, rows: CleanRow[], scores: number[],
  registry: Record<string, FeatureDefinition>, thresholds: MonitoringThresholds,
) {
  const actualFeatures: Record<string, number[]> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.values)) (actualFeatures[k] ??= []).push(v);
  const { skipped, ...drift } = runDriftDetection(reference, scores, actualFeatures, registry, thresholds);
  return { drift, skipped };
}
function scoreRows(clean: CleanRow[], scoring: ScoringConfig) {
  const hasCard = Boolean(scoring?.scorecard && Object.keys(scoring.scorecard).length > 0 && scoring.features?.length);
  return clean.map(r => {
    const aScore = hasCard ? calculateAScore(scoring, r.values) : 0;
    const bins: Record<string, number> = {};
    if (hasCard) {
      for (const f of scoring.features) {
        if (scoring.scorecard[f]?.bins) bins[`${f}_bin`] = getBinIndex(r.values[f], scoring.scorecard[f].bins);
      }
    }
    return {
      row: r.row,
      customer_id: r.id,
      ...Object.fromEntries((scoring.features ?? []).map(f => [f, r.values[f]])),
      ...bins,
      aScore,
      pd: hasCard ? scoreToPD(scoring, aScore) : 0,
      defaultLabel: r.label,
      imputed: r.imputed,
    };
  });
}
