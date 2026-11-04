/**
 * Monitoring pipeline (server side):
 *
 *   CSV text ──► parseCsv ──► [1] Data Validation ──► [2] Scoring ──► [3] Drift Detection ──► MonitoringRun
 *                                   │ blocked                                                  │
 *                                   └──────────────► MonitoringRun (drift = null) ◄────────────┘
 *
 * Each stage is a pure function in lib/; this module only wires them together
 * so the same pipeline can be reused by the future Sandbox (with injected anomalies).
 */
import type { FeatureDefinition, MonitoringRun, MonitoringThresholds, ScoringConfig } from './types';
import { parseCsv } from './csv';
import { validateDataset, isValidDate, type CleanRow } from './validation';
import { calculateAScore, scoreToPD } from './scoring';
import { getReferenceProfile } from './reference';
import { runDriftDetection } from './drift';
import { getBinIndex } from './stats';

export interface MonitoringInput {
  model: any;                       // effective model (bundled + overrides)
  fileName: string;
  csvText?: string;
  rows?: Record<string, unknown>[]; // alternative to csvText (legacy clients)
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

export function buildUploadSummary(rows: Record<string, unknown>[], registry: Record<string, FeatureDefinition>) {
  const total = rows.length || 1;
  const periodCounts: Record<string, number> = {};
  for (const r of rows) {
    const p = toPeriod(r['application_date']) ?? UNKNOWN_PERIOD;
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
  const { model, fileName } = input;
  const scoring = model.scoring as ScoringConfig;
  const registry = (model.featureRegistry ?? {}) as Record<string, FeatureDefinition>;
  const thresholds = model.thresholds as MonitoringThresholds;
  const referenceId: string = model.referenceDatasetId;

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
    scoringFeatures: scoring.features, malformedRows,
  });
  const uploadSummary = buildUploadSummary(rows, registry);

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
    uploadSummary,
  };
  if (!validation.ok) return { run, scored: [] as ReturnType<typeof scoreRows>, riskGradeDist: [], skipped: {} };

  // ── [2] Scoring ──
  const scored = scoreRows(clean, scoring);

  // ── [3] Drift ──
  const reference = getReferenceProfile(referenceId, scoring);
  const actualFeatures: Record<string, number[]> = {};
  for (const r of clean) for (const [k, v] of Object.entries(r.values)) (actualFeatures[k] ??= []).push(v);
  const { skipped, ...drift } = runDriftDetection(reference, scored.map(s => s.aScore), actualFeatures, registry, thresholds);
  run.drift = drift;

  return { run, scored, riskGradeDist: riskGradeDistribution(scored.map(s => s.aScore)), skipped };
}

function scoreRows(clean: CleanRow[], scoring: ScoringConfig) {
  return clean.map(r => {
    const aScore = calculateAScore(scoring, r.values);
    const bins: Record<string, number> = {};
    for (const f of scoring.features) bins[`${f}_bin`] = getBinIndex(r.values[f], scoring.scorecard[f].bins);
    return {
      row: r.row,
      customer_id: r.id,
      ...Object.fromEntries(scoring.features.map(f => [f, r.values[f]])),
      ...bins,
      aScore,
      pd: scoreToPD(scoring, aScore),
      defaultLabel: r.label,
      imputed: r.imputed,
    };
  });
}
