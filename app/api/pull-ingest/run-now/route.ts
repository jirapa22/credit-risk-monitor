/**
 * POST /api/pull-ingest/run-now
 *
 * Manual trigger endpoint for pulling incoming CSV files immediately.
 * - Requires `operator` (ชื่อผู้สั่ง) in JSON body.
 * - Max duration set to 60s (maximum allowed on Vercel Hobby plan).
 */
import { NextResponse } from 'next/server';
import { executePullIngest } from '../../../../lib/pullIngest';
import { getDefaultModelId } from '../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60s is the maximum allowable execution duration on Vercel Hobby plan

export async function POST(request: Request) {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const operator = (body?.operator || body?.author || '').trim();
  if (!operator) {
    return NextResponse.json(
      { error: 'กรุณาระบุชื่อผู้สั่ง (ห้ามเว้นว่าง)' },
      { status: 400 },
    );
  }

  const modelId = body?.modelId?.trim() || (await getDefaultModelId());

  try {
    const result = await executePullIngest({
      trigger: 'manual-run-now',
      operator,
      modelId,
    });

    return NextResponse.json({
      ok: true,
      trigger: 'manual-run-now',
      operator,
      modelId,
      summary: result.historyEntry.summary,
      files: result.historyEntry.files,
      runIds: result.historyEntry.runIds,
      historyEntry: result.historyEntry,
    });
  } catch (error: any) {
    console.error('Error in pull-ingest run-now:', error);
    return NextResponse.json(
      {
        error: error?.message || 'เกิดข้อผิดพลาดในการสั่งดึงข้อมูล',
        detail: String(error),
      },
      { status: 500 },
    );
  }
}
