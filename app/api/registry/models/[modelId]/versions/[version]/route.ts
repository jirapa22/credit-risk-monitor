/**
 * GET, DELETE /api/registry/models/[modelId]/versions/[version]
 *
 * GET: returns the baseline version details along with impact metrics
 *      (monitoring runs, sandbox runs, events, reviews) to preview before deletion.
 *
 * DELETE:
 *   - action === 'archive': archives the baseline version
 *   - action === 'delete': permanently deletes the baseline version, associated KV runs/events,
 *     and purges the Blob reference dataset if not used by any other remaining baseline version.
 *   - Note: ACTIVE baselines cannot be deleted directly (must archive first).
 *   - Built-in baselines cannot be deleted.
 */
import { NextResponse } from 'next/server';
import {
  archiveBaselineVersion,
  BuiltInProtectedError,
  deleteBaselineVersion,
  getBaselineVersionImpact,
  RegistryError,
} from '../../../../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ modelId: string; version: string }> | { modelId: string; version: string } },
) {
  try {
    const resolved = await Promise.resolve(context.params);
    const modelId = decodeURIComponent(resolved.modelId || '');
    const version = decodeURIComponent(resolved.version || '');

    const impact = await getBaselineVersionImpact(modelId, version);
    return NextResponse.json({ ok: true, ...impact });
  } catch (error) {
    if (error instanceof RegistryError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ modelId: string; version: string }> | { modelId: string; version: string } },
) {
  try {
    const resolved = await Promise.resolve(context.params);
    const modelId = decodeURIComponent(resolved.modelId || '');
    const version = decodeURIComponent(resolved.version || '');

    let action: 'delete' | 'archive' = 'delete';
    try {
      const body = await request.json();
      if (body?.action === 'archive') action = 'archive';
    } catch {
      // Body is optional, default action is delete
    }

    if (action === 'archive') {
      const updated = await archiveBaselineVersion(modelId, version, { by: 'api-user' });
      return NextResponse.json({ ok: true, action: 'archived', baseline: updated });
    }

    const result = await deleteBaselineVersion(modelId, version, { purgeBlob: true });
    return NextResponse.json({ ok: true, action: 'deleted', ...result });
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
