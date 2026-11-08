/**
 * POST /api/triggers/[eventId]/review
 *
 * Body: { decision: 'ACCEPTED' | 'DISMISSED' | 'RETRAIN_SCHEDULED' | 'RECALIBRATED', note?: string, reviewer?: string }
 * Transitions an OPEN TriggerEvent to REVIEWED. Duplicate reviews are rejected with HTTP 409.
 */
import { NextResponse } from 'next/server';
import { reviewTriggerEvent } from '../../../../../lib/storage/repositories';
import type { TriggerReviewDecision } from '../../../../../lib/types';

export const dynamic = 'force-dynamic';

const VALID_DECISIONS: TriggerReviewDecision[] = [
  'ACCEPTED',
  'DISMISSED',
  'RETRAIN_SCHEDULED',
  'RECALIBRATED',
];

export async function POST(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await context.params;
    const body = await request.json();
    const decision = body?.decision as TriggerReviewDecision;

    if (!VALID_DECISIONS.includes(decision)) {
      return NextResponse.json(
        {
          error: `decision ต้องเป็นหนึ่งใน ${VALID_DECISIONS.join(', ')}`,
        },
        { status: 400 },
      );
    }

    const note = typeof body?.note === 'string' ? body.note : '';
    const reviewer = typeof body?.reviewer === 'string' && body.reviewer.trim() ? body.reviewer.trim() : 'reviewer';

    const result = await reviewTriggerEvent(eventId, { decision, note, reviewer });
    if (result.status === 'not_found') {
      return NextResponse.json(
        { error: `ไม่พบ TriggerEvent "${eventId}"` },
        { status: 404 },
      );
    }
    if (result.status === 'already_reviewed') {
      return NextResponse.json(
        {
          error: `TriggerEvent "${eventId}" ถูกรีวิวไปแล้วเมื่อ ${result.event.review?.reviewedAt ?? ''} ห้ามรีวิวซ้ำ`,
          event: result.event,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true, event: result.event });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
