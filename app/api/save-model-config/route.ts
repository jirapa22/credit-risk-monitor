/**
 * POST /api/save-model-config
 * Body: { thresholds: { psi_warning, psi_critical, gini_min, auc_min, ks_min, csi_features }, note? }
 *
 * Saves threshold overrides to persistent storage (Upstash Redis on Vercel,
 * .data/store.json locally) — never writes app/model-config.json.
 * Each save bumps configVersion so monitoring runs stay separable.
 */
import { NextResponse } from 'next/server';
import { getActiveModelId, getEffectiveModel, saveThresholds, storageInfo } from '@/lib/storage/repositories';
import { parseThresholds } from '@/lib/thresholds';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const modelId = body.modelId || getActiveModelId();
    const current = await getEffectiveModel(modelId);
    const { value, errors } = parseThresholds(body.thresholds ?? {}, current.thresholds);
    if (!value) return NextResponse.json({ error: 'ค่า Threshold ไม่ถูกต้อง', errors }, { status: 400 });

    const ov = await saveThresholds(modelId, value, body.note);
    const storage = storageInfo();
    return NextResponse.json({
      success: true,
      configVersion: ov.configVersion,
      model: await getEffectiveModel(modelId),
      storage,
      warning: storage.persistent ? undefined : 'ยังไม่ได้ตั้งค่าฐานข้อมูล (KV_REST_API_URL/TOKEN) — ค่าจะหายเมื่อ server restart',
    });
  } catch (error) {
    console.error('Error POST /api/save-model-config:', error);
    return NextResponse.json({ error: 'บันทึกไม่สำเร็จ', detail: String(error) }, { status: 500 });
  }
}
