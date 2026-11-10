/**
 * POST /api/registry/explain-validation (Step 10d.D).
 *
 * Explains a `BaselineValidationReport` in Thai (3–5 sentences).
 * Verifies with code that every number in the explanation is grounded in the report.
 * If hallucinated numbers are detected, the explanation is rejected.
 */
import { NextResponse } from 'next/server';
import { Anthropic } from '@anthropic-ai/sdk';
import { verifyNumberGrounding } from '../../../../lib/suggest/grounding';
import {
  DEFAULT_AI_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  buildAiValidationExplanationPayload,
} from '../../../../lib/suggest/ai';
import type { BaselineValidationReport } from '../../../../lib/types';

export const dynamic = 'force-dynamic';

function generateDeterministicExplanation(report: BaselineValidationReport): string {
  const c = report.computed;
  if (!c) {
    return report.ok
      ? 'การตรวจข้อมูล Reference ผ่านเรียบร้อยตามเกณฑ์ พร้อมสำหรับการเปิดใช้งาน'
      : `การตรวจข้อมูล Reference พบข้อผิดพลาด ${report.errors.length} รายการ จำเป็นต้องแก้ไขก่อนเปิดใช้งาน`;
  }

  const badRatePct =
    c.badRate !== null && c.badRate !== undefined
      ? `${(c.badRate * 100).toFixed(2)}%`
      : 'N/A';
  const perf = c.performance;
  const aucStr = perf && perf.auc ? ` และมีค่า AUC เท่ากับ ${perf.auc.toFixed(2)}` : '';
  const anomalyStr = `ระบบตรวจพบแถวที่ผิดปกติ ${c.referenceFlaggedCount} รายการ (${c.referenceFlaggedPct.toFixed(2)}%)`;

  return `ชุดข้อมูลอ้างอิงมีจำนวนทั้งหมด ${c.rowCount} แถว พบลูกหนี้ผิดนัด ${c.badCount ?? 0} ราย คิดเป็นอัตราผิดนัด ${badRatePct}${aucStr} โดย${anomalyStr} ซึ่งกระบวนการทดสอบและฟิตโมเดลใช้เวลา ${c.multivariateFitMs.toFixed(1)} มิลลิวินาที`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const report: BaselineValidationReport = body?.report;

    if (!report || typeof report !== 'object') {
      return NextResponse.json({ error: 'ต้องระบุ report (BaselineValidationReport)' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      const fallbackText = generateDeterministicExplanation(report);
      const verified = verifyNumberGrounding(fallbackText, report);
      return NextResponse.json({
        ...verified,
        explainedBy: 'rule_fallback',
      });
    }

    const client = new Anthropic({
      apiKey,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
    });
    const model = process.env.AI_MODEL || DEFAULT_AI_MODEL;

    const systemPrompt = `You are a credit risk validation expert.
Summarize the BaselineValidationReport in concise Thai (strictly 3 to 5 sentences).
CRITICAL RULE: NEVER invent or guess any numbers. Every single number, percentage, count, or metric you mention MUST be verbatim present in the provided report JSON.
If any number is not present in the report, the automated verification system will immediately reject and discard your response.`;

    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Explain this baseline validation report in 3-5 sentences:\n${JSON.stringify(buildAiValidationExplanationPayload(report), null, 2)}`,
        },
      ],
    });

    const firstBlock = response.content[0];
    const rawExplanation =
      firstBlock && firstBlock.type === 'text' ? firstBlock.text : '';

    const verified = verifyNumberGrounding(rawExplanation, report);

    return NextResponse.json({
      ...verified,
      explainedBy: verified.grounded ? 'ai' : 'rejected_ai',
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
