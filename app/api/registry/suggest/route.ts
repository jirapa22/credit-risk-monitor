/**
 * POST /api/registry/suggest
 *
 * Accepts `{ referenceId, mapping?, scoringFeatures?, scoring? }`, loads the
 * Reference dataset from blob/built-in storage, builds a privacy-safe
 * `DatasetProfile` (no raw rows), and returns column role suggestions,
 * feature setting suggestions, and auto-detected scoreDirection.
 */
import { NextResponse } from 'next/server';
import { loadReferenceDatasetBlob } from '../../../../lib/storage/blob';
import { generateSuggestions, type ColumnMappingEntry } from '../../../../lib/suggest';
import type { ScoringConfig } from '../../../../lib/types';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const referenceId = typeof body?.referenceId === 'string' ? body.referenceId.trim() : '';
    if (!referenceId) {
      return NextResponse.json(
        { error: 'ต้องระบุ referenceId' },
        { status: 400 },
      );
    }

    const blob = await loadReferenceDatasetBlob(referenceId);
    if (!blob) {
      return NextResponse.json(
        { error: `ไม่พบ Reference Dataset "${referenceId}" ในระบบ` },
        { status: 404 },
      );
    }

    const mapping: ColumnMappingEntry[] | undefined = Array.isArray(body?.mapping)
      ? body.mapping
      : undefined;
    const scoringFeatures: string[] | undefined = Array.isArray(body?.scoringFeatures)
      ? body.scoringFeatures.map(String)
      : undefined;
    const scoring: ScoringConfig | null =
      body?.scoring && typeof body.scoring === 'object' ? body.scoring : null;
    const providerType =
      body?.provider === 'heuristic' || body?.provider === 'ai' || body?.provider === 'auto'
        ? body.provider
        : 'auto';
    const combinedStrategy = body?.strategy === 'confidence' ? 'confidence' : 'ai_primary';

    const result = await generateSuggestions({
      referenceId,
      rows: blob.rows,
      columns: blob.meta.columns,
      mapping,
      scoringFeatures,
      scoring,
      providerType,
      combinedStrategy,
      sha256: blob.meta.sha256,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

