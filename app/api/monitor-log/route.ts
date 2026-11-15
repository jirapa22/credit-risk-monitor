/**
 * GET    /api/monitor-log?configVersion=1.1.0&limit=100  → persisted monitoring runs (newest first)
 * DELETE /api/monitor-log                                 → clear runs of the active model
 *
 * Runs are stored per modelId and tagged with configVersion + referenceId,
 * so logs of different model/config versions never mix.
 */
import { NextResponse } from 'next/server';
import { clearRuns, deleteMonitoringRuns, getActiveModelId, listRuns, storageInfo } from '@/lib/storage/repositories';
import { toLegacyLog } from '@/lib/legacy';
import type { MonitoringRun } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelId = searchParams.get('modelId') || getActiveModelId();
    const configVersion = searchParams.get('configVersion') || undefined;
    const limit = Math.min(parseInt(searchParams.get('limit') || '200', 10) || 200, 500);
    const full = searchParams.get('full') === '1';
    const runs = await listRuns<MonitoringRun>('monitoring', modelId, { configVersion, limit });
    return NextResponse.json({
      storage: storageInfo(),
      log: runs.map(toLegacyLog),
      ...(full ? { runs } : {}),
    });
  } catch (error) {
    console.error('GET /api/monitor-log error:', error);
    return NextResponse.json({ error: 'อ่าน Monitoring Log ไม่สำเร็จ', detail: String(error), log: [] }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      // ignore JSON parse error for URL-only requests
    }

    const modelId = body.modelId || url.searchParams.get('modelId');
    if (!modelId || !String(modelId).trim()) {
      return NextResponse.json({ error: 'ต้องระบุ modelId' }, { status: 400 });
    }

    const rawRunIds = body.runIds || (body.runId ? [body.runId] : url.searchParams.getAll('runId'));
    const runIds: string[] = Array.isArray(rawRunIds)
      ? rawRunIds.filter(Boolean).map(String)
      : rawRunIds
        ? [String(rawRunIds)]
        : [];

    if (runIds.length > 0) {
      const result = await deleteMonitoringRuns(modelId, runIds);
      return NextResponse.json({ success: true, ...result });
    }

    if (body.clearAll === true || url.searchParams.get('clearAll') === 'true') {
      await clearRuns('monitoring', modelId);
      return NextResponse.json({ success: true, clearedAll: true });
    }

    return NextResponse.json(
      { error: 'ต้องระบุ runIds หรือ runId ที่ต้องการลบ' },
      { status: 400 },
    );
  } catch (error) {
    console.error('DELETE /api/monitor-log error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
