/**
 * POST /api/ingest
 *
 * Automated ingestion endpoint for external systems.
 * - Authenticated via `Authorization: Bearer <MONITOR_API_TOKEN>` (timing-safe).
 * - Enforces active model requirement (404 NO_ACTIVE_VERSION if none).
 * - Enforces duplicate period protection (409 DUPLICATE_PERIOD unless onDuplicate=replace).
 * - Enforces max payload limit (413 Payload Too Large).
 * - Supports multipart/form-data (file in 'file' field), application/json, and text/csv.
 * - Rejects missing/empty file or unreadable content (400 Bad Request, no INVALID_DATA run saved).
 * - Rejects malformed data (422 INVALID_DATA).
 * - Returns trigger action, matched rule, verdict, CSI checked/skipped counts, report URL.
 * - Complies with PDPA: response contains NO customer row data.
 */
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { executeMonitoringPipeline, DuplicatePeriodError } from '../../../lib/monitoringCore';
import { RegistryError } from '../../../lib/storage/repositories';
import { DEFAULT_MAX_INGEST_PAYLOAD_BYTES } from '../../../lib/defaults';

export const dynamic = 'force-dynamic';

function verifyApiToken(req: Request): boolean {
  const serverToken = process.env.MONITOR_API_TOKEN;
  if (!serverToken || typeof serverToken !== 'string' || serverToken.trim() === '') {
    return false;
  }
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const clientToken = authHeader.slice(7).trim();
  if (!clientToken) {
    return false;
  }

  const serverBuf = Buffer.from(serverToken);
  const clientBuf = Buffer.from(clientToken);
  if (serverBuf.length !== clientBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(serverBuf, clientBuf);
}

export async function POST(request: Request) {
  // 1. Authentication
  if (!verifyApiToken(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Payload size check (via header if available)
  const contentLengthStr = request.headers.get('content-length');
  if (contentLengthStr) {
    const length = parseInt(contentLengthStr, 10);
    if (!isNaN(length) && length > DEFAULT_MAX_INGEST_PAYLOAD_BYTES) {
      return NextResponse.json({ error: 'Payload Too Large', code: 'PAYLOAD_TOO_LARGE' }, { status: 413 });
    }
  }

  const url = new URL(request.url);
  let csvText: string | undefined;
  let customers: Record<string, unknown>[] | undefined;
  let fileName = 'ingest.csv';
  let modelId = url.searchParams.get('modelId') || undefined;
  let period = url.searchParams.get('period') || undefined;
  let onDuplicate = (url.searchParams.get('onDuplicate') || 'reject') as 'reject' | 'replace';
  let source: 'api' | 'manual' = 'api';

  const contentType = request.headers.get('content-type') || '';

  if (contentType.toLowerCase().includes('multipart/form-data')) {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { error: 'Failed to parse multipart form data', code: 'INVALID_MULTIPART' },
        { status: 400 },
      );
    }

    const fileEntry = formData.get('file');
    if (!fileEntry || typeof fileEntry === 'string' || !(fileEntry instanceof Blob)) {
      return NextResponse.json(
        { error: 'ไม่พบไฟล์ในฟิลด์ file', code: 'MISSING_FILE' },
        { status: 400 },
      );
    }

    if (fileEntry.size === 0) {
      return NextResponse.json(
        { error: 'ไฟล์ว่างเปล่า (0 bytes)', code: 'EMPTY_FILE' },
        { status: 400 },
      );
    }

    if (fileEntry.size > DEFAULT_MAX_INGEST_PAYLOAD_BYTES) {
      return NextResponse.json(
        { error: 'Payload Too Large', code: 'PAYLOAD_TOO_LARGE' },
        { status: 413 },
      );
    }

    try {
      const arrayBuf = await fileEntry.arrayBuffer();
      csvText = Buffer.from(arrayBuf).toString('utf8').replace(/^\uFEFF/, '');
    } catch {
      return NextResponse.json(
        { error: 'ไม่สามารถอ่านเนื้อหาไฟล์ได้', code: 'UNREADABLE_FILE' },
        { status: 400 },
      );
    }

    if (!csvText.trim()) {
      return NextResponse.json(
        { error: 'ไฟล์ว่างเปล่า', code: 'EMPTY_FILE' },
        { status: 400 },
      );
    }

    if (fileEntry instanceof File && fileEntry.name) {
      fileName = fileEntry.name;
    }

    const formModelId = formData.get('modelId')?.toString()?.trim();
    if (formModelId) modelId = formModelId;

    const formPeriod = formData.get('period')?.toString()?.trim();
    if (formPeriod) period = formPeriod;

    const formOnDuplicate = formData.get('onDuplicate')?.toString()?.trim();
    if (formOnDuplicate) {
      onDuplicate = formOnDuplicate === 'replace' ? 'replace' : 'reject';
    }

    const formSource = formData.get('source')?.toString()?.trim();
    if (formSource === 'manual') {
      source = 'manual';
    }
  } else {
    // 3. Read body as text (for JSON, text/csv, or raw text)
    const rawText = await request.text();
    if (Buffer.byteLength(rawText, 'utf8') > DEFAULT_MAX_INGEST_PAYLOAD_BYTES) {
      return NextResponse.json({ error: 'Payload Too Large', code: 'PAYLOAD_TOO_LARGE' }, { status: 413 });
    }

    if (!rawText || !rawText.trim()) {
      return NextResponse.json({ error: 'Empty payload', code: 'EMPTY_PAYLOAD' }, { status: 400 });
    }

    if (contentType.toLowerCase().includes('application/json') || rawText.trim().startsWith('{')) {
      try {
        const jsonBody = JSON.parse(rawText);
        csvText = typeof jsonBody.csvText === 'string' ? jsonBody.csvText.replace(/^\uFEFF/, '') : undefined;
        customers = jsonBody.customers;
        fileName = jsonBody.fileName || fileName;
        modelId = jsonBody.modelId || modelId;
        period = jsonBody.period || period;
        onDuplicate = jsonBody.onDuplicate === 'replace' ? 'replace' : onDuplicate;
        if (jsonBody.source === 'manual') {
          source = 'manual';
        }
      } catch {
        return NextResponse.json({ error: 'Invalid JSON payload', code: 'INVALID_JSON' }, { status: 400 });
      }
    } else {
      csvText = rawText.replace(/^\uFEFF/, '');
    }
  }

  if (!csvText && (!customers || customers.length === 0)) {
    return NextResponse.json(
      { error: 'ต้องส่ง file (multipart/form-data), csvText หรือ customers', code: 'MISSING_DATA' },
      { status: 400 },
    );
  }

  try {
    const result = await executeMonitoringPipeline({
      modelId,
      fileName,
      csvText,
      customers,
      period,
      source,
      onDuplicate,
    });

    const { run } = result;

    if (!run.drift) {
      return NextResponse.json(
        {
          error: 'ข้อมูลไม่ผ่านการตรวจสอบ — ยังไม่ได้คำนวณ PSI/CSI',
          code: 'INVALID_DATA',
          runId: run.runId,
          modelId: result.model.id,
          version: result.model.version,
          period: result.period,
          source: result.source,
          verdict: 'INVALID_DATA',
          validation: {
            ok: false,
            totalRows: run.validation.totalRows,
            validRows: run.validation.validRows,
            rejectedRows: run.validation.rejectedRows,
            issues: run.validation.issues,
          },
          reportUrl: `/dashboard/report/${run.runId}?modelId=${encodeURIComponent(result.model.id)}`,
        },
        { status: 422 },
      );
    }

    const triggerData = run.trigger
      ? {
          action: run.trigger.action,
          matchedRuleId: run.trigger.matchedRuleId,
          severity: run.trigger.severity,
          reasons: run.trigger.reasons,
        }
      : null;

    return NextResponse.json({
      runId: run.runId,
      modelId: result.model.id,
      version: result.model.version,
      period: result.period,
      source: result.source,
      verdict: run.drift ? run.drift.overallStatus : 'INVALID_DATA',
      trigger: triggerData,
      csi: {
        checkedCount: result.drift ? Object.keys(result.drift.csi).length : 0,
        skippedCount: Object.keys(result.csiSkipped).length,
      },
      psi: result.drift?.psi?.value ?? null,
      psiStatus: result.drift?.psi?.status ?? null,
      validation: {
        ok: run.validation.ok,
        totalRows: run.validation.totalRows,
        validRows: run.validation.validRows,
        rejectedRows: run.validation.rejectedRows,
      },
      reportUrl: `/dashboard/report/${run.runId}?modelId=${encodeURIComponent(result.model.id)}`,
      createdAt: run.createdAt,
      warning: result.periodWarning,
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
    console.error('Error POST /api/ingest:', error);
    return NextResponse.json({ error: 'Internal Server Error', detail: String(error) }, { status: 500 });
  }
}
