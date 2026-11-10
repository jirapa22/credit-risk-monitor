/**
 * POST /api/registry/scorecard/import
 *
 * Imports a scorecard from CSV text or `.xlsx` file (without using the `xlsx` package),
 * validates the resulting `ScoringConfig`, and compares recomputed scores against
 * the Reference dataset's score column when available.
 */
import { NextResponse } from 'next/server';
import {
  importScorecardFromBuffer,
  importScorecardFromCsv,
  type ScorecardImportOptions,
} from '../../../../../lib/scorecardImport';
import { loadReferenceDatasetBlob } from '../../../../../lib/storage/blob';
import { getActiveBaseline, loadReferenceProfile } from '../../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';
    let csvText = '';
    let fileBuffer: Buffer | null = null;
    let fileName = 'scorecard.csv';
    let referenceId = '';
    let scoreColumn = '';
    let customRows: Record<string, unknown>[] | undefined;

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      referenceId = String(form.get('referenceId') || '').trim();
      scoreColumn = String(form.get('scoreColumn') || '').trim();
      const file = form.get('file');
      if (file && typeof (file as Blob).arrayBuffer === 'function') {
        const f = file as File;
        fileName = f.name || 'scorecard.csv';
        const ab = await f.arrayBuffer();
        fileBuffer = Buffer.from(ab);
      } else {
        csvText = String(form.get('csvText') || '');
      }
    } else {
      const body = await request.json();
      csvText = typeof body?.csvText === 'string' ? body.csvText : '';
      fileName = typeof body?.fileName === 'string' ? body.fileName : 'scorecard.csv';
      referenceId = typeof body?.referenceId === 'string' ? body.referenceId.trim() : '';
      scoreColumn = typeof body?.scoreColumn === 'string' ? body.scoreColumn.trim() : '';
      if (Array.isArray(body?.referenceRows)) {
        customRows = body.referenceRows;
      }
    }

    const importOpts: ScorecardImportOptions = {};
    if (scoreColumn) importOpts.scoreColumn = scoreColumn;

    if (customRows && customRows.length > 0) {
      importOpts.referenceRows = customRows;
    } else if (referenceId) {
      const blob = await loadReferenceDatasetBlob(referenceId);
      if (blob) {
        importOpts.referenceRows = blob.rows;
        const hasScoreColInBlob =
          (scoreColumn && blob.meta.columns.includes(scoreColumn)) ||
          blob.meta.columns.includes('score');
        if (!hasScoreColInBlob && blob.meta.modelId) {
          try {
            const active = await getActiveBaseline(blob.meta.modelId);
            const prof = await loadReferenceProfile(referenceId, active);
            if (prof.hasScores && prof.scores.length === blob.rows.length) {
              importOpts.referenceScores = prof.scores;
            }
          } catch {
            // Optional fallback when comparing against a scorecard reference
          }
        }
      }
    }

    const result = fileBuffer
      ? importScorecardFromBuffer(fileBuffer, fileName, importOpts)
      : importScorecardFromCsv(csvText, importOpts);

    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

