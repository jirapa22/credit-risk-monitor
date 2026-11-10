/**
 * GET /api/ai/status (Step 10d.D).
 *
 * Reports whether Claude AI is configured and available without exposing API keys.
 */
import { NextResponse } from 'next/server';
import { DEFAULT_AI_MODEL } from '../../../../lib/suggest/ai';

export const dynamic = 'force-dynamic';

export async function GET() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.AI_MODEL || DEFAULT_AI_MODEL;
  const available = Boolean(apiKey && apiKey.trim() !== '');

  return NextResponse.json({
    available,
    model,
    provider: 'claude',
  });
}
