/**
 * GET /api/registry/models/[modelId]/versions/[version]/export
 *
 * Exports a BaselineVersion JSON bundle including `{ baseline, reference: { meta, rows } }`
 * for backup, transfer, or archiving.
 */
import { NextResponse } from 'next/server';
import {
  exportBaselineVersion,
  RegistryError,
} from '../../../../../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
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
    const bundle = await exportBaselineVersion(modelId, version);
    return NextResponse.json(bundle);
  } catch (error) {
    if (error instanceof RegistryError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
