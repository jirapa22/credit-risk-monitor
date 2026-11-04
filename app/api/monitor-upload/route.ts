/**
 * POST /api/monitor-upload
 *
 * Body: { csvText: string, fileName: string }        (preferred — server parses)
 *    or { customers: Record<string,string>[], fileName } (legacy)
 *
 * Pipeline (lib/monitoring.ts):
 *   [1] Data Validation  → rejects malformed rows / blocks the run on file-level errors
 *   [2] A-Score scoring  → config-driven scorecard
 *   [3] Drift Detection  → PSI/CSI vs the FROZEN reference dataset (model.referenceDatasetId)
 * The resulting MonitoringRun is persisted (lib/storage) and returned.
 */
import { NextResponse } from 'next/server';
import { runMonitoring } from '@/lib/monitoring';
import { getEffectiveModel, saveRun, storageInfo } from '@/lib/storage/repositories';
import { getReferenceMeta } from '@/lib/reference';
import { toLegacyLog } from '@/lib/legacy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const fileName: string = body.fileName || 'unknown.csv';
    if (typeof body.csvText !== 'string' && !Array.isArray(body.customers)) {
      return NextResponse.json({ error: 'ต้องส่ง csvText (ข้อความ CSV) หรือ customers (array)' }, { status: 400 });
    }

    const model = await getEffectiveModel();
    const { run, scored, riskGradeDist, skipped } = runMonitoring({
      model, fileName, csvText: body.csvText, rows: body.customers,
    });

    let storageError: string | undefined;
    try { await saveRun(run); } catch (e) { storageError = String(e); }

    const base = {
      run,
      validation: run.validation,
      reference: getReferenceMeta(run.referenceId),
      storage: { ...storageInfo(), error: storageError },
      uploadSummary: run.uploadSummary,
      logEntry: toLegacyLog(run),
    };

    if (!run.drift) {
      return NextResponse.json(
        { ...base, error: 'ข้อมูลไม่ผ่านการตรวจสอบ — ยังไม่ได้คำนวณ PSI/CSI', status: 'INVALID_DATA' },
        { status: 422 },
      );
    }

    const d = run.drift;
    const csi = Object.fromEntries(Object.entries(d.csi).map(([k, v]) => [k, v.value]));
    const csiDetail = Object.fromEntries(Object.entries(d.csi).map(([k, v]) => [k, {
      value: v.value,
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
    }]));

    return NextResponse.json({
      ...base,
      drift: d,
      psi: d.psi.value,
      psiStatus: d.psi.status,
      csi,
      csiDetail,
      csiSkipped: skipped,
      status: d.overallStatus,
      processedRows: run.validation.validRows,
      skippedRows: run.validation.rejectedRows,
      scoredCustomers: scored.slice(0, 100),
      riskGradeDist,
    });
  } catch (error) {
    console.error('Error POST /api/monitor-upload:', error);
    return NextResponse.json({ error: 'Internal Server Error', detail: String(error) }, { status: 500 });
  }
}
