/**
 * GET /api/model-config
 *
 * Returns the full resolved model configuration as JSON.
 * Consumer (UI or external tooling) can call this endpoint to read the
 * current config without importing TypeScript modules directly.
 *
 * Response shape matches the `ModelConfiguration` interface defined in
 * `app/config/model/types.ts`.
 */

import { NextResponse } from 'next/server';
import { modelConfiguration } from '../../config/model';

export async function GET() {
  return NextResponse.json(modelConfiguration);
}
