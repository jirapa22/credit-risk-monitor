/**
 * GET /api/registry/rules/audit?modelId=...&version=...
 *
 * Returns audit log entries for Rule Sets of a model version.
 */
import { NextResponse } from 'next/server';
import { listRuleSetAuditLogs } from '../../../../../lib/storage/ruleSetRepository';
import {
  getDefaultModelId,
  listBaselineVersions,
} from '../../../../../lib/storage/repositories';

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

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { modelId, version } = await resolveModelAndVersion(
      searchParams.get('modelId'),
      searchParams.get('version'),
    );

    const logs = await listRuleSetAuditLogs(modelId, version);
    return NextResponse.json({
      modelId,
      version,
      auditLogs: logs,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
