/**
 * POST /api/registry/rules/[setId]/activate
 *
 * Activates a specific revision of a Rule Set.
 */
import { NextResponse } from 'next/server';
import { activateRuleSetRevision } from '../../../../../../lib/storage/ruleSetRepository';
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
    const revision = Number(body?.revision);
    const author = String(body?.author || '').trim();
    const reason = String(body?.reason || '').trim();

    if (!Number.isFinite(revision) || revision < 1) {
      return NextResponse.json({ error: 'กรุณาระบุเลข Revision ที่ถูกต้อง' }, { status: 400 });
    }
    if (!author) {
      return NextResponse.json({ error: 'กรุณาระบุชื่อผู้เปิดใช้งาน (ห้ามเว้นว่าง)' }, { status: 400 });
    }
    if (!reason) {
      return NextResponse.json({ error: 'กรุณาระบุเหตุผลในการเปิดใช้งาน (ห้ามเว้นว่าง)' }, { status: 400 });
    }

    const result = await activateRuleSetRevision(modelId, version, setId, revision, {
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

