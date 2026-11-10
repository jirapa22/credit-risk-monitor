/**
 * POST /api/registry/scorecard/extract (Step 10d.D).
 *
 * Accepts `.xlsx` workbook (multipart form-data or JSON base64) and extracts
 * credit scorecard base points and bins using Claude AI (with heuristic fallback).
 * Compares recomputed scores with Reference dataset if referenceId is provided.
 */
import { NextResponse } from 'next/server';
import { extractScorecardWithAi } from '../../../../../lib/suggest/scorecardExtract';
import { loadReferenceDatasetBlob } from '../../../../../lib/storage/blob';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';
    let buffer: Buffer;
    let referenceId = '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');
      referenceId = String(formData.get('referenceId') || '').trim();

      if (!file || typeof (file as Blob).arrayBuffer !== 'function') {
        return NextResponse.json({ error: 'ไม่พบไฟล์ที่อัปโหลด' }, { status: 400 });
      }
      const arrayBuf = await (file as File).arrayBuffer();
      buffer = Buffer.from(arrayBuf);
    } else {
      const body = await request.json();
      referenceId = typeof body?.referenceId === 'string' ? body.referenceId.trim() : '';
      const base64 = typeof body?.base64 === 'string' ? body.base64 : '';
      if (!base64) {
        return NextResponse.json({ error: 'ต้องระบุ base64 หรือ multipart file' }, { status: 400 });
      }
      buffer = Buffer.from(base64, 'base64');
    }

    let referenceRows: Record<string, unknown>[] | undefined;
    if (referenceId) {
      const blob = await loadReferenceDatasetBlob(referenceId);
      if (blob) {
        referenceRows = blob.rows;
      }
    }

    const result = await extractScorecardWithAi(buffer, {
      referenceRows,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

