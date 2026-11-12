/**
 * Full experiment grid → results/*.csv
 *
 *   npm run experiments            # full grid
 *   npm run experiments -- --quick # seeds 1–3 (smoke test)
 *   npm run experiments -- --resume # resumes interrupted run
 *   npm run experiments -- --model ext_model
 *
 * Outputs (results/<timestamp>_<commit>_*):
 *   trials_raw.csv     one row per trial × detector
 *   summary.csv        mean / SD / 95% CI by type × severity × rate × detector
 *   batch_summary.csv  file-level rates by type × severity × rate
 *   run_meta.json      config, commit, timing, trial count
 */
import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTrial, DETECTORS, stat, rate as rateStat, summarizeTriggerActions, type TrialResult } from '../lib/experiment';
import { SEVERITY_TABLE, EXPECTED_LAYER } from '../lib/injection';
import { registerReferenceDataset } from '../lib/reference';
import { loadReferenceDatasetBlob } from '../lib/storage/blob';
import { getDefaultModelId, getEffectiveModel } from '../lib/storage/repositories';
import type { AnomalySeverity, AnomalyType } from '../lib/types';

function parseArg(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

function parseResumeArg(argv: string[]): boolean | string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--resume') return true;
    if (argv[i].startsWith('--resume=')) return argv[i].slice('--resume='.length);
  }
  return false;
}

async function main() {
  const argv = process.argv.slice(2);
  const quick = argv.includes('--quick');
  const resumeArg = parseResumeArg(argv);
  const defaultModel = await getDefaultModelId();
  const requestedModelId = parseArg(argv, '--model') || defaultModel;
  const model = await getEffectiveModel(requestedModelId);
  const refBlob = await loadReferenceDatasetBlob(model.referenceDatasetId);
  if (refBlob) {
    registerReferenceDataset(refBlob.meta, refBlob.rows);
  }

  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const SEV: AnomalySeverity[] = ['low', 'medium', 'high'];
  const RATES = [0.01, 0.05, 0.10, 0.20, 0.30];
  const seeds = (full: number) => range(1, quick ? Math.min(3, full) : full);

  // Complete set of anomaly types (including 11a new types and categorical types)
  const types: AnomalyType[] = [
    'none',
    'unit_error', 'extreme_outlier', 'negative_value', 'type_error',
    'missing_injection', 'swapped_columns', 'duplicate_rows',
    'multivariate_inconsistent', 'schema_break',
    'unseen_category',
    'mean_shift', 'variance_change',
    'category_shift',
    'mix_shift', 'missing_drift', 'label_shift', 'concept_shift',
  ];

  type Cell = { type: AnomalyType; severity: AnomalySeverity; rate: number; seed: number };
  const grid: Cell[] = [];
  const DRIFT_TYPES = new Set(['mean_shift', 'variance_change', 'category_shift', 'mix_shift', 'missing_drift', 'label_shift', 'concept_shift']);

  for (const type of types) {
    if (type === 'none') {
      for (const seed of seeds(100)) grid.push({ type, severity: 'none', rate: 0, seed });
      continue;
    }
    if (type === 'schema_break') {
      for (const severity of SEV) {
        for (const seed of seeds(5)) grid.push({ type, severity, rate: 0.05, seed });
      }
      continue;
    }
    if (DRIFT_TYPES.has(type)) {
      for (const severity of SEV) {
        for (const seed of seeds(30)) grid.push({ type, severity, rate: 1, seed });
      }
      continue;
    }
    for (const severity of SEV) {
      for (const rate of RATES) {
        for (const seed of seeds(30)) grid.push({ type, severity, rate, seed });
      }
    }
  }

  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a git repo */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(process.cwd(), 'results');
  mkdirSync(outDir, { recursive: true });

  // Handle --resume lookup
  let existingRawFile: string | null = null;
  if (resumeArg) {
    if (typeof resumeArg === 'string' && existsSync(resumeArg)) {
      existingRawFile = resumeArg;
    } else {
      // Find latest matching trials_raw.csv
      const allFiles = readdirSync(outDir)
        .filter(f => f.includes(`_${model.id}`) && f.endsWith('_trials_raw.csv'))
        .sort()
        .reverse();
      if (allFiles.length > 0) {
        existingRawFile = join(outDir, allFiles[0]);
      }
    }
  }

  const completedKeys = new Set<string>();
  const cellKey = (c: Cell) => `${c.type}|${c.severity}|${c.rate}|${c.seed}`;

  if (existingRawFile && existsSync(existingRawFile)) {
    console.log(`Resuming from existing trials: ${existingRawFile}`);
    const lines = readFileSync(existingRawFile, 'utf8').split('\n');
    const header = lines[0]?.split(',') ?? [];
    const typeIdx = header.indexOf('type');
    const sevIdx = header.indexOf('severity');
    const rateIdx = header.indexOf('rate');
    const seedIdx = header.indexOf('seed');
    if (typeIdx !== -1 && sevIdx !== -1 && rateIdx !== -1 && seedIdx !== -1) {
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i]?.split(',');
        if (parts && parts.length > Math.max(typeIdx, sevIdx, rateIdx, seedIdx)) {
          const k = `${parts[typeIdx]}|${parts[sevIdx]}|${parts[rateIdx]}|${parts[seedIdx]}`;
          completedKeys.add(k);
        }
      }
      console.log(`✓ Loaded ${completedKeys.size} previously completed trials.`);
    }
  }

  const baseName = `${stamp}_${commit}_${model.id}${quick ? '_quick' : ''}`;
  const prefix = join(outDir, baseName);

  // ── Run ──
  const results: { cell: Cell; t: TrialResult }[] = [];
  const t0 = Date.now();
  let trialsExecuted = 0;
  const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${s.toFixed(0)}s`);

  for (let i = 0; i < grid.length; i++) {
    const cell = grid[i];
    const k = cellKey(cell);

    if (completedKeys.has(k)) {
      // In resume mode, rerun or restore
      const t = runTrial(model, { type: cell.type, severity: cell.severity, rate: cell.rate, seed: cell.seed });
      results.push({ cell, t });
      continue;
    }

    const t = runTrial(model, { type: cell.type, severity: cell.severity, rate: cell.rate, seed: cell.seed });
    results.push({ cell, t });
    trialsExecuted++;

    if ((i + 1) % 10 === 0 || i === grid.length - 1) {
      const el = (Date.now() - t0) / 1000;
      const msPerTrial = (el * 1000) / Math.max(1, trialsExecuted);
      const remainingTrials = grid.length - (i + 1);
      const eta = (remainingTrials * msPerTrial) / 1000;
      process.stdout.write(`\r[${i + 1}/${grid.length}] (${model.id}) ${((i + 1) / grid.length * 100).toFixed(1)}%  elapsed ${fmtSec(el)}  ETA ${fmtSec(eta)} (${msPerTrial.toFixed(1)} ms/trial)   `);
    }
  }
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
      skipped: t.spec.skipped ? 'true' : 'false',
      skip_reason: t.spec.skipReason ?? '',
      expected_layer: t.expected.layer, detector: det,
      n: m.n, TP: m.TP, FP: m.FP, FN: m.FN, TN: m.TN, precision: m.precision, recall: m.recall, f1: m.f1, flagRate: m.flagRate,
      blocked: t.file.blocked, alarm: t.file.alarm, alarm_excl_flagged: t.file.alarmExcludingFlagged,
      status_fixed: t.file.statusFixed ?? t.drift?.status ?? (t.file.blocked ? 'BLOCKED' : 'STABLE'),
      status_calibrated: t.file.statusCalibrated ?? t.drift?.status ?? (t.file.blocked ? 'BLOCKED' : 'STABLE'),
      falseAlarm: t.file.falseAlarm, rescued: t.file.rescued,
      detected: t.file.detected,
      detected_calibrated: t.file.detectedCalibrated,
      preserved: t.file.preserved,
      routed_layer: t.file.routedLayer, routingCorrect: t.file.routingCorrect,
      trigger_action: t.triggerAction,
      status: t.drift?.status ?? 'BLOCKED', psi: t.drift?.psi, ...csiCols('', t.drift),
      status_excl: t.driftExcludingFlagged?.status ?? '', psi_excl: t.driftExcludingFlagged?.psi, ...csiCols('excl_', t.driftExcludingFlagged),
      rows: t.rowCount, injected: t.injectedCount, ms: +t.timingMs.toFixed(1),
    });
  }
  writeCsv(`${prefix}_trials_raw.csv`, raw);

  // ── summary.csv (exclude skipped trials) ──
  const unskippedResults = results.filter(r => !r.t.spec.skipped);
  const skippedTrialsCount = results.length - unskippedResults.length;
  const skippedReasons: Record<string, number> = {};
  for (const { t } of results) {
    if (t.spec.skipped) {
      const reason = t.spec.skipReason || 'unknown';
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
    }
  }

  const groupKey = (c: Cell) => `${c.type}|${c.severity}|${c.rate}`;
  const groups = new Map<string, { cell: Cell; ts: TrialResult[] }>();
  for (const { cell, t } of unskippedResults) {
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
    for (const f of ['blocked', 'alarm', 'falseAlarm', 'rescued', 'detected', 'detectedCalibrated', 'preserved', 'routingCorrect'] as const) {
      const s = rateStat(ts.map(t => (t.file as any)[f] as boolean | null));
      Object.assign(row, { [`${f}_rate`]: s.mean, [`${f}_ci_low`]: s.ciLow, [`${f}_ci_high`]: s.ciHigh });
    }
    const calAlarm = rateStat(ts.map(t => (t.file.statusCalibrated === 'WARNING' || t.file.statusCalibrated === 'CRITICAL')));
    Object.assign(row, { alarm_calibrated_rate: calAlarm.mean });

    const psi = stat(ts.map(t => t.drift?.psi)), psiEx = stat(ts.map(t => t.driftExcludingFlagged?.psi ?? t.drift?.psi));
    Object.assign(row, { psi_mean: psi.mean, psi_sd: psi.sd, psi_excl_mean: psiEx.mean, psi_excl_sd: psiEx.sd }, summarizeTriggerActions(ts));
    batch.push(row);
  }
  writeCsv(`${prefix}_batch_summary.csv`, batch);

  // ── run_meta.json ──
  writeFileSync(`${prefix}_run_meta.json`, JSON.stringify({
    commit, startedAt: new Date(t0).toISOString(), elapsedSec,
    trials: grid.length,
    executedTrials: unskippedResults.length,
    skippedTrials: skippedTrialsCount,
    skippedReasons,
    msPerTrial: (elapsedSec * 1000) / grid.length,
    quick, grid: { severities: SEV, rates: RATES, seeds: { groupA: seeds(30).length, schema_break: seeds(5).length, drift: seeds(30).length, none: seeds(100).length } },
    modelId: model.id, configVersion: model.configVersion, referenceId: model.referenceDatasetId,
    anomalyConfig: model.anomalyConfig ?? null, forestSeed: 42,
    severityTable: SEVERITY_TABLE, expectedLayer: EXPECTED_LAYER,
  }, null, 2) + '\n');

  console.log(`\nDone (${model.id}): ${grid.length} trials in ${fmtSec(elapsedSec)} (${((elapsedSec * 1000) / grid.length).toFixed(1)} ms/trial)`);

  // ── Step 11a: Report New Drift Scenarios Summary Table (Medium Severity) ──
  const NEW_TYPES: AnomalyType[] = ['label_shift', 'concept_shift', 'mix_shift', 'missing_drift', 'category_shift'];
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
    console.log(`  Step 11: New Drift Injections (Severity Medium)`);
    console.log(`══════════════════════════════════════════════════════════════════════════`);
    console.table(newTypeRows);
  }

  // ── public/experiments/latest_summary.json (Trimmed file size for Web UI < 200 KB) ──
  const round4 = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;

  const publicSummary = summary.map(r => ({
    type: r.type,
    severity: r.severity,
    rate: r.rate,
    detector: r.detector,
    recall_mean: round4(r.recall_mean),
    recall_ci_high: round4(r.recall_ci_high),
    precision_mean: round4(r.precision_mean),
    f1_mean: round4(r.f1_mean),
  }));

  const publicBatch = batch.map(b => ({
    type: b.type,
    severity: b.severity,
    rate: b.rate,
    expected_layer: b.expected_layer,
    trials: b.trials,
    blocked_rate: round4(b.blocked_rate),
    falseAlarm_rate: round4(b.falseAlarm_rate),
    rescued_rate: round4(b.rescued_rate),
    detected_rate: round4(b.detected_rate),
    detected_calibrated_rate: round4((b as any).detectedCalibrated_rate),
    preserved_rate: round4(b.preserved_rate),
    routingCorrect_rate: round4(b.routingCorrect_rate),
    alarm_calibrated_rate: round4(b.alarm_calibrated_rate),
  }));

  const publicDir = join(process.cwd(), 'public', 'experiments');
  mkdirSync(publicDir, { recursive: true });
  const pubContent = JSON.stringify({
    meta: {
      modelId: model.id,
      commit,
      startedAt: new Date(t0).toISOString(),
      elapsedSec,
      trials: grid.length,
      executedTrials: unskippedResults.length,
      skippedTrials: skippedTrialsCount,
      msPerTrial: (elapsedSec * 1000) / Math.max(1, trialsExecuted),
      quick,
      severities: SEV,
      rates: RATES,
      files: `${baseName}_*`,
    },
    summary: publicSummary,
    batch: publicBatch,
  });

  const pubFileModel = join(publicDir, `latest_summary_${model.id}.json`);
  const pubFileDefault = join(publicDir, 'latest_summary.json');
  writeFileSync(pubFileModel, pubContent + '\n', 'utf8');
  writeFileSync(pubFileDefault, pubContent + '\n', 'utf8');
  console.log(`\nWeb UI summary written to: ${pubFileModel} and ${pubFileDefault} (${(Buffer.byteLength(pubContent) / 1024).toFixed(1)} KB)`);
  console.log(`→ ${prefix}_{trials_raw,summary,batch_summary}.csv, _run_meta.json`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
