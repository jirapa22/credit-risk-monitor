/**
 * GET /api/sandbox/experiments/export?modelId=&experimentId=
 * Stored ExperimentRun records as CSV (one row per run × detector; runs without
 * detector metrics produce a single row).
 */
import { getActiveModelId, listRuns } from '@/lib/storage/repositories';
import type { ExperimentRun } from '@/lib/types';

export const dynamic = 'force-dynamic';

const cell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const modelId = searchParams.get('modelId') || getActiveModelId();
  const experimentId = searchParams.get('experimentId');
  let runs = await listRuns<ExperimentRun>('sandbox', modelId);
  if (experimentId) runs = runs.filter(r => r.experimentId === experimentId);

  const rows: Record<string, unknown>[] = [];
  for (const r of runs) {
    const base = {
      runId: r.runId, createdAt: r.createdAt, experimentId: r.experimentId,
      modelId: r.model.modelId, configVersion: r.model.configVersion, referenceId: r.referenceId,
      type: r.anomaly.type, severity: r.anomaly.severity, rate: r.rate ?? r.anomaly.params?.rate ?? '', seed: r.anomaly.seed ?? '',
      expected_layer: r.expected.layer, shouldDetect: r.expected.shouldDetect, detected: r.detected, outcome: r.outcome,
      status: r.drift?.overallStatus ?? '', psi: r.drift?.psi ?? '',
      ...Object.fromEntries(Object.entries(r.drift?.csi ?? {}).map(([k, v]) => [`csi_${k}`, v])),
      status_excl: r.driftExcludingFlagged?.overallStatus ?? '', psi_excl: r.driftExcludingFlagged?.psi ?? '',
      ...Object.fromEntries(Object.entries(r.fileMetrics ?? {}).map(([k, v]) => [`file_${k}`, v])),
    };
    const metrics = Object.entries(r.metrics ?? {});
    if (metrics.length === 0) rows.push(base);
    for (const [detector, m] of metrics) rows.push({ ...base, detector, ...m });
  }
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
  return new Response('\uFEFF' + csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="sandbox_experiments_${modelId}${experimentId ? `_${experimentId}` : ''}.csv"`,
    },
  });
}
