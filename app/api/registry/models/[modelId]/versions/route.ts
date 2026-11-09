/**
 * POST /api/registry/models/[modelId]/versions
 *
 * Creates a new BaselineVersion with status = 'DRAFT'.
 * If the model does not exist yet, creates it in the registry.
 * Built-in models (ascore_v1) are read-only and return 403.
 */
import { NextResponse } from 'next/server';
import {
  BuiltInProtectedError,
  createDraftBaselineVersion,
  RegistryError,
} from '../../../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ modelId: string }> | { modelId: string } },
) {
  try {
    const resolved = await Promise.resolve(context.params);
    const modelId = decodeURIComponent(resolved.modelId || '');
    const body = await request.json();

    const draft = await createDraftBaselineVersion(modelId, body);
    return NextResponse.json({ baseline: draft }, { status: 201 });
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
