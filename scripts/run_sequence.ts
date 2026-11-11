/**
 * CLI Runner for Multi-Month Sequence Simulation (Step 11a.2).
 *
 * Usage:
 *   npm run sequence -- --type mean_shift --pattern sudden --magnitude -0.20
 *   npm run sequence -- --type mean_shift --pattern gradual --startMonth 6
 *   npm run sequence -- --model ascore_v1 --type label_shift --pattern sudden
 */
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSequence, getDefaultMagnitude } from '../lib/sequence';
import { getDefaultModelId } from '../lib/storage/repositories';
import { toCsv } from '../lib/injection';
import type { AnomalyType } from '../lib/types';

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
  const typeArg = (parseArg(argv, '--type') || 'mean_shift') as AnomalyType;
  const patternArg = (parseArg(argv, '--pattern') || 'sudden') as 'gradual' | 'sudden';
  const startMonth = Number(parseArg(argv, '--startMonth') || '6');
  const seed = Number(parseArg(argv, '--seed') || '42');
  const monthsCount = Number(parseArg(argv, '--months') || '12');

  const magArg = parseArg(argv, '--magnitude');
  const endMagnitude = magArg !== undefined ? Number(magArg) : getDefaultMagnitude(typeArg);

  console.log(`\n======================================================`);
  console.log(`  Running Multi-Month Sequence Simulation`);
  console.log(`  Model: ${modelId}`);
  console.log(`  Type: ${typeArg}`);
  console.log(`  Pattern: ${patternArg}`);
  console.log(`  Start Month: Month ${startMonth}`);
  console.log(`  End Magnitude: ${endMagnitude}`);
  console.log(`  Seed: ${seed}`);
  console.log(`======================================================\n`);

  const result = await runSequence(modelId, {
    type: typeArg,
    pattern: patternArg,
    startMonth,
    endMagnitude,
    seed,
    monthsCount,
  });

  const { summary, months } = result;

  console.table(
    months.map(m => ({
      'Month': `M${String(m.month).padStart(2, '0')}`,
      'Injected': m.injectedType === 'none' ? 'none' : `${m.injectedType} (${m.injectedMagnitude})`,
      'Covariate': m.covariateStatus,
      'Missing': m.missingStatus,
      'Label': m.labelStatus,
      'Concept': m.conceptStatus,
      'Overall': m.overallStatus,
      'PSI': m.psi !== null ? m.psi.toFixed(4) : '-',
      'Top CSI': m.topCsi !== null ? `${m.topCsi.toFixed(4)} (${m.topCsiFeature})` : '-',
      'Action': m.triggerAction,
      'Rule': m.matchedRuleId ?? '-',
    })),
  );

  console.log(`\n------------------------------------------------------`);
  console.log(`  Simulation Summary:`);
  console.log(`  - False Alarms Before Month ${summary.startMonth}: ${summary.falseAlarmsBeforeStart}`);
  console.log(`  - First Alarm Month: ${summary.firstAlarmMonth !== null ? `Month ${summary.firstAlarmMonth}` : 'None'}`);
  console.log(`  - Detection Delay: ${summary.detectionDelay !== null ? `${summary.detectionDelay} month(s)` : 'N/A'}`);
  console.log(`  - First CONSIDER_RETRAIN Month: ${summary.firstRetrainMonth !== null ? `Month ${summary.firstRetrainMonth}` : 'None'}`);
  console.log(`------------------------------------------------------\n`);

  // Write CSV
  const outDir = join(process.cwd(), 'results');
  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csvFileName = `sequence_${modelId}_${typeArg}_${patternArg}_${timestamp}.csv`;
  const csvPath = join(outDir, csvFileName);

  const csvRows = months.map(m => ({
    model_id: modelId,
    month: m.month,
    injected_type: m.injectedType,
    injected_magnitude: m.injectedMagnitude,
    covariate_status: m.covariateStatus,
    missing_status: m.missingStatus,
    label_status: m.labelStatus,
    concept_status: m.conceptStatus,
    overall_status: m.overallStatus,
    psi: m.psi,
    top_csi: m.topCsi,
    top_csi_feature: m.topCsiFeature,
    ks_d: m.ksD,
    wasserstein: m.wasserstein,
    auc: m.auc,
    trigger_action: m.triggerAction,
    matched_rule_id: m.matchedRuleId,
    is_alarm: m.isAlarm,
  }));

  writeFileSync(
    csvPath,
    toCsv(csvRows, [
      'model_id',
      'month',
      'injected_type',
      'injected_magnitude',
      'covariate_status',
      'missing_status',
      'label_status',
      'concept_status',
      'overall_status',
      'psi',
      'top_csi',
      'top_csi_feature',
      'ks_d',
      'wasserstein',
      'auc',
      'trigger_action',
      'matched_rule_id',
      'is_alarm',
    ]),
    'utf8',
  );

  console.log(`Results written to: ${csvPath}\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

