/**
 * POST /api/registry/rules/simulate
 *
 * Dry-runs candidate RuleSetConfig against historical runs stored for the model version.
 * Evaluates triggers purely in-memory from stored metrics without recomputing raw data or persisting anything.
 */
import { NextResponse } from 'next/server';
import {
  simulateRuleSetOnPastRuns,
  validateRuleSetConfig,
  type SimulationItemResult,
} from '../../../../../lib/storage/ruleSetRepository';
import {
  getDefaultModelId,
  getEffectiveModel,
  listBaselineVersions,
  listRuns,
} from '../../../../../lib/storage/repositories';
import type { MonitoringRun } from '../../../../../lib/types';

export const dynamic = 'force-dynamic';

async function resolveModelAndVersion(modelIdParam?: string | null, versionParam?: string | null) {
  const modelId = modelIdParam || (await getDefaultModelId());
  let version = versionParam;
  if (!version) {
    try {
      const versions = await listBaselineVersions(modelId);
      const active = versions.find((v: any) => v.status === 'ACTIVE');
      version = active?.version || (versions.length > 0 ? versions[versions.length - 1].version : '1.0.0');
    } catch {
      version = '1.0.0';
    }
  }
  return { modelId, version };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { modelId, version } = await resolveModelAndVersion(body?.modelId, body?.version);
    const config = body?.config;

    const errors = validateRuleSetConfig(config);
    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join('; ') }, { status: 400 });
    }

    const model = await getEffectiveModel(modelId);
    const runs = await listRuns<MonitoringRun>('monitoring', modelId, {
      configVersion: version,
    });

    if (!runs || runs.length === 0) {
      return NextResponse.json({
        modelId,
        version,
        message: 'ไม่พบประวัติการประมวลผลสำหรับโมเดลนี้ที่จะนำมาจำลอง',
        simulation: [],
      });
    }

    const results = simulateRuleSetOnPastRuns(config, runs, model);

    return NextResponse.json({
      modelId,
      version,
      totalRuns: runs.length,
      changedCount: results.filter((r: SimulationItemResult) => r.changed).length,
      simulation: results,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || String(error) }, { status: 400 });
  }
}
