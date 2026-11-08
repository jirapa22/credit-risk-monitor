/**
 * GET /api/triggers?modelId=&status=
 *
 * Lists recorded TriggerEvents (non-CONTINUE monitoring runs requiring human review).
 */
import { NextResponse } from 'next/server';
import { listTriggerEvents } from '../../../lib/storage/repositories';
import type { TriggerEventStatus } from '../../../lib/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const modelId = url.searchParams.get('modelId') || undefined;
    const statusParam = url.searchParams.get('status') || undefined;
    const status: TriggerEventStatus | undefined =
      statusParam === 'OPEN' || statusParam === 'REVIEWED' ? statusParam : undefined;

    const events = await listTriggerEvents({ modelId, status });
    return NextResponse.json({ events, total: events.length });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
