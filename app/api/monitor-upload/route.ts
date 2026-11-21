/**
 * POST /api/monitor-upload
 *
 * Body: { csvText: string, fileName: string,
 *         excludeRows?: number[],        // 1-based data rows to drop from the official drift (audit-logged)
 *         anomalyScreening?: boolean,    // default true
 *         period?: string,               // optional manual period override
 *         onDuplicate?: 'reject' | 'replace' } // default 'reject'
 *    or { customers: Record<string,string>[], fileName } (legacy)
 *
 * Pipeline (lib/monitoringCore.ts):
 *   [1] Data Validation  → rejects malformed rows / blocks the run on file-level errors
 *   [2] A-Score scoring  → config-driven scorecard
 *   [3] Drift Detection  → PSI/CSI vs the FROZEN reference dataset (model.referenceDatasetId)
 * The resulting MonitoringRun is persisted (lib/storage) and returned.
 */
import { NextResponse } from 'next/server';
import { executeMonitoringPipeline, DuplicatePeriodError } from '../../../lib/monitoringCore';
import { RegistryError } from '../../../lib/storage/repositories';
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
    const requestedModelId = url.searchParams.get('modelId') || body.modelId || undefined;
    const onDuplicateParam = (url.searchParams.get('onDuplicate') || body.onDuplicate) as 'reject' | 'replace' | undefined;
    const periodParam = (url.searchParams.get('period') || body.period) as string | undefined;

    const result = await executeMonitoringPipeline({
      modelId: requestedModelId,
      fileName,
      csvText: body.csvText,
      customers: body.customers,
      period: periodParam,
      source: 'manual',
      onDuplicate: onDuplicateParam === 'replace' ? 'replace' : 'reject',
      excludeRows,
      anomalyScreening: body.anomalyScreening !== false,
    });

    const { run, detail } = result;
    const d = run.drift;

    const base = {
      run,
      validation: run.validation,
      reference: result.referenceMeta,
      storage: result.storage,
      uploadSummary: run.uploadSummary,
      logEntry: toLegacyLog(run),
      anomaly: run.anomaly ?? null,
      driftExcludingFlagged: run.driftExcludingFlagged ?? null,
      driftReport: run.driftReport ?? null,
      trigger: run.trigger ?? null,
      excludedRows: run.excludedRows ?? [],
      duplicateWarning: result.duplicateWarning,
      duplicateInfo: result.duplicateInfo,
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
      devPsi: result.devPsi,
      devStability: result.devStability,
      psiStatus: d ? d.psi.status : 'NOT_AVAILABLE',
      csi: result.csi,
      csiDetail: result.csiDetail,
      csiSkipped: result.csiSkipped,
      status: d ? d.overallStatus : 'INVALID_DATA',
      processedRows: run.validation.validRows,
      skippedRows: run.validation.rejectedRows,
      scoredCustomers: detail.scoredCustomers ?? [],
      riskGradeDist: result.riskGradeDist,
      riskGradeStatus: result.riskGradeStatus,
      duplicateWarning: result.duplicateWarning,
      duplicateInfo: result.duplicateInfo,
    });
  } catch (error) {
    if (error instanceof DuplicatePeriodError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          period: error.period,
          existingRunId: error.existingRunId,
          existingRun: error.existingRun,
        },
        { status: 409 },
      );
    }
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
