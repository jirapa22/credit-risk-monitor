/**
 * POST /api/registry/default
 *
 * Sets the default modelId used by the web UI and APIs when ?modelId= is omitted.
 * Body: { modelId: string }
 */
import { NextResponse } from 'next/server';
import {
  getDefaultModelId,
  RegistryError,
  setDefaultModelId,
} from '../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const defaultModelId = await getDefaultModelId();
    return NextResponse.json({ defaultModelId });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const modelId = typeof body?.modelId === 'string' ? body.modelId.trim() : '';
    if (!modelId) {
      return NextResponse.json({ error: 'ต้องระบุ modelId' }, { status: 400 });
    }
    const updated = await setDefaultModelId(modelId);
    return NextResponse.json({ defaultModelId: updated });
  } catch (error) {
    if (error instanceof RegistryError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

