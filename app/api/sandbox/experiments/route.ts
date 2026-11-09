/**
 * Sandbox experiment API — STRUCTURE ONLY (no UI yet).
 *
 * GET  /api/sandbox/experiments?experimentId=...  → stored ExperimentRun records
 * POST /api/sandbox/experiments                   → store one ExperimentRun
 *
 * Kept separate from Monitoring: different storage key (runs:sandbox:<modelId>),
 * so experiment trials never appear in the production monitoring log.
 * Next phase: anomaly generator + detection-rate / false-positive-rate summary.
 */
import { NextResponse } from 'next/server';
import { getDefaultModelId, getEffectiveModel, listRuns, saveRun, storageInfo } from '../../../../lib/storage/repositories';
import type { AnomalySeverity, AnomalyType, ExperimentRun } from '../../../../lib/types';
import { expectedFor } from '../../../../lib/injection';

export const dynamic = 'force-dynamic';

const ANOMALY_TYPES: AnomalyType[] = [
  'none', 'unit_error', 'extreme_outlier', 'negative_value', 'type_error', 'missing_injection',
  'swapped_columns', 'duplicate_rows', 'multivariate_inconsistent', 'schema_break', 'unseen_category',
  'mean_shift', 'variance_change', 'category_shift',
];
/** Backward compatibility for older clients. */
const TYPE_ALIASES: Record<string, AnomalyType> = { outlier_injection: 'extreme_outlier' };
const LAYERS = ['validation', 'anomaly', 'drift', 'none'];
const SEVERITIES: AnomalySeverity[] = ['none', 'low', 'medium', 'high'];

function outcomeOf(shouldDetect: boolean, detected: boolean): ExperimentRun['outcome'] {
  return shouldDetect ? (detected ? 'TP' : 'FN') : (detected ? 'FP' : 'TN');
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const modelId = searchParams.get('modelId') || (await getDefaultModelId());
  const experimentId = searchParams.get('experimentId');
  const runs = await listRuns<ExperimentRun>('sandbox', modelId, { configVersion: searchParams.get('configVersion') || undefined });
  return NextResponse.json({ storage: storageInfo(), runs: experimentId ? runs.filter(r => r.experimentId === experimentId) : runs });
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const b = await request.json();
    if (b.anomaly && typeof b.anomaly.type === 'string' && TYPE_ALIASES[b.anomaly.type]) b.anomaly.type = TYPE_ALIASES[b.anomaly.type];
    const errors: string[] = [];
    if (!b.experimentId) errors.push('experimentId จำเป็น');
    if (!ANOMALY_TYPES.includes(b.anomaly?.type)) errors.push(`anomaly.type ต้องเป็นหนึ่งใน ${ANOMALY_TYPES.join(', ')}`);
    if (!SEVERITIES.includes(b.anomaly?.severity)) errors.push(`anomaly.severity ต้องเป็นหนึ่งใน ${SEVERITIES.join(', ')}`);
    if (typeof b.detected !== 'boolean') errors.push('detected ต้องเป็น boolean');
    if (errors.length) return NextResponse.json({ error: 'ข้อมูลไม่ครบ', errors }, { status: 400 });

    const modelId = url.searchParams.get('modelId') || b.modelId || (await getDefaultModelId());
    const model = await getEffectiveModel(modelId);
    const shouldDetect = b.expected?.shouldDetect ?? b.anomaly.type !== 'none';
    const run: ExperimentRun = {
      runId: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      kind: 'sandbox',
      createdAt: new Date().toISOString(),
      experimentId: String(b.experimentId),
      model: { modelId: model.id, configVersion: model.configVersion },
      referenceId: b.referenceId || model.referenceDatasetId,
      anomaly: {
        type: b.anomaly.type,
        severity: b.anomaly.severity,
        targetFeatures: Array.isArray(b.anomaly.targetFeatures) ? b.anomaly.targetFeatures : [],
        params: b.anomaly.params ?? {},
        seed: b.anomaly.seed,
      },
      thresholdsSnapshot: b.thresholdsSnapshot ?? model.thresholds,
      expected: {
        shouldDetect,
        layer: LAYERS.includes(b.expected?.layer) ? b.expected.layer : expectedFor(b.anomaly.type, b.anomaly.severity).layer,
      },
      validation: b.validation ?? null,
      drift: b.drift ?? null,
      detected: b.detected,
      outcome: outcomeOf(shouldDetect, b.detected),
      notes: b.notes,
    };
    await saveRun(run);
    return NextResponse.json({ success: true, run });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
