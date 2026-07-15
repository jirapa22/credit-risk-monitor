/**
 * POST /api/risk-score
 *
 * Accepts: { customerData: { monthly_income, loan_amount, dti_ratio } }
 *
 * Returns: { status, score, pd, sumPoints, breakdown, psi }
 *
 * Scoring method: WOE additive scorecard
 *   1. For each feature, find the bin that the applicant's value falls into.
 *   2. Sum the points from each bin  → sumPoints
 *   3. Total score  = offset + sumPoints          (offset = 487.123)
 *   4. odds         = baseOdds × 2^((score − baseScore) / PDO)
 *   5. PD           = 1 / (1 + odds)
 *
 * CSV upload schema (monitoring data):
 *   REQUIRED: monthly_income, loan_amount, dti_ratio, default_flag
 *   EXCLUDED (data leakage): credit_score, risk_grade, interest_rate_pct,
 *                             current_dpd, outstanding_balance
 */

import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { features, scorecardParams, findBin } from '../../config/model';

export async function POST(request: Request) {
  try {
    const { customerData } = await request.json() as {
      customerData: {
        monthly_income: number;
        loan_amount: number;
        dti_ratio: number;
      };
    };

    const { monthly_income, loan_amount, dti_ratio } = customerData;

    // ── 1. Resolve features ──────────────────────────────────────────────
    const feat001 = features.find((f) => f.columnName === 'monthly_income');
    const feat002 = features.find((f) => f.columnName === 'loan_amount');
    const feat003 = features.find((f) => f.columnName === 'dti_ratio');

    if (!feat001 || !feat002 || !feat003) {
      return NextResponse.json(
        { status: 'error', message: 'Feature config not found' },
        { status: 500 }
      );
    }

    // ── 2. Find bins and extract points ──────────────────────────────────
    const bin001 = findBin(feat001, monthly_income);
    const bin002 = findBin(feat002, loan_amount);
    const bin003 = findBin(feat003, dti_ratio);

    const sumPoints = bin001.points + bin002.points + bin003.points;

    // ── 3. Compute score ─────────────────────────────────────────────────
    // Score = offset + sumPoints
    // Derivation: score = baseScore + Σ(factor × βj × WOE_ij)
    //             where bin_points_ij = factor × βj × WOE_ij (pre-computed)
    //             and offset = baseScore - factor × ln(baseOdds) absorbs the
    //             intercept when applied to an additive scorecard
    const score = scorecardParams.offset + sumPoints;

    // ── 4. Score → PD ────────────────────────────────────────────────────
    // Standard scorecard: odds = baseOdds × 2^((score − baseScore) / PDO)
    // Higher score → better odds → lower PD
    const oddsGoodToBad =
      scorecardParams.baseOdds *
      Math.pow(2, (score - scorecardParams.baseScore) / scorecardParams.pdo);
    const pd = 1 / (1 + oddsGoodToBad);

    // ── 5. Estimate PSI from score deviation ─────────────────────────────
    // Production PSI should be computed from a batch (score distribution),
    // not a single observation. This is a simplified single-record proxy:
    //   portfolio average score ≈ 554 (from model report base_points)
    const portfolioAvgScore = 554.2;
    const relativeDeviation = Math.abs(score - portfolioAvgScore) / 100;
    const newPsi = Math.min(relativeDeviation * 0.4, 0.5);

    // ── 6. Persist PSI to history file ───────────────────────────────────
    const historyPath = path.join(process.cwd(), 'psi-history.json');
    fs.writeFileSync(historyPath, JSON.stringify({ psi: newPsi }));

    // ── 7. Return result ─────────────────────────────────────────────────
    return NextResponse.json({
      status: 'ok',
      score: Math.round(score * 10) / 10,
      pd: Math.round(pd * 10000) / 10000,       // 4 decimal places
      sumPoints: Math.round(sumPoints * 10) / 10,
      psi: Math.round(newPsi * 10000) / 10000,
      breakdown: {
        monthly_income: {
          value: monthly_income,
          bin: bin001.binLabel,
          woe: bin001.woe,
          points: bin001.points,
        },
        loan_amount: {
          value: loan_amount,
          bin: bin002.binLabel,
          woe: bin002.woe,
          points: bin002.points,
        },
        dti_ratio: {
          value: dti_ratio,
          bin: bin003.binLabel,
          woe: bin003.woe,
          points: bin003.points,
        },
      },
    });
  } catch (err) {
    console.error('[risk-score] error:', err);
    return NextResponse.json(
      { status: 'error', message: 'Invalid request body' },
      { status: 400 }
    );
  }
}