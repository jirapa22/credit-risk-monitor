/**
 * POST /api/registry/rules/[setId]/revert
 *
 * Reverts to an earlier revision of a Rule Set (activates that revision, creates new audit log).
 */
import { NextResponse } from 'next/server';
import { revertRuleSetRevision } from '../../../../../../lib/storage/ruleSetRepository';
import {
  getDefaultModelId,
  listBaselineVersions,
} from '../../../../../../lib/storage/repositories';

export const dynamic = 'force-dynamic';

async function resolveModelAndVersion(modelIdParam?: string | null, versionParam?: string | null) {
  const modelId = modelIdParam || (await getDefaultModelId());
  let version = versionParam;
  if (!version) {
    try {
      const versions = await listBaselineVersions(modelId);
      const active = versions.find(v => v.status === 'ACTIVE');
      version = active?.version || (versions.length > 0 ? versions[versions.length - 1].version : '1.0.0');
    } catch {
      version = '1.0.0';
    }
  }
  return { modelId, version };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ setId: string }> | { setId: string } },
) {
  try {
    const resolved = await Promise.resolve(context.params);
    const setId = decodeURIComponent(resolved.setId || '');
    const body = await request.json();

    const { modelId, version } = await resolveModelAndVersion(body?.modelId, body?.version);
    const targetRevision = Number(body?.targetRevision);
    const author = String(body?.author || '').trim();
    const reason = String(body?.reason || '').trim();

    if (!Number.isFinite(targetRevision) || targetRevision < 1) {
      return NextResponse.json({ error: 'กรุณาระบุเลข Revision ที่ต้องการย้อนกลับ' }, { status: 400 });
    }
    if (!author) {
      return NextResponse.json({ error: 'กรุณาระบุชื่อผู้ย้อนกลับ (ห้ามเว้นว่าง)' }, { status: 400 });
    }
    if (!reason) {
      return NextResponse.json({ error: 'กรุณาระบุเหตุผลในการย้อนกลับ (ห้ามเว้นว่าง)' }, { status: 400 });
    }

    const result = await revertRuleSetRevision(modelId, version, setId, targetRevision, {
      author,
      reason,
    });

    return NextResponse.json({
      ok: true,
      activeRuleSet: result.activeRuleSet,
      auditEntry: result.auditEntry,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || String(error) }, { status: 400 });
  }
}

