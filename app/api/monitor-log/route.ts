/**
 * GET    /api/monitor-log?configVersion=1.1.0&limit=100  → persisted monitoring runs (newest first)
 * DELETE /api/monitor-log                                 → clear runs of the active model
 *
 * Runs are stored per modelId and tagged with configVersion + referenceId,
 * so logs of different model/config versions never mix.
 */
import { NextResponse } from 'next/server';
import { clearRuns, getActiveModelId, listRuns, storageInfo } from '@/lib/storage/repositories';
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
    const { searchParams } = new URL(request.url);
    await clearRuns('monitoring', searchParams.get('modelId') || getActiveModelId());
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
