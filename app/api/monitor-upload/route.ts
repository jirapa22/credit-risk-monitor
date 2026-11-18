/**
 * POST /api/monitor-upload
 *
 * Body: { csvText: string, fileName: string,
 *         excludeRows?: number[],        // 1-based data rows to drop from the official drift (audit-logged)
 *         anomalyScreening?: boolean }   // default true
 *    or { customers: Record<string,string>[], fileName } (legacy)
 *
 * Pipeline (lib/monitoring.ts):
 *   [1] Data Validation  → rejects malformed rows / blocks the run on file-level errors
 *   [2] A-Score scoring  → config-driven scorecard
 *   [3] Drift Detection  → PSI/CSI vs the FROZEN reference dataset (model.referenceDatasetId)
 * The resulting MonitoringRun is persisted (lib/storage) and returned.
 */
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { runMonitoring } from '../../../lib/monitoring';
import { getDefaultModelId, getEffectiveModel, listRuns, loadReferenceProfile, RegistryError, saveRun, storageInfo } from '../../../lib/storage/repositories';
import { saveRunDetailBlob } from '../../../lib/storage/blob';
import type { MonitoringRun, MonitoringRunDetail } from '../../../lib/types';
import { getReferenceMeta } from '../../../lib/reference';
import { toLegacyLog } from '../../../lib/legacy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const body = await request.json();
    const fileName: string = body.fileName || 'unknown.csv';
    if (typeof body.csvText !== 'string' && !Array.isArray(body.customers)) {
      return NextResponse.json({ error: 'ต้องส่ง csvText (ข้อความ CSV) หรือ customers (array)' }, { status: 400 });
    }

    const excludeRows = Array.isArray(body.excludeRows)
      ? body.excludeRows.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
      : undefined;
    const requestedModelId = url.searchParams.get('modelId') || body.modelId || (await getDefaultModelId());
    const model = await getEffectiveModel(requestedModelId);
    await loadReferenceProfile(model.referenceDatasetId, model);
    const history = await listRuns<MonitoringRun>('monitoring', model.id, { configVersion: model.configVersion });
    const { run, scored, riskGradeDist, riskGradeStatus, skipped } = runMonitoring({
      model, fileName, csvText: body.csvText, rows: body.customers,
      excludeRows, anomalyScreening: body.anomalyScreening !== false,
      history,
    });

    const fileSha256 = body.csvText ? crypto.createHash('sha256').update(body.csvText).digest('hex') : '';
    const duplicateRun = fileSha256
      ? history.find((h: any) => h.sha256 === fileSha256 || h.detail?.sha256 === fileSha256)
      : undefined;
    const duplicateInfo = duplicateRun
      ? { fileName: duplicateRun.fileName, uploadedAt: duplicateRun.createdAt }
      : null;
    const duplicateWarning = duplicateRun
      ? `ไฟล์นี้เคยอัปโหลดแล้ว (${duplicateRun.fileName})`
      : null;

    const d = run.drift;
    const devStability = (model as any)?.developmentStats?.stability;
    const csi = d ? Object.fromEntries(Object.entries(d.csi).map(([k, v]) => [k, v.value])) : {};
    const csiDetail = d ? Object.fromEntries(Object.entries(d.csi).map(([k, v]) => [k, {
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
    }])) : null;

    // Build payload detail for viewing historical runs
    const detail: MonitoringRunDetail = {
      runId: run.runId,
      modelId: model.id,
      version: model.version,
      configVersion: model.configVersion,
      referenceId: run.referenceId,
      fileName: run.fileName,
      sha256: fileSha256,
      createdAt: run.createdAt,
      thresholdMode: model.driftConfig?.thresholdMode || 'fixed',
      validation: run.validation,
      drift: d,
      csiDetail,
      riskGradeDist,
      riskGradeStatus,
      scoredCustomers: scored.slice(0, 20), // strictly first 20 rows (PDPA)
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
    try { await saveRun(run); } catch (e) { storageError = String(e); }

    const base = {
      run,
      validation: run.validation,
      reference: getReferenceMeta(run.referenceId),
      storage: { ...storageInfo(), error: storageError },
      uploadSummary: run.uploadSummary,
      logEntry: toLegacyLog(run),
      anomaly: run.anomaly ?? null,
      driftExcludingFlagged: run.driftExcludingFlagged ?? null,
      driftReport: run.driftReport ?? null,
      trigger: run.trigger ?? null,
      excludedRows: run.excludedRows ?? [],
      duplicateWarning,
      duplicateInfo,
    };

    if (!run.drift) {
      return NextResponse.json(
        { ...base, error: 'ข้อมูลไม่ผ่านการตรวจสอบ — ยังไม่ได้คำนวณ PSI/CSI', status: 'INVALID_DATA' },
        { status: 422 },
      );
    }

    return NextResponse.json({
      ...base,
      drift: d,
      psi: d ? d.psi.value : 0,
      devPsi: devStability?.scorePsi ?? null,
      devStability: devStability ?? null,
      psiStatus: d ? d.psi.status : 'NOT_AVAILABLE',
      csi,
      csiDetail,
      csiSkipped: skipped,
      status: d ? d.overallStatus : 'INVALID_DATA',
      processedRows: run.validation.validRows,
      skippedRows: run.validation.rejectedRows,
      scoredCustomers: scored.slice(0, 20),
      riskGradeDist,
      riskGradeStatus,
      duplicateWarning,
      duplicateInfo,
    });
  } catch (error) {
    if (error instanceof RegistryError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code || (error.message.includes('ยังไม่มีเวอร์ชันที่เปิดใช้งาน') ? 'NO_ACTIVE_VERSION' : 'REGISTRY_ERROR'),
          detail: error.message,
        },
        { status: error.status },
      );
    }
    console.error('Error POST /api/monitor-upload:', error);
    return NextResponse.json({ error: 'Internal Server Error', detail: String(error) }, { status: 500 });
  }
}

