/**
 * GET /api/get-latest-psi
 *
 * Returns model config and empty history (stateless on Vercel).
 * PSI/CSI history is maintained client-side via localStorage.
 */
import { NextResponse } from 'next/server';
import modelConfigJson from '../../model-config.json';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const config = modelConfigJson as any;
    return NextResponse.json({ config, history: [] });
  } catch (error) {
    console.error('Error GET /api/get-latest-psi:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}