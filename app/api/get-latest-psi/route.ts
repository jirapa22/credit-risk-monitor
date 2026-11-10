/**
 * GET /api/get-latest-psi?modelId=...
 *
 * Returns the EFFECTIVE model config (bundled model-config.json + stored
 * threshold overrides + custom Registry models), the reference dataset metadata,
 * and storage status.
 */
import { NextResponse } from 'next/server';
import { getEffectiveConfig, loadReferenceProfile, storageInfo } from '@/lib/storage/repositories';
import { getReferenceMeta } from '@/lib/reference';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const requestedModelId = searchParams.get('modelId') || undefined;
    const config = await getEffectiveConfig(requestedModelId);
    const active = config.models[config.activeModelId];
    let reference = active?.referenceDatasetId ? getReferenceMeta(active.referenceDatasetId) : null;
    if (!reference && active?.referenceDatasetId) {
      try {
        const prof = await loadReferenceProfile(active.referenceDatasetId, active);
        reference = prof.meta;
      } catch {
        reference = null;
      }
    }
    return NextResponse.json({
      config,
      reference,
      storage: storageInfo(),
      history: [],
    });
  } catch (error) {
    console.error('Error GET /api/get-latest-psi:', error);
    return NextResponse.json({ error: 'Internal Server Error', detail: String(error) }, { status: 500 });
  }
}
