/**
 * Seed Sample Models (Step 11b.3).
 *
 * Registers and activates samples/ext_model.baseline.json with samples/baseline_ext_model.csv.
 * Idempotent: running multiple times does not produce duplicate versions.
 *
 * Usage:
 *   npm run seed:samples
 */
import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../lib/csv';
import { saveReferenceDatasetBlob } from '../lib/storage/blob';
import { registerReferenceDataset } from '../lib/reference';
import {
  activateBaselineVersion,
  createDraftBaselineVersion,
  listBaselineVersions,
  validateBaselineVersion,
} from '../lib/storage/repositories';

export async function seedSampleModels(): Promise<{ modelId: string; version: string; created: boolean }> {
  const modelId = 'ext_model';
  const version = '1.0.0';

  // 1. Check existing versions (idempotence)
  const existing = await listBaselineVersions(modelId).catch(() => []);
  const active = existing.find(v => v.version === version && v.status === 'ACTIVE');
  if (active) {
    console.log(`✓ Model "${modelId}@${version}" is already active in local store. Skipping duplicate creation.`);
    return { modelId, version, created: false };
  }

  // 2. Load baseline config and CSV reference data
  const jsonPath = join(process.cwd(), 'samples', 'ext_model.baseline.json');
  const csvPath = join(process.cwd(), 'samples', 'baseline_ext_model.csv');

  const baselineJson = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const csvText = readFileSync(csvPath, 'utf8');
  const { rows } = parseCsv(csvText);

  const refId = baselineJson.referenceDatasetId || 'ext_model_ref_301';

  // 3. Save reference dataset blob
  const refBlob = {
    meta: {
      referenceId: refId,
      version: '1.0.0',
      fileName: 'baseline_ext_model.csv',
      rowCount: rows.length,
      uploadedAt: new Date().toISOString(),
      uploadedBy: 'seeder',
      labelColumn: baselineJson.columns.labelColumn,
      dateColumn: baselineJson.columns.dateColumn,
      scoreColumn: baselineJson.columns.scoreColumn,
      columns: Object.keys(rows[0] ?? {}),
      numericColumns: ['รายได้ต่อเดือน', 'วงเงินสินเชื่อ', 'สัดส่วนภาระหนี้', 'pd_score'],
      categoricalColumns: ['กลุ่มอาชีพ'],
      sha256: 'seed_sample_hash',
      source: 'samples/baseline_ext_model.csv',
    },
    rows,
  };

  await saveReferenceDatasetBlob(refBlob as any);
  registerReferenceDataset(refBlob.meta as any, rows);
  console.log(`✓ Registered reference blob "${refId}" (${rows.length} rows)`);

  // 4. Create draft baseline version if not already present
  const hasDraft = existing.find(v => v.version === version);
  if (!hasDraft) {
    await createDraftBaselineVersion(modelId, baselineJson, {
      by: 'seeder',
      note: 'Seeded external sample model (Step 11b.3)',
    });
    console.log(`✓ Created draft baseline "${modelId}@${version}"`);
  }

  // 5. Validate baseline version
  const valRes = await validateBaselineVersion(modelId, version, {
    by: 'seeder',
    note: 'Validated seeded external sample model',
    calibrationResamples: 200,
  });
  if (!valRes.ok) {
    throw new Error(`Validation failed for "${modelId}@${version}": ${JSON.stringify(valRes.report.errors)}`);
  }
  console.log(`✓ Validated baseline "${modelId}@${version}"`);

  // 6. Activate baseline version
  await activateBaselineVersion(modelId, version, {
    by: 'seeder',
    note: 'Activated seeded external sample model',
  });
  console.log(`✓ Activated baseline "${modelId}@${version}"`);

  return { modelId, version, created: true };
}

async function main() {
  console.log('\n======================================================');
  console.log('  Seeding Sample Models');
  console.log('======================================================\n');

  const res = await seedSampleModels();
  console.log(`\nDone: ${res.modelId}@${res.version} (created: ${res.created})\n`);
}

if (process.argv[1]?.endsWith('seed_samples.ts')) {
  main().catch(err => {
    console.error('Seed error:', err);
    process.exit(1);
  });
}
