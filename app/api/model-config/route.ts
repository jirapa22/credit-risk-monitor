/**
 * GET  /api/model-config  → effective config (bundled + stored overrides)
 * POST /api/model-config  → { thresholds, note } — same as /api/save-model-config
 *
 * Scorecard / featureRegistry / reference changes are NOT editable at runtime:
 * they define a new model version and must be committed to app/model-config.json
 * (with a new configVersion or model id) so that past results stay reproducible.
 */
import { NextResponse } from 'next/server';
import { getDefaultModelId, getEffectiveConfig, getEffectiveModel, saveThresholds, storageInfo } from '../../../lib/storage/repositories';
import { parseThresholds } from '../../../lib/thresholds';

export const dynamic = 'force-dynamic';

export async function GET(request?: Request) {
  try {
    const modelIdParam = request ? new URL(request.url).searchParams.get('modelId') : null;
    const config = await getEffectiveConfig();
    const activeModelId = modelIdParam || config.activeModelId;
    const model = config.models[activeModelId] ?? (await getEffectiveModel(activeModelId));
    return NextResponse.json({ config, model, activeModelId, storage: storageInfo() });
  } catch (error) {
    console.error('GET /api/model-config error:', error);
    return NextResponse.json({ error: 'Failed to read config' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const body = await request.json();
    if (body.featureRegistry || body.scoring) {
      return NextResponse.json({
        error: 'แก้ไข featureRegistry/scorecard ผ่าน API ไม่ได้ — ให้สร้างเวอร์ชันใหม่ใน Baseline Registry เพื่อให้ผลย้อนหลังตรวจสอบซ้ำได้',
      }, { status: 400 });
    }
    const modelId = url.searchParams.get('modelId') || body.modelId || (await getDefaultModelId());
    const current = await getEffectiveModel(modelId);
    const { value, errors } = parseThresholds(body.thresholds ?? {}, current.thresholds);
    if (!value) return NextResponse.json({ error: 'ค่า Threshold ไม่ถูกต้อง', errors }, { status: 400 });
    await saveThresholds(modelId, value, body.note);
    return NextResponse.json({ success: true, model: await getEffectiveModel(modelId), storage: storageInfo() });
  } catch (error) {
    console.error('POST /api/model-config error:', error);
    return NextResponse.json({ error: 'Failed to update config' }, { status: 500 });
  }
}
