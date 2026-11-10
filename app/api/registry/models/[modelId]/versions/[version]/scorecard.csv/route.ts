/**
 * GET /api/registry/models/[modelId]/versions/[version]/scorecard.csv
 *
 * Exports the scorecard of a BaselineVersion as a CSV file (`variable,upper_bound,points,...`).
 */
import { NextResponse } from 'next/server';
import { exportScorecardToCsv } from '../../../../../../../../lib/scorecardImport';
import { listBaselineVersions } from '../../../../../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ modelId: string; version: string }> | { modelId: string; version: string } },
) {
  try {
    const resolved = await Promise.resolve(context.params);
    const modelId = decodeURIComponent(resolved.modelId || '');
    const version = decodeURIComponent(resolved.version || '');

    const versions = await listBaselineVersions(modelId);
    const found = versions.find(v => v.version === version);
    if (!found) {
      return NextResponse.json(
        { error: `ไม่พบเวอร์ชัน "${version}" ของโมเดล "${modelId}"` },
        { status: 404 },
      );
    }

    if (!found.scoring || !found.scoring.scorecard || Object.keys(found.scoring.scorecard).length === 0) {
      return NextResponse.json(
        { error: `เวอร์ชัน "${modelId}@${version}" ไม่ได้ใช้โหมด scorecard จึงไม่มีข้อมูลสกอร์การ์ดสำหรับส่งออก` },
        { status: 400 },
      );
    }

    const csv = exportScorecardToCsv(found.scoring);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${modelId}_${version}_scorecard.csv"`,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

