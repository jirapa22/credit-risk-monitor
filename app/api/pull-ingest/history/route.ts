/**
 * GET /api/pull-ingest/history
 *
 * Returns recent pull ingestion history for a model.
 */
import { NextResponse } from 'next/server';
import { listPullHistory } from '../../../../lib/pullIngest';
import { getDefaultModelId } from '../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const modelId = url.searchParams.get('modelId') || (await getDefaultModelId());
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10', 10), 1), 50);

  try {
    const history = await listPullHistory(modelId, limit);
    return NextResponse.json({
      modelId,
      history,
    });
  } catch (error: any) {
    console.error('Error in GET /api/pull-ingest/history:', error);
    return NextResponse.json(
      { error: 'ไม่สามารถดึงประวัติการดึงข้อมูลได้', detail: String(error) },
      { status: 500 },
    );
  }
}
