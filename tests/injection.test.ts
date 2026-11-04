import { describe, expect, it } from 'vitest';
import { injectAnomaly, EXPECTED_LAYER, SEVERITY_TABLE, ANOMALY_KIND, expectedFor } from '../lib/injection';
import { runMonitoring } from '../lib/monitoring';
import { getReferenceRows } from '../lib/reference';
import type { AnomalyType } from '../lib/types';
import modelConfig from '../app/model-config.json';

const model = structuredClone((modelConfig as any).models.ascore_v1);
const N_REF = getReferenceRows(model.referenceDatasetId).rows.length;
const GROUP_A = (Object.keys(ANOMALY_KIND) as AnomalyType[]).filter(t => ANOMALY_KIND[t] === 'data_error');
const ALL_TYPES = Object.keys(ANOMALY_KIND) as AnomalyType[];
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;

describe('anomaly injection (sandbox)', () => {
  it('(1) same seed → identical csvText; different seed → different', () => {
    const a = injectAnomaly(model, { type: 'unit_error', seed: 7 });
    const b = injectAnomaly(model, { type: 'unit_error', seed: 7 });
    const c = injectAnomaly(model, { type: 'unit_error', seed: 8 });
    expect(b.csvText).toBe(a.csvText);
    expect(c.csvText).not.toBe(a.csvText);
  });

  it('(2) injected count = round(rate × n) for every group-A type (schema_break is file-level: all rows)', () => {
    const out: Record<string, unknown>[] = [];
    for (const type of GROUP_A) for (const [rate, n] of [[0.05, N_REF], [0.13, 400], [0.5, 101]] as const) {
      const r = injectAnomaly(model, { type, rate, n, seed: 3 });
      const injected = r.groundTruth.filter(g => g.injected).length;
      const expected = type === 'schema_break' ? n : Math.round(rate * n);
      out.push({ type, rate, n, injected, expected });
      expect(injected).toBe(expected);
      expect(r.spec.injectedCount).toBe(injected);
    }
    console.table(out.filter(o => o.rate === 0.05));
  });

  it('(3) groundTruth row numbers match CleanRow.row after runMonitoring (duplicate_rows)', () => {
    const inj = injectAnomaly(model, { type: 'duplicate_rows', rate: 0.05, seed: 11 });
    expect(inj.rows.length).toBe(N_REF + Math.round(0.05 * N_REF));
    const { run, scored } = runMonitoring({ model, fileName: 'dup.csv', csvText: inj.csvText });
    const byRow = new Map(inj.groundTruth.map(g => [g.row, g]));
    for (const s of scored) expect(byRow.get(s.row)?.id).toBe(s.customer_id);
    const dupIssueRows = run.validation.issues.filter(i => i.type === 'DUPLICATE_ID').map(i => i.row).sort((a, b) => a! - b!);
    const injectedRows = inj.groundTruth.filter(g => g.injected).map(g => g.row);
    expect(dupIssueRows).toEqual(injectedRows);
  });

  it('(4) none → no injected rows', () => {
    const r = injectAnomaly(model, { type: 'none', seed: 5 });
    expect(r.groundTruth.some(g => g.injected)).toBe(false);
    expect(r.expected).toEqual({ layer: 'none', shouldAlarm: false });
  });

  it('(5) mean_shift δ = −20% lowers the mean by ≈ 20%', () => {
    const base = injectAnomaly(model, { type: 'none', seed: 9 });
    const shifted = injectAnomaly(model, { type: 'mean_shift', severity: 'medium', seed: 9 });
    const m0 = mean(base.rows.map(r => Number(r.monthly_income)));
    const m1 = mean(shifted.rows.map(r => Number(r.monthly_income)));
    expect(SEVERITY_TABLE.mean_shift.medium).toBe(-0.2);
    expect(m1 / m0).toBeCloseTo(0.8, 2);
  });

  it('(6) schema_break → validation.ok = false', () => {
    for (const severity of ['low', 'medium', 'high'] as const) {
      const r = injectAnomaly(model, { type: 'schema_break', severity, seed: 1 });
      expect(runMonitoring({ model, fileName: 's.csv', csvText: r.csvText }).run.validation.ok).toBe(false);
    }
  });

  it('expected layer table (hypothesis) is complete and unit_error/high → validation', () => {
    for (const t of ALL_TYPES) expect(EXPECTED_LAYER[t]).toBeDefined();
    expect(expectedFor('unit_error', 'high').layer).toBe('validation');
    expect(expectedFor('unit_error', 'medium').layer).toBe('anomaly');
  });

  it('(7) preliminary report: every type, severity medium, rate 0.05 (B: rate 1), seed 42', () => {
    const table: Record<string, unknown>[] = [];
    for (const type of ALL_TYPES) {
      const inj = injectAnomaly(model, { type, severity: 'medium', seed: 42 });
      const { run } = runMonitoring({ model, fileName: `${type}.csv`, csvText: inj.csvText });
      const injected = inj.groundTruth.filter(g => g.injected).map(g => g.row);
      const issueRows = new Set(run.validation.issues.map(i => i.row));
      const blocked = !run.validation.ok;
      const layer2 = injected.filter(r => blocked || issueRows.has(r));
      const fl = new Map((run.anomaly?.flaggedRows ?? []).map(f => [f.row, f.methods]));
      const by = (m: string) => injected.filter(r => fl.get(r)?.includes(m as any)).length;
      const anomaly = injected.filter(r => fl.has(r));
      const missed = injected.filter(r => !(blocked || issueRows.has(r)) && !fl.has(r)).length;
      table.push({
        type, expected: inj.expected.layer, injected: injected.length,
        layer2: layer2.length, anomaly: anomaly.length,
        iqr: by('iqr'), mad: by('mad'), xf: by('cross_field'), IF: by('isolation_forest'), LOF: by('lof'),
        missed,
        drift: run.drift?.overallStatus ?? 'BLOCKED',
        psi: run.drift ? +run.drift.psi.value.toFixed(4) : null,
        driftExFlag: run.driftExcludingFlagged?.overallStatus ?? (run.drift ? 'n/a' : 'BLOCKED'),
        psiExFlag: run.driftExcludingFlagged ? +run.driftExcludingFlagged.psi.value.toFixed(4) : null,
        fileFlagged: run.anomaly?.flaggedRowCount ?? null,
      });
    }
    console.log('REPORT7 ' + JSON.stringify(table));
    console.table(table);
  });
});
