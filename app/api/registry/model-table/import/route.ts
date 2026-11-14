/**
 * POST /api/registry/model-table/import
 *
 * Imports a Model Table (ตารางโมเดล) from CSV, JSON, or .xlsx file for score_column mode.
 * Performs consistency check against Reference score column when provided.
 */
import { NextResponse } from 'next/server';
import {
  importModelTableFromBuffer,
  importModelTableFromText,
  type ModelTableImportOptions,
} from '../../../../../lib/scorecardImport';
import { loadReferenceDatasetBlob } from '../../../../../lib/storage/blob';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';
    let text = '';
    let fileBuffer: Buffer | null = null;
    let fileName = 'model_table.csv';
    let referenceId = '';
    let scoreColumn = '';
    let tolerancePct = 95;
    let customRows: Record<string, unknown>[] | undefined;

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      referenceId = String(form.get('referenceId') || '').trim();
      scoreColumn = String(form.get('scoreColumn') || '').trim();
      const rawTol = form.get('tolerancePct');
      if (rawTol) tolerancePct = Number(rawTol) || 95;

      const file = form.get('file');
      if (file && typeof (file as Blob).arrayBuffer === 'function') {
        const f = file as File;
        fileName = f.name || 'model_table.csv';
        const ab = await f.arrayBuffer();
        fileBuffer = Buffer.from(ab);
      } else {
        text = String(form.get('text') || form.get('csvText') || '');
      }
    } else {
      const body = await request.json();
      text = typeof body?.text === 'string' ? body.text : (typeof body?.csvText === 'string' ? body.csvText : '');
      if (body?.jsonContent) {
        text = JSON.stringify(body.jsonContent);
      }
      fileName = typeof body?.fileName === 'string' ? body.fileName : 'model_table.csv';
      referenceId = typeof body?.referenceId === 'string' ? body.referenceId.trim() : '';
      scoreColumn = typeof body?.scoreColumn === 'string' ? body.scoreColumn.trim() : '';
      if (body?.tolerancePct !== undefined) tolerancePct = Number(body.tolerancePct) || 95;
      if (Array.isArray(body?.referenceRows)) {
        customRows = body.referenceRows;
      }
    }

    const importOpts: ModelTableImportOptions = {
      tolerancePct,
    };
    if (scoreColumn) importOpts.scoreColumn = scoreColumn;

    if (customRows && customRows.length > 0) {
      importOpts.referenceRows = customRows;
    } else if (referenceId) {
      const blob = await loadReferenceDatasetBlob(referenceId);
      if (blob) {
        importOpts.referenceRows = blob.rows;
      }
    }

    const result = fileBuffer
      ? importModelTableFromBuffer(fileBuffer, fileName, importOpts)
      : importModelTableFromText(text, importOpts);

    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

