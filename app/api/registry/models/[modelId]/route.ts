/**
 * GET /api/registry/models/[modelId]
 *
 * Returns model metadata, active baseline version, and all baseline versions
 * for the requested modelId.
 */
import { NextResponse } from 'next/server';
import {
  getActiveBaseline,
  getDefaultModelId,
  getModel,
  listBaselineVersions,
} from '../../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ modelId: string }> | { modelId: string } },
) {
  try {
    const resolved = await Promise.resolve(context.params);
    const modelId = decodeURIComponent(resolved.modelId || '');
    const info = await getModel(modelId);
    if (!info) {
      return NextResponse.json(
        { error: `ไม่พบโมเดล "${modelId}" ใน Registry` },
        { status: 404 },
      );
    }
    const defaultModelId = await getDefaultModelId();
    return NextResponse.json({
      model: {
        ...info.model,
        isDefault: info.isDefault,
        activeVersion: info.activeVersion?.version ?? null,
      },
      activeBaseline: info.activeVersion,
      versions: info.versions,
      defaultModelId,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
