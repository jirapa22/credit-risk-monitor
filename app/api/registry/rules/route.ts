/**
 * GET  /api/registry/rules?modelId=...&version=...
 * POST /api/registry/rules
 *
 * Lists all Rule Sets for a model version or creates a new Rule Set.
 */
import { NextResponse } from 'next/server';
import {
  listRuleSets,
  createRuleSet,
} from '../../../../lib/storage/ruleSetRepository';
import {
  getDefaultModelId,
  listBaselineVersions,
} from '../../../../lib/storage/repositories';

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

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { modelId, version } = await resolveModelAndVersion(
      searchParams.get('modelId'),
      searchParams.get('version'),
    );

    const data = await listRuleSets(modelId, version);
    return NextResponse.json({
      modelId,
      version,
      ruleSets: data.ruleSets,
      activeRuleSet: data.activeRuleSet,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { modelId, version } = await resolveModelAndVersion(body?.modelId, body?.version);

    const name = String(body?.name || '').trim();
    const description = String(body?.description || '').trim();
    const author = String(body?.author || '').trim();
    const reason = String(body?.reason || '').trim();
    const templateId = body?.templateId;
    const config = body?.config;

    if (!name) {
      return NextResponse.json({ error: 'กรุณาระบุชื่อชุดกฎ' }, { status: 400 });
    }
    if (!author) {
      return NextResponse.json({ error: 'กรุณาระบุชื่อผู้สร้างชุดกฎ (ห้ามเว้นว่าง)' }, { status: 400 });
    }
    if (!reason) {
      return NextResponse.json({ error: 'กรุณาระบุเหตุผลในการสร้างชุดกฎ (ห้ามเว้นว่าง)' }, { status: 400 });
    }
    if (!config || typeof config !== 'object') {
      return NextResponse.json({ error: 'กรุณาระบุการตั้งค่าเกณฑ์ของชุดกฎ (config)' }, { status: 400 });
    }

    const created = await createRuleSet(modelId, version, {
      name,
      description,
      config,
      templateId,
      author,
      reason,
    });

    return NextResponse.json({ ok: true, ruleSet: created }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || String(error) }, { status: 400 });
  }
}
