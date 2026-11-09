/**
 * POST /api/registry/models/[modelId]/versions/[version]/archive
 *
 * Archives a BaselineVersion. Built-in baselines (ascore_v1) return 403.
 */
import { NextResponse } from 'next/server';
import {
  archiveBaselineVersion,
  BuiltInProtectedError,
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
    let note: string | undefined;
    try {
      const body = await request.json();
      if (body?.actor) actor = String(body.actor);
      if (body?.note) note = String(body.note);
    } catch {
      // empty body is allowed
    }

    const archived = await archiveBaselineVersion(modelId, version, { by: actor, note });
    return NextResponse.json({ baseline: archived });
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
