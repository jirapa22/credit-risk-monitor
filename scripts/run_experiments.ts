/**
 * Full experiment grid → results/*.csv
 *
 *   npm run experiments                              # full grid (default model)
 *   npm run experiments -- --quick                   # seeds 1–3 (smoke test)
 *   npm run experiments -- --quick --model ascore_v1 # specify modelId
 *
 * Outputs (results/<timestamp>_<commit>_<modelId>[_quick]_*):
 *   trials_raw.csv     one row per trial × detector
 *   summary.csv        mean / SD / 95% CI by type × severity × rate × detector
 *   batch_summary.csv  file-level rates by type × severity × rate
 *   run_meta.json      config, commit, timing, trial count
 */
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTrial, DETECTORS, stat, rate as rateStat, summarizeTriggerActions, type TrialResult } from '../lib/experiment';
import { ANOMALY_KIND, SEVERITY_TABLE, EXPECTED_LAYER } from '../lib/injection';
import { registerReferenceDataset } from '../lib/reference';
import { loadReferenceDatasetBlob } from '../lib/storage/blob';
import { getDefaultModelId, getEffectiveModel } from '../lib/storage/repositories';
import type { AnomalySeverity, AnomalyType } from '../lib/types';

function parseModelArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--model=')) return argv[i].slice('--model='.length);
  }
  return undefined;
}

async function main() {
  const quick = process.argv.includes('--quick');
  const requestedModelId = parseModelArg(process.argv) || (await getDefaultModelId());
  const model = await getEffectiveModel(requestedModelId);
  const refBlob = await loadReferenceDatasetBlob(model.referenceDatasetId);
  if (refBlob) {
    registerReferenceDataset(refBlob.meta, refBlob.rows);
  }

  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const SEV: AnomalySeverity[] = ['low', 'medium', 'high'];
  const RATES = [0.01, 0.05, 0.10, 0.20, 0.30];
  const seeds = (full: number) => range(1, quick ? Math.min(3, full) : full);

  const types = Object.keys(ANOMALY_KIND) as AnomalyType[];

  type Cell = { type: AnomalyType; severity: AnomalySeverity; rate: number; seed: number };
  const grid: Cell[] = [];
  for (const type of types) {
    const kind = ANOMALY_KIND[type];
    if (type === 'none') { for (const seed of seeds(100)) grid.push({ type, severity: 'none', rate: 0, seed }); continue; }
    if (type === 'schema_break') { for (const severity of SEV) for (const seed of seeds(5)) grid.push({ type, severity, rate: 0.05, seed }); continue; }
    if (kind === 'drift') { for (const severity of SEV) for (const seed of seeds(30)) grid.push({ type, severity, rate: 1, seed }); continue; }
    for (const severity of SEV) for (const rate of RATES) for (const seed of seeds(30)) grid.push({ type, severity, rate, seed });
  }

  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a git repo */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(process.cwd(), 'results');
  mkdirSync(outDir, { recursive: true });
  const baseName = `${stamp}_${commit}_${model.id}${quick ? '_quick' : ''}`;
  const prefix = join(outDir, baseName);

  // ── Run ──
  const results: { cell: Cell; t: TrialResult }[] = [];
  const t0 = Date.now();
  const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${s.toFixed(0)}s`);
  grid.forEach((cell, i) => {
    const t = runTrial(model, { type: cell.type, severity: cell.severity, rate: cell.rate, seed: cell.seed });
    results.push({ cell, t });
    if ((i + 1) % 10 === 0 || i === grid.length - 1) {
      const el = (Date.now() - t0) / 1000, eta = (el / (i + 1)) * (grid.length - i - 1);
      process.stdout.write(`\r[${i + 1}/${grid.length}] (${model.id}) ${((i + 1) / grid.length * 100).toFixed(1)}%  elapsed ${fmtSec(el)}  ETA ${fmtSec(eta)}   `);
    }
  });
  const elapsedSec = (Date.now() - t0) / 1000;
  process.stdout.write('\n');

  // ── CSV helpers ──
  const csvCell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(6)) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const writeCsv = (file: string, rows: Record<string, unknown>[]) => {
    const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
    writeFileSync(file, [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n');
  };
  const csiCols = (pfx: string, d: TrialResult['drift']) =>
    Object.fromEntries(Object.entries(d?.csi ?? {}).map(([k, v]) => [`${pfx}csi_${k}`, v]));

  // ── trials_raw.csv ──
  const raw: Record<string, unknown>[] = [];
  for (const { cell, t } of results) for (const det of DETECTORS) {
    const m = t.detectors[det];
    raw.push({
      modelId: model.id, configVersion: model.configVersion, referenceId: model.referenceDatasetId,
      type: cell.type, kind: t.kind, severity: cell.severity, rate: cell.rate, seed: cell.seed,
      expected_layer: t.expected.layer, detector: det,
      n: m.n, TP: m.TP, FP: m.FP, FN: m.FN, TN: m.TN, precision: m.precision, recall: m.recall, f1: m.f1, flagRate: m.flagRate,
      blocked: t.file.blocked, alarm: t.file.alarm, alarm_excl_flagged: t.file.alarmExcludingFlagged,
      falseAlarm: t.file.falseAlarm, rescued: t.file.rescued, detected: t.file.detected, preserved: t.file.preserved,
      routed_layer: t.file.routedLayer, routingCorrect: t.file.routingCorrect,
      trigger_action: t.triggerAction,
      status: t.drift?.status ?? 'BLOCKED', psi: t.drift?.psi, ...csiCols('', t.drift),
      status_excl: t.driftExcludingFlagged?.status ?? '', psi_excl: t.driftExcludingFlagged?.psi, ...csiCols('excl_', t.driftExcludingFlagged),
      rows: t.rowCount, injected: t.injectedCount, ms: +t.timingMs.toFixed(1),
    });
  }
  writeCsv(`${prefix}_trials_raw.csv`, raw);

  // ── summary.csv ──
  const groupKey = (c: Cell) => `${c.type}|${c.severity}|${c.rate}`;
  const groups = new Map<string, { cell: Cell; ts: TrialResult[] }>();
  for (const { cell, t } of results) {
    const g = groups.get(groupKey(cell)) ?? { cell, ts: [] };
    g.ts.push(t); groups.set(groupKey(cell), g);
  }
  const summary: Record<string, unknown>[] = [];
  for (const { cell, ts } of groups.values()) for (const det of DETECTORS) {
    const row: Record<string, unknown> = {
      modelId: model.id, configVersion: model.configVersion, referenceId: model.referenceDatasetId,
      type: cell.type, kind: ts[0].kind, severity: cell.severity, rate: cell.rate, detector: det, trials: ts.length,
    };
    for (const metric of ['precision', 'recall', 'f1', 'flagRate'] as const) {
      const s = stat(ts.map(t => t.detectors[det][metric]));
      Object.assign(row, { [`${metric}_n`]: s.n, [`${metric}_mean`]: s.mean, [`${metric}_sd`]: s.sd, [`${metric}_ci_low`]: s.ciLow, [`${metric}_ci_high`]: s.ciHigh });
    }
    summary.push(row);
  }
  writeCsv(`${prefix}_summary.csv`, summary);

  // ── batch_summary.csv ──
  const batch: Record<string, unknown>[] = [];
  for (const { cell, ts } of groups.values()) {
    const row: Record<string, unknown> = {
      modelId: model.id, configVersion: model.configVersion, referenceId: model.referenceDatasetId,
      type: cell.type, kind: ts[0].kind, severity: cell.severity, rate: cell.rate,
      expected_layer: ts[0].expected.layer,
      expected_section: ts[0].expected.section ?? 'none',
      trials: ts.length,
    };
    for (const f of ['blocked', 'alarm', 'falseAlarm', 'rescued', 'detected', 'preserved', 'routingCorrect'] as const) {
      const s = rateStat(ts.map(t => t.file[f] as boolean | null));
      Object.assign(row, { [`${f}_rate`]: s.mean, [`${f}_ci_low`]: s.ciLow, [`${f}_ci_high`]: s.ciHigh });
    }
    const psi = stat(ts.map(t => t.drift?.psi)), psiEx = stat(ts.map(t => t.driftExcludingFlagged?.psi ?? t.drift?.psi));
    Object.assign(row, { psi_mean: psi.mean, psi_sd: psi.sd, psi_excl_mean: psiEx.mean, psi_excl_sd: psiEx.sd }, summarizeTriggerActions(ts));
    batch.push(row);
  }
  writeCsv(`${prefix}_batch_summary.csv`, batch);

  // ── run_meta.json ──
  writeFileSync(`${prefix}_run_meta.json`, JSON.stringify({
    commit, startedAt: new Date(t0).toISOString(), elapsedSec, trials: grid.length, msPerTrial: (elapsedSec * 1000) / grid.length,
    quick, grid: { severities: SEV, rates: RATES, seeds: { groupA: seeds(30).length, schema_break: seeds(5).length, drift: seeds(30).length, none: seeds(100).length } },
    modelId: model.id, configVersion: model.configVersion, referenceId: model.referenceDatasetId,
    anomalyConfig: model.anomalyConfig ?? null, forestSeed: 42,
    severityTable: SEVERITY_TABLE, expectedLayer: EXPECTED_LAYER,
  }, null, 2) + '\n');

  console.log(`\nDone (${model.id}): ${grid.length} trials in ${fmtSec(elapsedSec)} (${((elapsedSec * 1000) / grid.length).toFixed(1)} ms/trial)`);

  // ── Step 11a: Report New Drift Scenarios Summary Table (Medium Severity) ──
  const NEW_TYPES: AnomalyType[] = ['label_shift', 'concept_shift', 'mix_shift', 'missing_drift'];
  const newTypeRows: Record<string, unknown>[] = [];
  for (const nType of NEW_TYPES) {
    const medTrials = results.filter(r => r.cell.type === nType && r.cell.severity === 'medium');
    if (medTrials.length === 0) continue;
    const tFirst = medTrials[0].t;
    if (tFirst.spec.skipped) {
      newTypeRows.push({
        'ชนิด': nType,
        'Section ที่คาด': tFirst.expected.section ?? 'drift',
        'Section ที่เตือนจริง': 'ข้าม (skipped)',
        'sectionLeakage': '-',
        'Trigger ที่ได้': '-',
        'ตรงกับที่คาดไหม': `ข้าม: ${tFirst.spec.skipReason}`,
      });
      continue;
    }

    const expSec = tFirst.expected.section ?? 'none';
    const routingOkRate = rateStat(medTrials.map(m => m.t.file.routingCorrect)).mean ?? 0;
    const triggerOkRate = rateStat(medTrials.map(m => m.t.triggerCorrect)).mean ?? 0;
    const allLeakages = [...new Set(medTrials.flatMap(m => m.t.sectionLeakage))];
    const triggerActions = [...new Set(medTrials.map(m => m.t.triggerAction))];

    newTypeRows.push({
      'ชนิด': nType,
      'Section ที่คาด': expSec,
      'Section ที่เตือนจริง': (tFirst.file.routingCorrect ? expSec : 'none') + (allLeakages.length > 0 ? ` + ${allLeakages.join(', ')}` : ''),
      'sectionLeakage': allLeakages.length > 0 ? allLeakages.join(', ') : 'ไม่มี (none)',
      'Trigger ที่ได้': triggerActions.join(', '),
      'ตรงกับที่คาดไหม': routingOkRate >= 0.8 && triggerOkRate >= 0.8 ? '✅ ตรง' : '⚠️ ไม่ตรงบางส่วน',
    });
  }

  if (newTypeRows.length > 0) {
    console.log(`\n══════════════════════════════════════════════════════════════════════════`);
    console.log(`  Step 11a: New Drift Injections (Severity Medium)`);
    console.log(`══════════════════════════════════════════════════════════════════════════`);
    console.table(newTypeRows);
  }

  // ── public/experiments/latest_summary.json (same data as summary + batch + meta, for the web UI) ──
  const publicDir = join(process.cwd(), 'public', 'experiments');
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, quick ? 'latest_summary_quick.json' : 'latest_summary.json'), JSON.stringify({
    meta: {
      commit, startedAt: new Date(t0).toISOString(), elapsedSec, trials: grid.length, msPerTrial: (elapsedSec * 1000) / grid.length,
      quick, modelId: model.id, configVersion: model.configVersion, referenceId: model.referenceDatasetId, forestSeed: 42,
      severities: SEV, rates: RATES, files: `${baseName}_*`,
    },
    summary,
    batch,
  }) + '\n');
  console.log(`→ ${prefix}_{trials_raw,summary,batch_summary}.csv, _run_meta.json`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
