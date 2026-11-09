/**
 * POST /api/registry/references
 *
 * Uploads a Reference CSV (<= 4 MB), parses rows, infers column types,
 * computes SHA-256, saves `{ meta, rows }` to blob storage, and returns
 * `{ meta, sha256, columns }`.
 */
import { NextResponse } from 'next/server';
import { parseCsv } from '../../../../lib/csv';
import { inferColumnsFromRows } from '../../../../lib/baselineValidation';
import {
  computeRowsSha256,
  isBuiltInReferenceId,
  saveReferenceDatasetBlob,
} from '../../../../lib/storage/blob';
import type { ReferenceDatasetMeta } from '../../../../lib/types';

export const dynamic = 'force-dynamic';

const MAX_CSV_BYTES = 4 * 1024 * 1024; // 4 MB
const isBlank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';
    let referenceId = '';
    let csvText = '';
    let modelId = 'custom_model';
    let version = '1.0.0';
    let description = 'Reference dataset uploaded via Registry API';
    let source = 'registry-upload';
    let labelColumn = 'default_flag';
    let dateColumn = 'application_date';

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      referenceId = String(form.get('referenceId') || '').trim();
      modelId = String(form.get('modelId') || modelId).trim();
      version = String(form.get('version') || version).trim();
      description = String(form.get('description') || description).trim();
      source = String(form.get('source') || source).trim();
      labelColumn = String(form.get('labelColumn') || labelColumn).trim();
      dateColumn = String(form.get('dateColumn') || dateColumn).trim();
      const file = form.get('file');
      if (file && typeof (file as Blob).text === 'function') {
        csvText = await (file as Blob).text();
      } else {
        csvText = String(form.get('csvText') || '');
      }
    } else {
      const body = await request.json();
      referenceId = String(body.referenceId || '').trim();
      csvText = typeof body.csvText === 'string' ? body.csvText : '';
      if (body.modelId) modelId = String(body.modelId).trim();
      if (body.version) version = String(body.version).trim();
      if (body.description) description = String(body.description).trim();
      if (body.source) source = String(body.source).trim();
      if (body.labelColumn) labelColumn = String(body.labelColumn).trim();
      if (body.dateColumn) dateColumn = String(body.dateColumn).trim();
    }

    if (!referenceId) {
      return NextResponse.json(
        { error: 'ต้องระบุ referenceId' },
        { status: 400 },
      );
    }
    if (isBuiltInReferenceId(referenceId)) {
      return NextResponse.json(
        { error: `ไม่สามารถเขียนทับ Reference Dataset มาตรฐาน (Built-in) "${referenceId}" ได้` },
        { status: 403 },
      );
    }
    if (!csvText.trim()) {
      return NextResponse.json(
        { error: 'ต้องส่งข้อมูล CSV (csvText หรือ file)' },
        { status: 400 },
      );
    }
    const byteLength = Buffer.byteLength(csvText, 'utf8');
    if (byteLength > MAX_CSV_BYTES) {
      return NextResponse.json(
        { error: `ขนาดไฟล์ CSV (${(byteLength / (1024 * 1024)).toFixed(2)} MB) เกินพิกัดสูงสุด 4 MB` },
        { status: 413 },
      );
    }

    const parsed = parseCsv(csvText);
    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      return NextResponse.json(
        { error: 'ไฟล์ CSV ไม่มีคอลัมน์หรือไม่มีแถวข้อมูล' },
        { status: 400 },
      );
    }

    const detectedColumns = inferColumnsFromRows(parsed.rows, parsed.headers);
    const numericColSet = new Set(
      detectedColumns
        .filter(c => c.inferredType === 'numeric' || c.inferredType === 'binary')
        .map(c => c.column),
    );

    const normalizedRows: Record<string, string | number | null>[] = parsed.rows.map(r => {
      const out: Record<string, string | number | null> = {};
      for (const h of parsed.headers) {
        const raw = r[h];
        if (isBlank(raw)) {
          out[h] = null;
        } else if (numericColSet.has(h)) {
          const cleaned = String(raw).trim().replace(/,/g, '');
          const n = Number(cleaned);
          out[h] = Number.isFinite(n) ? n : String(raw).trim();
        } else {
          out[h] = String(raw).trim();
        }
      }
      return out;
    });

    // Compute label stats if labelColumn exists
    let badCount = 0;
    let validLabelCount = 0;
    if (parsed.headers.includes(labelColumn)) {
      for (const r of normalizedRows) {
        const v = r[labelColumn];
        if (v === 0 || v === 1) {
          validLabelCount++;
          if (v === 1) badCount++;
        }
      }
    }
    const badRate = validLabelCount > 0 ? +(badCount / validLabelCount).toFixed(6) : 0;

    // Compute date range if dateColumn exists
    let periodStart = '';
    let periodEnd = '';
    if (parsed.headers.includes(dateColumn)) {
      const dates = normalizedRows
        .map(r => (r[dateColumn] ? String(r[dateColumn]).trim() : ''))
        .filter(Boolean)
        .sort();
      if (dates.length > 0) {
        periodStart = dates[0];
        periodEnd = dates[dates.length - 1];
      }
    }

    const sha256 = computeRowsSha256(normalizedRows, parsed.headers);
    const meta: ReferenceDatasetMeta = {
      referenceId,
      version,
      modelId,
      description,
      source,
      createdAt: new Date().toISOString(),
      rowCount: normalizedRows.length,
      badCount,
      badRate,
      periodStart,
      periodEnd,
      columns: parsed.headers,
      sha256,
    };

    const saved = await saveReferenceDatasetBlob({ meta, rows: normalizedRows });
    return NextResponse.json(
      {
        meta: saved.meta,
        sha256: saved.meta.sha256,
        columns: detectedColumns,
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
