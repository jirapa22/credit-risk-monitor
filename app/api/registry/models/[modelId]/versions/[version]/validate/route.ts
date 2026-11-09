/**
 * POST /api/registry/models/[modelId]/versions/[version]/validate
 *
 * Runs validateBaseline(baseline, referenceRows).
 * If report.ok === true -> transitions status from DRAFT to VALIDATED.
 * If report.ok === false -> stays DRAFT and saves the validationReport.
 */
import { NextResponse } from 'next/server';
import {
  BuiltInProtectedError,
  RegistryError,
  validateBaselineVersion,
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

    const { ok, version: updatedBaseline, report } = await validateBaselineVersion(
      modelId,
      version,
      { by: actor },
    );
    return NextResponse.json({
      ok,
      status: updatedBaseline.status,
      baseline: updatedBaseline,
      validationReport: report,
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
