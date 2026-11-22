/**
 * POST /api/registry/rules/[setId]/revisions
 *
 * Adds a new immutable revision to a Rule Set.
 */
import { NextResponse } from 'next/server';
import { addRuleSetRevision } from '../../../../../../lib/storage/ruleSetRepository';
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
    const author = String(body?.author || '').trim();
    const reason = String(body?.reason || '').trim();
    const config = body?.config;

    if (!author) {
      return NextResponse.json({ error: 'กรุณาระบุชื่อผู้แก้ไข (ห้ามเว้นว่าง)' }, { status: 400 });
    }
    if (!reason) {
      return NextResponse.json({ error: 'กรุณาระบุเหตุผลในการแก้ไข (ห้ามเว้นว่าง)' }, { status: 400 });
    }
    if (!config || typeof config !== 'object') {
      return NextResponse.json({ error: 'กรุณาระบุการตั้งค่าเกณฑ์ของชุดกฎ (config)' }, { status: 400 });
    }

    const result = await addRuleSetRevision(modelId, version, setId, {
      config,
      author,
      reason,
    });

    return NextResponse.json({
      ok: true,
      ruleSet: result.ruleSet,
      newRevision: result.newRevision,
      auditEntry: result.auditEntry,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || String(error) }, { status: 400 });
  }
}

