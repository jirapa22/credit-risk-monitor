/**
 * POST /api/registry/import
 *
 * Imports a BaselineVersion JSON bundle `{ baseline, reference }` into the registry
 * as a DRAFT version (storing the reference dataset in blob storage if not built-in).
 * Built-in modelId (ascore_v1) is protected and returns 403.
 */
import { NextResponse } from 'next/server';
import {
  BuiltInProtectedError,
  importBaselineVersion,
  RegistryError,
} from '../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const imported = await importBaselineVersion(body);
    return NextResponse.json({ baseline: imported }, { status: 201 });
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
