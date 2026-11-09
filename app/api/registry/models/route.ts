/**
 * GET /api/registry/models
 *
 * Lists all models in the Baseline Registry (including built-in ascore_v1),
 * their active version, total versions, and the current default modelId.
 */
import { NextResponse } from 'next/server';
import {
  blobStorageInfo,
} from '../../../../lib/storage/blob';
import {
  getDefaultModelId,
  listBaselineVersions,
  listRegistryModels,
  storageInfo,
} from '../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { defaultModelId, models } = await listRegistryModels();
    const detailed = models.map(m => ({
      ...m,
      activeBaseline: m.activeVersion,
    }));
    return NextResponse.json({
      defaultModelId,
      models: detailed,
      storage: storageInfo(),
      blobStorage: blobStorageInfo(),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
