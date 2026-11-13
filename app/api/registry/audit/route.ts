/**
 * GET /api/registry/audit
 *
 * Returns persistent audit logs of baseline deletion, archiving, and model removal.
 */
import { NextResponse } from 'next/server';
import { listDeletionAuditLogs } from '../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '100', 10);
    const logs = await listDeletionAuditLogs(limit);
    return NextResponse.json({ ok: true, logs });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
