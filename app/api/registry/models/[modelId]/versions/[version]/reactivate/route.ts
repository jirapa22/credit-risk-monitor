/**
 * POST /api/registry/models/[modelId]/versions/[version]/reactivate
 *
 * Re-activates an ARCHIVED baseline version.
 * Requires running validateBaselineVersion first; if validation passes, transitions to ACTIVE.
 * Any previously ACTIVE version of the same model is automatically archived.
 */
import { NextResponse } from 'next/server';
import {
  BuiltInProtectedError,
  reactivateBaselineVersion,
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
    let actor = 'registry-panel';
    let note: string | undefined;
    try {
      const body = await request.json();
      if (body?.actor) actor = String(body.actor);
      if (body?.note) note = String(body.note);
    } catch {
      // empty body allowed
    }

    const result = await reactivateBaselineVersion(modelId, version, { by: actor, note });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BuiltInProtectedError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
    }
    if (error instanceof RegistryError) {
      return NextResponse.json(
        { ok: false, error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
