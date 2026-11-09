/**
 * POST /api/registry/models/[modelId]/versions/[version]/activate
 *
 * Transitions a VALIDATED BaselineVersion to ACTIVE and automatically
 * archives any previous ACTIVE version of the same model.
 */
import { NextResponse } from 'next/server';
import {
  activateBaselineVersion,
  BuiltInProtectedError,
  listBaselineVersions,
  RegistryError,
} from '../../../../../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: {
    params:
      | Promise<{ modelId: string; version: string }>
      | { modelId: string; version: string };
  },
) {
  try {
    const resolved = await Promise.resolve(context.params);
    const modelId = decodeURIComponent(resolved.modelId || '');
    const version = decodeURIComponent(resolved.version || '');
    let actor = 'system';
    try {
      const body = await request.json();
      if (body?.actor) actor = String(body.actor);
    } catch {
      // empty body is allowed
    }

    const beforeVersions = await listBaselineVersions(modelId);
    const prevActive = beforeVersions.find(v => v.status === 'ACTIVE' && v.version !== version);
    const activated = await activateBaselineVersion(modelId, version, { by: actor });
    return NextResponse.json({
      baseline: activated,
      archivedVersion: prevActive?.version ?? null,
    });
  } catch (error) {
    if (error instanceof BuiltInProtectedError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof RegistryError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
