/**
 * GET  /api/risk-score?drift=0.05   → live simulation metrics
 * POST /api/risk-score               → append to client-side history
 *
 * Fully stateless — no filesystem writes on Vercel.
 */
import { NextResponse } from 'next/server';
import { generateMockDataset } from '../../utils/dataGenerator';
import { calculatePSI, calculateCSIWithBins, calculateAUC, calculateGini, calculateKS, calculateLift } from '../../utils/stats';
import modelConfigJson from '../../model-config.json';

export const dynamic = 'force-dynamic';

const config = modelConfigJson as any;

function getStatus(psi: number, warn = 0.10, crit = 0.25): string {
  if (psi < warn) return 'STABLE';
  if (psi < crit) return 'WARNING';
  return 'CRITICAL';
}

function calculateAllMetrics(driftLevel: number) {
  const activeId = config.activeModelId;
  const model = config.models[activeId];
  const csiFeatures = model.thresholds?.csi_features || {};

  const baseline   = generateMockDataset(1000, 0);
  const production = generateMockDataset(1000, driftLevel);

  const baseScores   = baseline.map(d => d.aScore);
  const actualScores = production.map(d => d.aScore);

  const psi = calculatePSI(baseScores, actualScores);

  const csi: Record<string, number> = {};
  const features = ['monthly_income', 'loan_amount', 'dti_ratio'];
  for (const feat of features) {
    const baseVals   = baseline.map(d => (d as any)[feat] ?? 0);
    const actualVals = production.map(d => (d as any)[feat] ?? 0);
    const bins = csiFeatures[feat]?.bins || [];
    csi[feat] = bins.length > 0
      ? calculateCSIWithBins(baseVals, actualVals, bins)
      : calculatePSI(baseVals, actualVals);
  }

  const dataPoints = production.map(d => ({ score: d.aScore, label: d.defaultLabel }));
  const auc  = calculateAUC(dataPoints);
  const gini = calculateGini(dataPoints);
  const ks   = calculateKS(dataPoints);
  const lift = calculateLift(dataPoints, 0.1);

  return {
    psi, csi, auc, gini, ks, lift,
    status: getStatus(psi, model.thresholds?.psi_warning, model.thresholds?.psi_critical),
    drift: driftLevel,
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const driftStr = searchParams.get('drift');
    const driftLevel = driftStr !== null ? parseFloat(driftStr) || 0 : 0;
    return NextResponse.json(calculateAllMetrics(driftLevel));
  } catch (error) {
    console.error('Error GET /api/risk-score:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const driftLevel = typeof body.drift === 'number' ? body.drift : 0;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const now = new Date();
    const entry = {
      month: body.month || months[now.getMonth()],
      timestamp: now.toISOString(),
      source: 'simulation',
      ...calculateAllMetrics(driftLevel),
    };
    return NextResponse.json(entry);
  } catch (error) {
    console.error('Error POST /api/risk-score:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}