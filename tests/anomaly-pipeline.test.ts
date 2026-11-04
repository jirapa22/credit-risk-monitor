import { describe, expect, it } from 'vitest';
import { runMonitoring } from '../lib/monitoring';
import { validateDataset } from '../lib/validation';
import { parseCsv } from '../lib/csv';
import { calculateAScore } from '../lib/scoring';
import { getReferenceProfile } from '../lib/reference';
import { runDriftDetection } from '../lib/drift';
import { getBinIndex } from '../lib/stats';
import { quantile } from '../lib/anomaly/univariate';
import type { DriftResult, FeatureDefinition, MonitoringRun } from '../lib/types';
import modelConfig from '../app/model-config.json';
import refFile from '../data/reference/ascore_v1_dev855.json';

const model = structuredClone((modelConfig as any).models.ascore_v1);
const reference = getReferenceProfile(model.referenceDatasetId, model.scoring);
const COLS = (refFile as any).meta.columns as string[];
type Row = Record<string, string | number>;
const refRows = (): Row[] => ((refFile as any).rows as Row[]).map(r => ({ ...r }));
const toCsv = (rows: Row[]) => [COLS.join(','), ...rows.map(r => COLS.map(c => r[c] ?? '').join(','))].join('\n');
const pctOf = (f: string, p: number) => quantile([...reference.features[f]].sort((a, b) => a - b), p);
const noIncomeMax = () => { const m = structuredClone(model); m.featureRegistry.monthly_income.validation.maxValue = null; return m; };

/** Drift exactly as the pre-Step-3 pipeline computed it (validate → score → drift on all clean rows). */
function legacyDrift(csv: string, m = model): DriftResult {
  const p = parseCsv(csv);
  const { rows } = validateDataset(p.rows, p.headers, m.featureRegistry as Record<string, FeatureDefinition>, { scoringFeatures: m.scoring.features, malformedRows: p.malformedRows });
  const feats: Record<string, number[]> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.values)) (feats[k] ??= []).push(v);
  const { skipped: _s, ...d } = runDriftDetection(reference, rows.map(r => calculateAScore(m.scoring, r.values)), feats, m.featureRegistry, m.thresholds);
  return d;
}
const summary = (d: DriftResult | null | undefined) =>
  d ? { psi: +d.psi.value.toFixed(4), ...Object.fromEntries(Object.entries(d.csi).map(([k, v]) => [`csi_${k}`, +v.value.toFixed(4)])), status: d.overallStatus } : null;
const flaggedOf = (run: MonitoringRun, row: number) => run.anomaly?.flaggedRows.find(f => f.row === row);
const rejectedRows = (run: MonitoringRun) => new Set(run.validation.issues.filter(i => i.severity === 'error').map(i => i.row));
const table = (label: string, rows: Record<string, unknown>[]) => { console.log(`\n${label}`); console.table(rows); };

describe('pipeline — anomaly screening layer', () => {
  it('(1) regression: unmodified reference rows → drift identical to the pre-step pipeline', () => {
    const csv = toCsv(refRows());
    const { run } = runMonitoring({ model, fileName: 'ref.csv', csvText: csv });
    expect(run.drift).toEqual(legacyDrift(csv));
    expect(run.excludedRows).toEqual([]);
    table('(1) screening on clean reference file', [{ ...run.anomaly!.byMethod, flagged: run.anomaly!.flaggedRowCount, pct: run.anomaly!.flaggedPct, referenceFlagged: run.anomaly!.referenceFlaggedCount, totalMs: run.anomaly!.timing.totalMs }]);
  });

  it('(2) income ×10 row (passes validation) and a (2c)-style row are flagged by the anomaly layer', () => {
    const rows = refRows();
    rows[9].monthly_income = Number(rows[9].monthly_income) * 10;   // row 10
    Object.assign(rows[19], { monthly_income: pctOf('monthly_income', 0.05), loan_amount: pctOf('loan_amount', 0.99), dti_ratio: pctOf('dti_ratio', 0.02) }); // row 20
    const { run } = runMonitoring({ model, fileName: 'x.csv', csvText: toCsv(rows) });
    const r10 = flaggedOf(run, 10), r20 = flaggedOf(run, 20);
    table('(2) injected rows', [
      { row: 10, kind: 'income ×10', value: rows[9].monthly_income, rejectedByValidation: rejectedRows(run).has(10), methods: r10?.methods.join(',') },
      { row: 20, kind: 'p5/p99/p2 combo', value: `${rows[19].monthly_income}/${rows[19].loan_amount}/${rows[19].dti_ratio}`, rejectedByValidation: rejectedRows(run).has(20), methods: r20?.methods.join(',') },
    ]);
    expect(rejectedRows(run).has(10)).toBe(false);
    expect(r10?.methods).toEqual(expect.arrayContaining(['iqr', 'mad']));
    expect(r20?.methods).toEqual(expect.arrayContaining(['lof']));
  });

  it('(2a) income ×1000 on the real config → rejected by validation (layer 2), not in flaggedRows', () => {
    const rows = refRows();
    rows[9].monthly_income = Number(rows[9].monthly_income) * 1000;
    const { run } = runMonitoring({ model, fileName: 'x.csv', csvText: toCsv(rows) });
    const issue = run.validation.issues.find(i => i.row === 10);
    table('(2a) ×1000 on real config', [{ row: 10, value: rows[9].monthly_income, validationIssue: issue?.type, column: issue?.column, inFlaggedRows: !!flaggedOf(run, 10) }]);
    expect(issue?.type).toBe('OUT_OF_RANGE');
    expect(issue?.column).toBe('monthly_income');
    expect(flaggedOf(run, 10)).toBeUndefined();
  });

  it('(2b) income ×1000 with no maxValue rule → caught by layer 3 (iqr + mad)', () => {
    const rows = refRows();
    rows[9].monthly_income = Number(rows[9].monthly_income) * 1000;
    const { run } = runMonitoring({ model: noIncomeMax(), fileName: 'x.csv', csvText: toCsv(rows) });
    const r10 = flaggedOf(run, 10);
    table('(2b) ×1000 without maxValue', [{ row: 10, value: rows[9].monthly_income, rejectedByValidation: rejectedRows(run).has(10), methods: r10?.methods.join(',') }]);
    expect(rejectedRows(run).has(10)).toBe(false);
    expect(r10?.methods).toEqual(expect.arrayContaining(['iqr', 'mad']));
  });

  it('(3) excludeRows: excluded row is not counted in drift and is audit-logged', () => {
    const { run } = runMonitoring({ model, fileName: 'x.csv', csvText: toCsv(refRows()), excludeRows: [5, 99999] });
    expect(run.excludedRows).toEqual([5]);
    const n = run.drift!.psi.bins.reduce((s, b) => s + b.actualCount, 0);
    expect(n).toBe(run.validation.validRows - 1);
    for (const c of Object.values(run.drift!.csi)) expect(c.bins.reduce((s, b) => s + b.actualCount, 0)).toBe(run.validation.validRows - 1);
    table('(3) excludeRows', [{ requested: '5, 99999', excludedRows: run.excludedRows!.join(','), validRows: run.validation.validRows, countedInPsi: n }]);
  });

  it('(4) run survives JSON round-trip; extreme flags are kept', () => {
    const m = structuredClone(model);
    m.featureRegistry.loan_amount.validation.minValue = null;   // let a negative value through validation
    const rows = refRows();
    rows[2].loan_amount = -100;                                  // row 3 → log1p impossible → ±Infinity score
    const { run } = runMonitoring({ model: m, fileName: 'neg.csv', csvText: toCsv(rows) });
    const back = JSON.parse(JSON.stringify(run));
    const r3 = back.anomaly.flaggedRows.find((f: any) => f.row === 3);
    const extreme = (r3?.flags ?? []).filter((f: any) => f.extreme === true);
    table('(4) JSON round-trip', extreme.map((f: any) => ({ row: f.row, method: f.method, feature: f.feature, value: f.value, score: f.score, extreme: f.extreme })));
    expect(extreme.length).toBeGreaterThan(0);
    expect(extreme.every((f: any) => f.score === null)).toBe(true);
  });

  it('(5) anomalyScreening: false → anomaly null, drift unchanged', () => {
    const csv = toCsv(refRows());
    const on = runMonitoring({ model, fileName: 'x.csv', csvText: csv }).run;
    const off = runMonitoring({ model, fileName: 'x.csv', csvText: csv, anomalyScreening: false }).run;
    expect(off.anomaly).toBeNull();
    expect(off.driftExcludingFlagged).toBeNull();
    expect(off.drift).toEqual(on.drift);
    table('(5) screening on/off', [{ mode: 'on', ...summary(on.drift) }, { mode: 'off', ...summary(off.drift) }]);
  });

  it('(6) ~5% income ×10 rows: drift CSI(income) clearly higher than symmetric driftExcludingFlagged', () => {
    const rows = refRows();
    const injected: number[] = [];
    for (let i = 0; i < rows.length; i += 20) { rows[i].monthly_income = Number(rows[i].monthly_income) * 10; injected.push(i + 1); }
    const { run } = runMonitoring({ model, fileName: 'unit_x10.csv', csvText: toCsv(rows) });
    const rej = rejectedRows(run);
    const flagged = new Set(run.anomaly!.flaggedRows.map(f => f.row));
    const byLayer2 = injected.filter(r => rej.has(r)).length;
    const byAnomaly = injected.filter(r => flagged.has(r)).length;
    const missed = injected.filter(r => !rej.has(r) && !flagged.has(r)).length;

    table('(6) injected rows', [{ injected: injected.length, pct: +(injected.length / rows.length * 100).toFixed(1), caughtByLayer2: byLayer2, caughtByAnomaly: byAnomaly, missed, flaggedTotal: run.anomaly!.flaggedRowCount, referenceFlagged: run.anomaly!.referenceFlaggedCount }]);
    table('(6) drift vs driftExcludingFlagged (symmetric)', [{ set: 'drift (all rows)', ...summary(run.drift) }, { set: 'excl. flagged (both sides)', ...summary(run.driftExcludingFlagged) }]);

    // (C) where do ×10 rows land? scorecard bins and CSI bins for monthly_income
    const sc = model.scoring.scorecard.monthly_income.bins as number[];
    const csiBins = run.drift!.csi.monthly_income.bins.map(b => b.label);
    const csiB = model.thresholds.csi_features.monthly_income.bins as number[];
    const orig = refRows();
    const moves: Record<string, number> = {};
    for (const r of injected) {
      if (rej.has(r)) continue;
      const before = getBinIndex(Number(orig[r - 1].monthly_income), sc), after = getBinIndex(Number(rows[r - 1].monthly_income), sc);
      const k = `${before}→${after}`; moves[k] = (moves[k] ?? 0) + 1;
    }
    table('(C) monthly_income bins', [
      { kind: 'scorecard', boundaries: sc.join(', '), lastBin: `> ${sc[sc.length - 1]} (open, no upper edge)`, points: (model.scoring.scorecard.monthly_income.points as number[]).join(', ') },
      { kind: 'CSI', boundaries: csiB.join(', '), lastBin: csiBins[csiBins.length - 1], points: '' },
    ]);
    table('(C) ×10 rows: scorecard bin before → after (CSI bins identical)', Object.entries(moves).map(([k, n]) => ({ move: k, rows: n })));

    expect(missed).toBe(0);
    expect(byAnomaly).toBe(injected.length - byLayer2);
    expect(run.driftExcludingFlagged).not.toBeNull();
    expect(run.drift!.csi.monthly_income.value).toBeGreaterThan(run.driftExcludingFlagged!.csi.monthly_income.value * 2);
  });

  it('(7) clean file: symmetric driftExcludingFlagged PSI ≈ 0 and not above drift by > 0.002', () => {
    const { run } = runMonitoring({ model, fileName: 'clean.csv', csvText: toCsv(refRows()) });
    table('(7) clean file', [{ set: 'drift', ...summary(run.drift) }, { set: 'excl. flagged (both sides)', ...summary(run.driftExcludingFlagged) }]);
    expect(run.driftExcludingFlagged).not.toBeNull();
    expect(run.driftExcludingFlagged!.psi.value).toBeLessThan(0.005);
    expect(run.driftExcludingFlagged!.psi.value - run.drift!.psi.value).toBeLessThanOrEqual(0.002);
  });
});
