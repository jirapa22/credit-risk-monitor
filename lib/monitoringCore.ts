import crypto from 'crypto';
import { runMonitoring } from './monitoring';
import {
  getDefaultModelId,
  getEffectiveModel,
  listRuns,
  loadReferenceProfile,
  replaceMonitoringRun,
  saveRun,
  storageInfo,
} from './storage/repositories';
import { saveRunDetailBlob } from './storage/blob';
import type {
  DriftResult,
  MonitoringRun,
  MonitoringRunDetail,
  ValidationResult,
} from './types';
import { getReferenceMeta } from './reference';
import { toLegacyLog } from './legacy';

export class DuplicatePeriodError extends Error {
  readonly code = 'DUPLICATE_PERIOD';
  readonly status = 409;
  readonly period: string;
  readonly existingRunId: string;
  readonly existingRun: {
    runId: string;
    fileName: string;
    createdAt: string;
    period: string;
  };

  constructor(period: string, existingRun: MonitoringRun) {
    super(`ตรวจพบงวดข้อมูลซ้ำกับรอบที่เคยประมวลผลแล้ว (งวด: ${period})`);
    this.name = 'DuplicatePeriodError';
    this.period = period;
    this.existingRunId = existingRun.runId;
    this.existingRun = {
      runId: existingRun.runId,
      fileName: existingRun.fileName,
      createdAt: existingRun.createdAt,
      period,
    };
  }
}

export interface PeriodResolution {
  period: string | null;
  source: 'data' | 'request' | 'none';
  warning: string | null;
}

export function resolvePeriod(
  uploadSummary: unknown,
  requestPeriod?: string | null,
): PeriodResolution {
  const summary = uploadSummary as { periods?: Array<{ period: string; count: number; pct: number }> } | undefined;
  const rawPeriods = summary?.periods || [];
  const validPeriods = rawPeriods
    .map(p => p.period)
    .filter(p => p && p !== 'ไม่ระบุวันที่' && p !== 'UNKNOWN' && p !== 'UNKNOWN_PERIOD');

  if (validPeriods.length === 1) {
    return { period: validPeriods[0], source: 'data', warning: null };
  }
  if (validPeriods.length > 1) {
    const sorted = [...validPeriods].sort();
    return { period: `${sorted[0]} – ${sorted[sorted.length - 1]}`, source: 'data', warning: null };
  }
  if (requestPeriod && typeof requestPeriod === 'string' && requestPeriod.trim() !== '') {
    return { period: requestPeriod.trim(), source: 'request', warning: null };
  }
  return { period: null, source: 'none', warning: 'ไม่ทราบงวด' };
}

export interface MonitoringExecutionInput {
  modelId?: string | null;
  fileName?: string;
  csvText?: string;
  customers?: Record<string, unknown>[];
  period?: string | null;
  source?: 'manual' | 'api';
  onDuplicate?: 'reject' | 'replace';
  actor?: string;
  excludeRows?: number[];
  anomalyScreening?: boolean;
}

export interface MonitoringPipelineResult {
  run: MonitoringRun;
  detail: MonitoringRunDetail;
  validation: ValidationResult;
  drift: DriftResult | null;
  period: string | null;
  periodWarning: string | null;
  source: 'manual' | 'api';
  duplicateWarning: string | null;
  duplicateInfo: { fileName: string; uploadedAt: string } | null;
  replacedRunId?: string;
  csi: Record<string, number>;
  csiDetail: Record<string, unknown> | null;
  csiSkipped: Record<string, string> | Record<string, unknown>;
  devPsi: number | null;
  devStability: unknown | null;
  scored: unknown[];
  riskGradeDist: unknown[];
  riskGradeStatus?: string;
  referenceMeta: unknown;
  storage: ReturnType<typeof storageInfo> & { error?: string };
  model: Awaited<ReturnType<typeof getEffectiveModel>>;
}

export async function executeMonitoringPipeline(
  input: MonitoringExecutionInput,
): Promise<MonitoringPipelineResult> {
  const requestedModelId = input.modelId || (await getDefaultModelId());
  const model = await getEffectiveModel(requestedModelId);
  await loadReferenceProfile(model.referenceDatasetId, model);

  const history = await listRuns<MonitoringRun>('monitoring', model.id, {
    configVersion: model.configVersion,
  });

  const { run, scored, riskGradeDist, riskGradeStatus, skipped } = runMonitoring({
    model,
    fileName: input.fileName || 'unknown.csv',
    csvText: input.csvText,
    rows: input.customers,
    excludeRows: input.excludeRows,
    anomalyScreening: input.anomalyScreening !== false,
    history,
  });

  const resolution = resolvePeriod(run.uploadSummary, input.period);
  const resolvedPeriod = resolution.period;
  let replacedRunId: string | undefined;

  if (resolvedPeriod !== null) {
    const existingRun = history.find(h => {
      const hPeriod = h.period ?? resolvePeriod(h.uploadSummary ?? h.detail?.uploadSummary, null).period;
      return hPeriod === resolvedPeriod;
    });

    if (existingRun) {
      if (input.onDuplicate === 'replace') {
        await replaceMonitoringRun({
          modelId: model.id,
          oldRunId: existingRun.runId,
          newRunId: run.runId,
          fileName: existingRun.fileName,
          period: resolvedPeriod,
          actor: input.actor || (input.source === 'api' ? 'api' : 'manual_upload'),
        });
        replacedRunId = existingRun.runId;
      } else {
        throw new DuplicatePeriodError(resolvedPeriod, existingRun);
      }
    }
  }

  const runSource = input.source ?? 'manual';
  run.period = resolvedPeriod ?? undefined;
  run.source = runSource;

  const fileSha256 = input.csvText
    ? crypto.createHash('sha256').update(input.csvText).digest('hex')
    : '';

  const duplicateRun = fileSha256
    ? history.find(h => h.sha256 === fileSha256 || h.detail?.sha256 === fileSha256)
    : undefined;
  const duplicateInfo = duplicateRun
    ? { fileName: duplicateRun.fileName, uploadedAt: duplicateRun.createdAt }
    : null;
  const duplicateWarning = duplicateRun
    ? `ไฟล์นี้เคยอัปโหลดแล้ว (${duplicateRun.fileName})`
    : null;

  const d = run.drift;
  const devStability = (model as { developmentStats?: { stability?: unknown } })?.developmentStats?.stability as {
    scorePsi?: number;
    featureCsi?: Record<string, number>;
  } | undefined;

  const csi = d ? Object.fromEntries(Object.entries(d.csi).map(([k, v]) => [k, v.value])) : {};
  const csiDetail = d
    ? Object.fromEntries(
        Object.entries(d.csi).map(([k, v]) => [
          k,
          {
            value: v.value,
            devCsi: devStability?.featureCsi?.[k] ?? null,
            status: v.status,
            threshold: v.threshold.warning,
            criticalThreshold: v.threshold.critical,
            displayName: v.displayName,
            source: v.source,
            bin_labels: v.bins.map(b => b.label),
            bin_distribution: v.bins.map(b => ({
              label: b.label,
              baseline_pct: +(b.expectedPct * 100).toFixed(2),
              actual_pct: +(b.actualPct * 100).toFixed(2),
              contribution: +b.contribution.toFixed(5),
            })),
          },
        ]),
      )
    : null;

  const detail: MonitoringRunDetail = {
    runId: run.runId,
    modelId: model.id,
    version: model.version,
    configVersion: model.configVersion,
    referenceId: run.referenceId,
    fileName: run.fileName,
    period: resolvedPeriod ?? undefined,
    source: runSource,
    sha256: fileSha256,
    createdAt: run.createdAt,
    thresholdMode: model.driftConfig?.thresholdMode || 'fixed',
    validation: run.validation,
    drift: d,
    csiDetail,
    riskGradeDist,
    riskGradeStatus,
    scoredCustomers: scored.slice(0, 20),
    uploadSummary: run.uploadSummary,
    anomaly: run.anomaly ?? null,
    driftReport: run.driftReport ?? null,
    trigger: run.trigger ?? null,
    psi: d?.psi?.value ?? 0,
    psiStatus: d?.psi?.status ?? 'NOT_AVAILABLE',
    devPsi: devStability?.scorePsi ?? null,
    devStability: devStability ?? null,
    status: d?.overallStatus ?? (run.validation.ok ? 'STABLE' : 'INVALID_DATA'),
    processedRows: run.validation.validRows,
    skippedRows: run.validation.rejectedRows,
  };

  const DETAIL_BLOB_THRESHOLD = 500 * 1024; // 500 KB
  const detailStr = JSON.stringify(detail);
  if (detailStr.length > DETAIL_BLOB_THRESHOLD) {
    try {
      const blobUrl = await saveRunDetailBlob(run.runId, detail);
      run.detailBlobUrl = blobUrl;
      run.sha256 = fileSha256;
    } catch (err) {
      console.warn('Failed to save run detail to blob, falling back to inline detail:', err);
      run.detail = detail;
      run.sha256 = fileSha256;
    }
  } else {
    run.detail = detail;
    run.sha256 = fileSha256;
  }

  let storageError: string | undefined;
  try {
    await saveRun(run);
  } catch (e) {
    storageError = String(e);
  }

  return {
    run,
    detail,
    validation: run.validation,
    drift: d,
    period: resolvedPeriod,
    periodWarning: resolution.warning,
    source: runSource,
    duplicateWarning,
    duplicateInfo,
    replacedRunId,
    csi,
    csiDetail,
    csiSkipped: skipped,
    devPsi: devStability?.scorePsi ?? null,
    devStability: devStability ?? null,
    scored,
    riskGradeDist,
    riskGradeStatus,
    referenceMeta: getReferenceMeta(run.referenceId),
    storage: { ...storageInfo(), error: storageError },
    model,
  };
}
