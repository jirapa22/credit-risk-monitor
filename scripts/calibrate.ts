/**
 * Null-distribution Calibration CLI Runner (Step 11b.1).
 *
 * Usage:
 *   npm run calibrate                  # calibrates active model (ascore_v1)
 *   npm run calibrate -- --model ext_model
 */
import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { calibrateThresholds, DEFAULT_CALIBRATION_SIZES, DEFAULT_CALIBRATION_RESAMPLES } from '../lib/calibration';
import {
  getDefaultModelId,
  getEffectiveModel,
  loadReferenceProfile,
  listBaselineVersions,
  saveStoredVersions,
  getStoredVersions,
} from '../lib/storage/repositories';

function parseArg(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const defaultModel = await getDefaultModelId();
  const modelId = parseArg(argv, '--model') || defaultModel;
  const resamplesArg = parseArg(argv, '--resamples');
  const resamples = resamplesArg ? Number(resamplesArg) : DEFAULT_CALIBRATION_RESAMPLES;

  console.log(`\n======================================================`);
  console.log(`  Calibrating Null-Distribution Thresholds`);
  console.log(`  Model: ${modelId}`);
  console.log(`  Resamples: ${resamples}`);
  console.log(`  Sizes: ${DEFAULT_CALIBRATION_SIZES.join(', ')}`);
  console.log(`======================================================\n`);

  const t0 = Date.now();
  const model = await getEffectiveModel(modelId);
  const profile = await loadReferenceProfile(model.referenceDatasetId, model);

  const calibrated = calibrateThresholds(profile, model, { resamples });
  const elapsedMs = Date.now() - t0;

  console.log(`✓ Completed in ${(elapsedMs / 1000).toFixed(2)}s\n`);

  // Print comparison table for n = 250 and 1000
  const rowsToDisplay: any[] = [];
  const targetSizes = [250, 1000];

  for (const n of targetSizes) {
    const byN = calibrated.bySize[n];
    if (!byN) continue;

    if (byN.psi) {
      rowsToDisplay.push({
        'Size (n)': n,
        'Metric': 'PSI',
        'Feature/Score': 'score',
        'Calibrated Warning': byN.psi.warning.toFixed(4),
        'Calibrated Critical': byN.psi.critical.toFixed(4),
        'Fixed Warning': (model.thresholds?.psi_warning ?? 0.10).toFixed(4),
        'Fixed Critical': (model.thresholds?.psi_critical ?? 0.25).toFixed(4),
      });
    }

    for (const [feat, pair] of Object.entries(byN.csi)) {
      const fixedWarn = model.thresholds?.csi_features?.[feat]?.threshold ?? 0.10;
      rowsToDisplay.push({
        'Size (n)': n,
        'Metric': 'CSI',
        'Feature/Score': feat,
        'Calibrated Warning': pair.warning.toFixed(4),
        'Calibrated Critical': pair.critical.toFixed(4),
        'Fixed Warning': fixedWarn.toFixed(4),
        'Fixed Critical': Math.max(0.25, fixedWarn).toFixed(4),
      });
    }

    for (const [feat, pair] of Object.entries(byN.ks)) {
      rowsToDisplay.push({
        'Size (n)': n,
        'Metric': 'KS',
        'Feature/Score': feat,
        'Calibrated Warning': pair.warning.toFixed(4),
        'Calibrated Critical': pair.critical.toFixed(4),
        'Fixed Warning': (model.driftConfig?.ksWarning ?? 0.10).toFixed(4),
        'Fixed Critical': (model.driftConfig?.ksCritical ?? 0.20).toFixed(4),
      });
    }

    for (const [feat, pair] of Object.entries(byN.wasserstein)) {
      rowsToDisplay.push({
        'Size (n)': n,
        'Metric': 'Wasserstein',
        'Feature/Score': feat,
        'Calibrated Warning': pair.warning.toFixed(4),
        'Calibrated Critical': pair.critical.toFixed(4),
        'Fixed Warning': (model.driftConfig?.wassersteinWarning ?? 0.10).toFixed(4),
        'Fixed Critical': (model.driftConfig?.wassersteinCritical ?? 0.25).toFixed(4),
      });
    }

    for (const [feat, pair] of Object.entries(byN.js)) {
      rowsToDisplay.push({
        'Size (n)': n,
        'Metric': 'JS',
        'Feature/Score': feat,
        'Calibrated Warning': pair.warning.toFixed(4),
        'Calibrated Critical': pair.critical.toFixed(4),
        'Fixed Warning': (model.driftConfig?.jsWarning ?? 0.10).toFixed(4),
        'Fixed Critical': (model.driftConfig?.jsCritical ?? 0.20).toFixed(4),
      });
    }
  }

  console.table(rowsToDisplay);

  // Write CSV
  const csvRows: any[] = [];
  for (const n of calibrated.sizes) {
    const byN = calibrated.bySize[n];
    if (!byN) continue;

    if (byN.psi) {
      csvRows.push({
        model_id: modelId,
        n,
        metric: 'psi',
        feature: 'score',
        warning: byN.psi.warning,
        critical: byN.psi.critical,
      });
    }
    for (const [feat, pair] of Object.entries(byN.csi)) {
      csvRows.push({
        model_id: modelId,
        n,
        metric: 'csi',
        feature: feat,
        warning: pair.warning,
        critical: pair.critical,
      });
    }
    for (const [feat, pair] of Object.entries(byN.ks)) {
      csvRows.push({
        model_id: modelId,
        n,
        metric: 'ks',
        feature: feat,
        warning: pair.warning,
        critical: pair.critical,
      });
    }
    for (const [feat, pair] of Object.entries(byN.wasserstein)) {
      csvRows.push({
        model_id: modelId,
        n,
        metric: 'wasserstein',
        feature: feat,
        warning: pair.warning,
        critical: pair.critical,
      });
    }
    for (const [feat, pair] of Object.entries(byN.js)) {
      csvRows.push({
        model_id: modelId,
        n,
        metric: 'js',
        feature: feat,
        warning: pair.warning,
        critical: pair.critical,
      });
    }
  }

  const outDir = join(process.cwd(), 'results');
  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csvFileName = `calibration_${modelId}_${timestamp}.csv`;
  const csvPath = join(outDir, csvFileName);

  const csvHeader = ['model_id', 'n', 'metric', 'feature', 'warning', 'critical'];
  const csvContent = [
    csvHeader.join(','),
    ...csvRows.map(r => csvHeader.map(h => r[h] ?? '').join(',')),
  ].join('\n');

  writeFileSync(csvPath, csvContent, 'utf8');
  console.log(`\nResults written to: ${csvPath}\n`);

  // Persist calibratedThresholds in stored version if it exists
  try {
    const stored = await getStoredVersions(modelId);
    const activeIdx = stored.findIndex((v: any) => v.status === 'ACTIVE');
    if (activeIdx !== -1) {
      stored[activeIdx].calibratedThresholds = calibrated;
      await saveStoredVersions(modelId, stored);
      console.log(`✓ Attached calibratedThresholds to stored model "${modelId}"`);
    }
  } catch {
    // Built-in or read-only
  }
}

main().catch(err => {
  console.error('Calibration error:', err);
  process.exit(1);
});
