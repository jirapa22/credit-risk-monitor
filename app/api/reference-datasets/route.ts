/**
 * GET /api/reference-datasets → metadata of all frozen reference datasets
 * (id, version, row count, bad rate, period, sha256). Rows are not returned.
 */
import { NextResponse } from 'next/server';
import { listReferenceDatasets } from '@/lib/reference';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ datasets: listReferenceDatasets() });
}
