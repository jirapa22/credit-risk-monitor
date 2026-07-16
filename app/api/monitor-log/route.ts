/**
 * GET/DELETE /api/monitor-log
 *
 * Stateless on Vercel — returns empty log.
 * Client manages log in localStorage.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ log: [] });
}

export async function DELETE() {
  return NextResponse.json({ success: true, count: 0 });
}
