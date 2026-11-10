/**
 * GET /api/registry/models
 *
 * Lists all models in the Baseline Registry (including built-in ascore_v1),
 * their active version, all versions, total versions, and the current default modelId.
 */
import { NextResponse } from 'next/server';
import { blobStorageInfo } from '../../../../lib/storage/blob';
import {
  listBaselineVersions,
  listRegistryModels,
  storageInfo,
} from '../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { defaultModelId, models } = await listRegistryModels();
    const detailed = await Promise.all(
      models.map(async m => {
        const versions = await listBaselineVersions(m.modelId);
        return {
          ...m,
          activeBaseline: m.activeVersion,
          versions,
        };
      }),
    );
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
