/**
 * POST /api/sandbox/experiments/run
 * Body: { type, severity?, rate?, seeds?: number[] (max 10), experimentId? }
 *
 * Runs runTrial() for each seed (injection seed; IF seed fixed at 42), stores one
 * ExperimentRun per seed (kind 'sandbox', separate from monitoring logs) and
 * returns the per-detector averages. The full grid is NOT run here — use
 * `npm run experiments`.
 */
import { NextResponse } from 'next/server';
import { getActiveModelId, getEffectiveModel, saveRun, storageInfo } from '@/lib/storage/repositories';
import { runTrial, trialDetected, DETECTORS, stat, rate as rateStat, type TrialResult } from '@/lib/experiment';
import { ANOMALY_KIND } from '@/lib/injection';
import type { AnomalySeverity, AnomalyType, DriftStatus, ExperimentRun } from '@/lib/types';

export const dynamic = 'force-dynamic';

const TYPE_ALIASES: Record<string, AnomalyType> = { outlier_injection: 'extreme_outlier' };
const SEVERITIES: AnomalySeverity[] = ['none', 'low', 'medium', 'high'];
const MAX_SEEDS = 10;

export async function POST(request: Request) {
  try {
    const b = await request.json();
    const type: AnomalyType = TYPE_ALIASES[b.type] ?? b.type;
    const errors: string[] = [];
    if (!(type in ANOMALY_KIND)) errors.push(`type ต้องเป็นหนึ่งใน ${Object.keys(ANOMALY_KIND).join(', ')}`);
    const severity: AnomalySeverity = b.severity ?? (type === 'none' ? 'none' : 'medium');
    if (!SEVERITIES.includes(severity)) errors.push(`severity ต้องเป็นหนึ่งใน ${SEVERITIES.join(', ')}`);
    if (b.rate !== undefined && !(typeof b.rate === 'number' && b.rate >= 0 && b.rate <= 1)) errors.push('rate ต้องเป็นตัวเลข 0–1');
    const seeds: number[] = Array.isArray(b.seeds) && b.seeds.length ? b.seeds.map(Number) : [1];
    if (seeds.length > MAX_SEEDS) errors.push(`seeds ได้ไม่เกิน ${MAX_SEEDS} ค่า (grid เต็มให้ใช้ npm run experiments)`);
    if (seeds.some(s => !Number.isInteger(s))) errors.push('seeds ต้องเป็นจำนวนเต็ม');
    if (errors.length) return NextResponse.json({ error: 'ข้อมูลไม่ถูกต้อง', errors }, { status: 400 });

    const model = await getEffectiveModel(b.modelId || getActiveModelId());
    const experimentId = String(b.experimentId || `ui_${type}_${severity}_${Date.now()}`);
    const trials: TrialResult[] = [];
    const runs: ExperimentRun[] = [];
    let storageError: string | undefined;

    for (const seed of seeds) {
      const t = runTrial(model, { type, severity, rate: b.rate, seed });
      trials.push(t);
      const detected = trialDetected(t);
      const shouldDetect = t.expected.shouldAlarm;
      const run: ExperimentRun = {
        runId: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        kind: 'sandbox',
        createdAt: new Date().toISOString(),
        experimentId,
        model: { modelId: model.id, configVersion: model.configVersion ?? '1.0.0' },
        referenceId: model.referenceDatasetId,
        anomaly: { type, severity: t.spec.severity, targetFeatures: t.spec.targetFeatures, params: { rate: t.spec.rate, n: t.spec.n }, seed },
        thresholdsSnapshot: model.thresholds,
        expected: { shouldDetect, layer: t.expected.layer },
        validation: null,
        drift: t.drift ? { overallStatus: t.drift.status as DriftStatus, triggered: [], psi: t.drift.psi, csi: t.drift.csi } : null,
        detected,
        outcome: shouldDetect ? (detected ? 'TP' : 'FN') : (detected ? 'FP' : 'TN'),
        rate: t.spec.rate,
        metrics: t.detectors,
        fileMetrics: t.file,
        driftExcludingFlagged: t.driftExcludingFlagged ? { overallStatus: t.driftExcludingFlagged.status as DriftStatus, psi: t.driftExcludingFlagged.psi, csi: t.driftExcludingFlagged.csi } : null,
      };
      try { await saveRun(run); } catch (e) { storageError = String(e); }
      runs.push(run);
    }

    const detectors = Object.fromEntries(DETECTORS.map(d => [d, {
      TP: stat(trials.map(t => t.detectors[d].TP)).mean,
      FP: stat(trials.map(t => t.detectors[d].FP)).mean,
      FN: stat(trials.map(t => t.detectors[d].FN)).mean,
      TN: stat(trials.map(t => t.detectors[d].TN)).mean,
      precision: stat(trials.map(t => t.detectors[d].precision)),
      recall: stat(trials.map(t => t.detectors[d].recall)),
      f1: stat(trials.map(t => t.detectors[d].f1)),
      flagRate: stat(trials.map(t => t.detectors[d].flagRate)),
    }]));
    const file = Object.fromEntries((['blocked', 'alarm', 'falseAlarm', 'rescued', 'detected', 'preserved', 'routingCorrect'] as const)
      .map(f => [f, rateStat(trials.map(t => t.file[f] as boolean | null))]));

    return NextResponse.json({
      experimentId, type, severity, rate: trials[0]?.spec.rate, seeds,
      expected: trials[0]?.expected, detectors, file,
      psi: stat(trials.map(t => t.drift?.psi)), psiExcludingFlagged: stat(trials.map(t => t.driftExcludingFlagged?.psi ?? t.drift?.psi)),
      msPerTrial: stat(trials.map(t => t.timingMs)).mean,
      trials: trials.map(t => ({
        seed: t.spec.seed, kind: t.kind, rowCount: t.rowCount, injectedCount: t.injectedCount,
        routedLayer: t.file.routedLayer, routingCorrect: t.file.routingCorrect, blocked: t.file.blocked,
        drift: t.drift, driftExcludingFlagged: t.driftExcludingFlagged,
      })),
      runIds: runs.map(r => r.runId),
      storage: { ...storageInfo(), error: storageError },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
