/**
 * GET /api/cron/pull-ingest
 *
 * Automated ingestion endpoint invoked by Vercel Cron.
 * - Authenticated via `Authorization: Bearer ${CRON_SECRET}` (constant-time comparison).
 * - Executes pull ingestion for incoming CSV files in Vercel Blob (`incoming/{modelId}/`).
 * - Max duration set to 60s (maximum allowed on Vercel Hobby plan).
 */
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { executePullIngest } from '../../../../lib/pullIngest';
import { getDefaultModelId } from '../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60s is the maximum allowable execution duration on Vercel Hobby plan

function verifyCronSecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || typeof secret !== 'string' || secret.trim() === '') {
    return false;
  }
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const clientToken = authHeader.slice(7).trim();
  if (!clientToken) {
    return false;
  }

  const serverBuf = Buffer.from(secret);
  const clientBuf = Buffer.from(clientToken);
  if (serverBuf.length !== clientBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(serverBuf, clientBuf);
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const modelId = url.searchParams.get('modelId') || (await getDefaultModelId());

  try {
    const result = await executePullIngest({
      trigger: 'scheduled',
      modelId,
    });

    return NextResponse.json({
      ok: true,
      trigger: 'scheduled',
      modelId,
      summary: result.historyEntry.summary,
      files: result.historyEntry.files,
      runIds: result.historyEntry.runIds,
      historyEntry: result.historyEntry,
    });
  } catch (error: any) {
    console.error('Error in cron pull-ingest:', error);
    return NextResponse.json(
      {
        error: 'เกิดข้อผิดพลาดในการประมวลผลดึงข้อมูลอัตโนมัติ',
        detail: error?.message || String(error),
      },
      { status: 500 },
    );
  }
}
