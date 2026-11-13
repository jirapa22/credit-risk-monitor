/**
 * GET /api/registry/models/[modelId]
 *
 * Returns model metadata, active baseline version, and all baseline versions
 * for the requested modelId.
 */
import { NextResponse } from 'next/server';
import {
  BuiltInProtectedError,
  deleteRegistryModel,
  getActiveBaseline,
  getDefaultModelId,
  getModel,
  listBaselineVersions,
  RegistryError,
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

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ modelId: string }> | { modelId: string } },
) {
  try {
    const resolved = await Promise.resolve(context.params);
    const modelId = decodeURIComponent(resolved.modelId || '');

    const result = await deleteRegistryModel(modelId, { actor: 'api-user' });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof BuiltInProtectedError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
    }
    if (error instanceof RegistryError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
