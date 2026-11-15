/**
 * GET /api/monitor-log/detail?runId=...&modelId=...
 *
 * Retrieves historical monitoring run detail payload (or fallback for older runs).
 */
import { NextResponse } from 'next/server';
import { getActiveModelId, getMonitoringRunDetail } from '@/lib/storage/repositories';
import { toLegacyLog } from '@/lib/legacy';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const runId = searchParams.get('runId');
    const modelId = searchParams.get('modelId') || getActiveModelId();

    if (!runId) {
      return NextResponse.json({ error: 'ต้องระบุ runId' }, { status: 400 });
    }

    const result = await getMonitoringRunDetail(modelId, runId);
    if (!result.run) {
      return NextResponse.json({ error: 'ไม่พบรายการ monitoring ที่ระบุ' }, { status: 404 });
    }

    if (result.hasDetail && result.detail) {
      return NextResponse.json({
        ok: true,
        hasDetail: true,
        detail: result.detail,
        run: toLegacyLog(result.run),
      });
    }

    return NextResponse.json({
      ok: true,
      hasDetail: false,
      detail: null,
      message: 'ไม่มีรายละเอียด (บันทึกก่อนอัปเดต)',
      run: toLegacyLog(result.run),
    });
  } catch (error) {
    console.error('GET /api/monitor-log/detail error:', error);
    return NextResponse.json(
      { error: 'เกิดข้อผิดพลาดในการอ่านรายละเอียด', detail: String(error) },
      { status: 500 },
    );
  }
}
