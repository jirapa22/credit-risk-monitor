/**
 * GET /api/get-latest-psi
 *
 * Returns the EFFECTIVE model config (bundled model-config.json + stored
 * threshold overrides), the reference dataset metadata, and storage status.
 */
import { NextResponse } from 'next/server';
import { getEffectiveConfig, storageInfo } from '@/lib/storage/repositories';
import { getReferenceMeta } from '@/lib/reference';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const config = await getEffectiveConfig();
    const active = config.models[config.activeModelId];
    return NextResponse.json({
      config,
      reference: getReferenceMeta(active.referenceDatasetId),
      storage: storageInfo(),
      history: [],
    });
  } catch (error) {
    console.error('Error GET /api/get-latest-psi:', error);
    return NextResponse.json({ error: 'Internal Server Error', detail: String(error) }, { status: 500 });
  }
}