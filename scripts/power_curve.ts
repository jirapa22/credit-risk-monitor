/**
 * Drift Sensitivity / Power Curve CLI Runner (Step 11b.2).
 *
 * Usage:
 *   npm run power -- --quick --model ascore_v1
 *   npm run power -- --model ascore_v1
 *   npm run power -- --model ext_model
 */
import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { calibrateThresholds } from '../lib/calibration';
import { injectAnomaly } from '../lib/injection';
import { resolveCsiFeatures } from '../lib/drift';
import { psiForCategories, psiWithBoundaries, jensenShannonDistance } from '../lib/stats';
import { ksTwoSample, wassersteinScaled } from '../lib/driftReport';
import { calculateAScore } from '../lib/scoring';
import {
  getDefaultModelId,
  getEffectiveModel,
  loadReferenceProfile,
} from '../lib/storage/repositories';
import type { AnomalyTransform, AnomalyType } from '../lib/types';

function parseArg(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

const SHIFT_SPECS: Record<string, { type: AnomalyType; magnitudes: number[] }> = {
  mix_shift: {
    type: 'mix_shift',
    magnitudes: [0.0, 0.025, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40],
  },
  mean_shift: {
    type: 'mean_shift',
    magnitudes: [0.0, -0.025, -0.05, -0.075, -0.10, -0.15, -0.20, -0.30],
  },
  label_shift: {
    type: 'label_shift',
    magnitudes: [1.0, 1.1, 1.25, 1.5, 2.0],
  },
  category_shift: {
    type: 'category_shift',
    magnitudes: [0.0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40],
  },
};

async function main() {
  const argv = process.argv.slice(2);
  const quick = argv.includes('--quick');
  const defaultModel = await getDefaultModelId();
  const modelId = parseArg(argv, '--model') || defaultModel;

  const SIZES = quick ? [250, 1000] : [100, 250, 500, 1000, 2500];
  const SEED_COUNT = quick ? 10 : 30;

  console.log(`\n======================================================`);
  console.log(`  Running Drift Sensitivity Power Curve`);
  console.log(`  Model: ${modelId}`);
  console.log(`  Mode: ${quick ? 'QUICK (sizes: [250, 1000], seeds: 10)' : 'FULL (sizes: [100..2500], seeds: 30)'}`);
  console.log(`======================================================\n`);

  const t0 = Date.now();
  const model = await getEffectiveModel(modelId);
  const profile = await loadReferenceProfile(model.referenceDatasetId, model);

  // 1. Ensure calibration is available
  console.log('Calibrating null thresholds...');
  const calibrated = model.calibratedThresholds ?? calibrateThresholds(profile, model, { sizes: SIZES });
  console.log('✓ Null calibration ready.\n');

  const registry = model.featureRegistry ?? {};
  const thresholds = model.thresholds ?? { csi_features: {} };
  const csiFeatures = resolveCsiFeatures(registry, thresholds, profile);

  const hasScore = Boolean(profile.hasScores && profile.scores && profile.scores.length > 0);
  const hasLabels = Boolean(profile.hasLabels && profile.labels && profile.labels.length > 0);
  const hasCategorical = csiFeatures.some(f => f.dataType === 'categorical' && !f.skipped);

  const activeTypes: string[] = ['mix_shift', 'mean_shift'];
  if (hasLabels) activeTypes.push('label_shift');
  if (hasCategorical) activeTypes.push('category_shift');

  const csvRows: any[] = [];
  const jsonCurves: any[] = [];

  // Summary results for quick display
  const displaySummary: any[] = [];

  for (const typeKey of activeTypes) {
    const shiftSpec = SHIFT_SPECS[typeKey];
    if (!shiftSpec) continue;

    console.log(`Analyzing power curve for "${typeKey}"...`);

    for (const n of SIZES) {
      const calThr = calibrated.bySize[n];

      for (const mag of shiftSpec.magnitudes) {
        const metricHits: Record<string, { fixed: number; calibrated: number }> = {};
        const initMetric = (m: string) => {
          if (!metricHits[m]) metricHits[m] = { fixed: 0, calibrated: 0 };
        };

        let targetCol = '';

        for (let s = 1; s <= SEED_COUNT; s++) {
          const inj = injectAnomaly(model, {
            type: shiftSpec.type,
            magnitude: mag,
            n,
            seed: s + 1000,
            rate: 1,
          });

          if (inj.skipped) continue;

          if (typeKey === 'mix_shift' || typeKey === 'mean_shift') {
            const fKey = inj.spec.targetFeatures?.[0] || Object.keys(registry)[0];
            targetCol = fKey;
            const fDef = registry[fKey];
            const refVals = profile.features[fKey] ?? [];
            const actVals = inj.rows.map(r => Number(r[fKey])).filter(Number.isFinite);
            const bins = csiFeatures.find(cf => cf.key === fKey)?.bins ?? [];

            // CSI
            initMetric('csi');
            const csiVal = psiWithBoundaries(refVals, actVals, bins).value;
            const fixedCsiWarn = thresholds.csi_features?.[fKey]?.threshold ?? fDef?.csiThreshold ?? 0.10;
            const calCsiWarn = calThr?.csi?.[fKey]?.warning ?? fixedCsiWarn;
            if (csiVal >= fixedCsiWarn) metricHits.csi.fixed++;
            if (csiVal >= calCsiWarn) metricHits.csi.calibrated++;

            // KS D
            initMetric('ks');
            const ksVal = ksTwoSample(refVals, actVals).d;
            const fixedKsWarn = model.driftConfig?.ksWarning ?? 0.10;
            const calKsWarn = calThr?.ks?.[fKey]?.warning ?? fixedKsWarn;
            if (ksVal >= fixedKsWarn) metricHits.ks.fixed++;
            if (ksVal >= calKsWarn) metricHits.ks.calibrated++;

            // Wasserstein
            initMetric('wasserstein');
            const transform = (fDef?.anomalyTransform ?? 'none') as AnomalyTransform;
            const wassVal = wassersteinScaled(refVals, actVals, transform).scaled;
            const fixedWassWarn = model.driftConfig?.wassersteinWarning ?? 0.10;
            const calWassWarn = calThr?.wasserstein?.[fKey]?.warning ?? fixedWassWarn;
            if (wassVal >= fixedWassWarn) metricHits.wasserstein.fixed++;
            if (wassVal >= calWassWarn) metricHits.wasserstein.calibrated++;

            // PSI on score
            if (hasScore) {
              initMetric('psi');
              let actScores: number[] = [];
              if (model.scoring?.scorecard && Object.keys(model.scoring.scorecard).length > 0) {
                actScores = inj.rows.map(r => calculateAScore(model.scoring, r as any));
              } else if (model.columns?.scoreColumn && inj.columns.includes(model.columns.scoreColumn)) {
                actScores = inj.rows.map(r => Number(r[model.columns.scoreColumn])).filter(Number.isFinite);
              }
              if (actScores.length > 0) {
                const psiVal = psiWithBoundaries(profile.scores, actScores, profile.scoreBoundaries).value;
                const fixedPsiWarn = thresholds.psi_warning ?? 0.10;
                const calPsiWarn = calThr?.psi?.warning ?? fixedPsiWarn;
                if (psiVal >= fixedPsiWarn) metricHits.psi.fixed++;
                if (psiVal >= calPsiWarn) metricHits.psi.calibrated++;
              }
            }
          } else if (typeKey === 'label_shift') {
            const lblCol = model.columns?.labelColumn || 'default_flag';
            targetCol = lblCol;
            initMetric('label_rate');

            const actLabels = inj.rows.map(r => Number(r[lblCol]));
            const bads = actLabels.filter(l => l === 1).length;
            const pAct = actLabels.length > 0 ? bads / actLabels.length : 0;
            const refBads = profile.labels.filter(l => l === 1).length;
            const pRef = profile.labels.length > 0 ? refBads / profile.labels.length : 0.10;

            const relChange = pRef > 0 ? Math.abs(pAct - pRef) / pRef : 0;

            // Two-proportion z-test
            const nAct = actLabels.length;
            const nRef = profile.labels.length;
            const pPool = (bads + refBads) / (nAct + nRef);
            const se = Math.sqrt(Math.max(1e-12, pPool * (1 - pPool) * (1 / nAct + 1 / nRef)));
            const z = (pAct - pRef) / se;
            const pVal = 2 * (1 - 0.5 * (1 + Math.sign(Math.abs(z)) * (1 - Math.exp(-Math.abs(z) * 0.7071))));

            const isAlarm = relChange >= 0.20 && pVal < 0.05;
            if (isAlarm) {
              metricHits.label_rate.fixed++;
              metricHits.label_rate.calibrated++;
            }
          } else if (typeKey === 'category_shift') {
            const catSpec = csiFeatures.find(cf => cf.dataType === 'categorical' && !cf.skipped);
            if (catSpec) {
              targetCol = catSpec.key;
              const refCats = profile.categoricalFeatures?.[catSpec.key] ?? [];
              const actCats = inj.rows.map(r => String(r[catSpec.key] ?? ''));

              // Cat CSI
              initMetric('csi');
              const catPsi = psiForCategories(refCats, actCats, catSpec.categories ?? []);
              const fixedCsiWarn = thresholds.csi_features?.[catSpec.key]?.threshold ?? 0.10;
              const calCsiWarn = calThr?.csi?.[catSpec.key]?.warning ?? fixedCsiWarn;
              if (catPsi.value >= fixedCsiWarn) metricHits.csi.fixed++;
              if (catPsi.value >= calCsiWarn) metricHits.csi.calibrated++;

              // JS Distance
              initMetric('js');
              const expectedCounts = catPsi.bins.map(b => b.expectedCount);
              const actualCounts = catPsi.bins.map(b => b.actualCount);
              const jsDist = jensenShannonDistance(expectedCounts, actualCounts).distance;
              const fixedJsWarn = model.driftConfig?.jsWarning ?? 0.10;
              const calJsWarn = calThr?.js?.[catSpec.key]?.warning ?? fixedJsWarn;
              if (jsDist >= fixedJsWarn) metricHits.js.fixed++;
              if (jsDist >= calJsWarn) metricHits.js.calibrated++;
            }
          }
        }

        const metricsObj: Record<string, { fixed: number; calibrated: number }> = {};
        for (const [m, counts] of Object.entries(metricHits)) {
          const fixedRate = Number((counts.fixed / SEED_COUNT).toFixed(4));
          const calRate = Number((counts.calibrated / SEED_COUNT).toFixed(4));
          metricsObj[m] = { fixed: fixedRate, calibrated: calRate };

          csvRows.push({
            model_id: modelId,
            type: typeKey,
            target_feature: targetCol,
            n,
            magnitude: mag,
            metric: m,
            fixed_detection_rate: fixedRate,
            calibrated_detection_rate: calRate,
          });

          if (mag === 0 || mag === 1.0) {
            displaySummary.push({
              'Type': typeKey,
              'Size (n)': n,
              'Metric': m,
              'Magnitude': mag,
              'Fixed False Alarm': (fixedRate * 100).toFixed(1) + '%',
              'Calibrated False Alarm': (calRate * 100).toFixed(1) + '%',
            });
          }
        }

        jsonCurves.push({
          type: typeKey,
          targetFeature: targetCol,
          n,
          magnitude: mag,
          metrics: metricsObj,
        });
      }
    }
  }

  const elapsedSec = (Date.now() - t0) / 1000;
  console.log(`\n✓ Power curve finished in ${elapsedSec.toFixed(2)}s\n`);

  console.log('──────────────────────────────────────────────────────');
  console.log('  False Alarm Rate at Magnitude 0 (Clean Data)');
  console.log('──────────────────────────────────────────────────────');
  console.table(displaySummary);

  // Write CSV
  const outDir = join(process.cwd(), 'results');
  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csvPath = join(outDir, `power_${modelId}_${timestamp}.csv`);
  const csvHeader = [
    'model_id',
    'type',
    'target_feature',
    'n',
    'magnitude',
    'metric',
    'fixed_detection_rate',
    'calibrated_detection_rate',
  ];
  const csvContent = [
    csvHeader.join(','),
    ...csvRows.map(r => csvHeader.map(h => r[h] ?? '').join(',')),
  ].join('\n');
  writeFileSync(csvPath, csvContent, 'utf8');
  console.log(`Results CSV written to: ${csvPath}`);

  // Write JSON for Web UI
  const pubDir = join(process.cwd(), 'public', 'experiments');
  mkdirSync(pubDir, { recursive: true });
  const jsonPath = join(pubDir, `power_${modelId}.json`);
  writeFileSync(
    jsonPath,
    JSON.stringify({
      modelId,
      createdAt: new Date().toISOString(),
      quick,
      sizes: SIZES,
      seeds: SEED_COUNT,
      curves: jsonCurves,
    }, null, 2),
    'utf8',
  );
  console.log(`Web UI JSON written to: ${jsonPath}\n`);
}

main().catch(err => {
  console.error('Power curve error:', err);
  process.exit(1);
});
