import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { generateMockDataset } from '../../utils/dataGenerator';
import { calculatePSI, calculateCSIWithBins, calculateAUC, calculateGini, calculateKS, calculateLift } from '../../utils/stats';

export const dynamic = 'force-dynamic';

const historyPath = path.join(process.cwd(), 'psi-history.json');
const configPath = path.join(process.cwd(), 'app', 'model-config.json');

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function getStatus(psi: number, warningThreshold = 0.10, criticalThreshold = 0.25): string {
  if (psi < warningThreshold) return 'STABLE';
  if (psi < criticalThreshold) return 'WARNING';
  return 'CRITICAL';
}

function calculateAllMetrics(driftLevel: number) {
  const config = readConfig();
  const activeId = config.activeModelId;
  const model = config.models[activeId];
  const csiFeatures = model.thresholds?.csi_features || {};

  // Generate baseline (drift=0) and production (drift=driftLevel) datasets
  const baseline = generateMockDataset(1000, 0);
  const production = generateMockDataset(1000, driftLevel);

  const baseScores = baseline.map(d => d.aScore);
  const actualScores = production.map(d => d.aScore);

  // PSI on score distribution
  const psi = calculatePSI(baseScores, actualScores);

  // CSI per feature using scorecard bins
  const csi: Record<string, number> = {};
  const features = ['monthly_income', 'loan_amount', 'dti_ratio'];
  for (const feat of features) {
    const baseVals = baseline.map(d => (d as any)[feat] ?? 0);
    const actualVals = production.map(d => (d as any)[feat] ?? 0);
    const bins = csiFeatures[feat]?.bins || [];
    csi[feat] = bins.length > 0
      ? calculateCSIWithBins(baseVals, actualVals, bins)
      : calculatePSI(baseVals, actualVals);
  }

  // Performance metrics (AUC/Gini/KS/Lift)
  const dataPoints = production.map(d => ({ score: d.aScore, label: d.defaultLabel }));
  const auc = calculateAUC(dataPoints);
  const gini = calculateGini(dataPoints);
  const ks = calculateKS(dataPoints);
  const lift = calculateLift(dataPoints, 0.1);

  return {
    psi, csi, auc, gini, ks, lift,
    status: getStatus(psi, model.thresholds?.psi_warning, model.thresholds?.psi_critical),
    drift: driftLevel,
  };
}

function initializeHistory() {
  if (!fs.existsSync(historyPath)) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
    const drifts = [0.02, 0.05, 0.04, 0.08, 0.12, 0.15];
    const history = months.map((month, i) => ({
      month,
      timestamp: new Date(2026, i, 15).toISOString(),
      source: 'simulation',
      ...calculateAllMetrics(drifts[i]),
    }));
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  }
}

export async function GET(request: Request) {
  try {
    initializeHistory();
    const { searchParams } = new URL(request.url);
    const driftStr = searchParams.get('drift');

    if (driftStr !== null) {
      const driftLevel = parseFloat(driftStr) || 0;
      return NextResponse.json(calculateAllMetrics(driftLevel));
    }

    const fileContent = fs.readFileSync(historyPath, 'utf8');
    const history = JSON.parse(fileContent);
    const latest = history.length > 0 ? history[history.length - 1] : calculateAllMetrics(0);
    return NextResponse.json(latest);
  } catch (error) {
    console.error('Error GET /api/risk-score:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    initializeHistory();
    const body = await request.json().catch(() => ({}));

    const fileContent = fs.readFileSync(historyPath, 'utf8');
    const history = JSON.parse(fileContent);

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const nextMonthIdx = history.length % 12;

    let newEntry: any;
    if (body.customMetrics) {
      newEntry = {
        month: body.month || months[nextMonthIdx],
        timestamp: new Date().toISOString(),
        source: body.source || 'upload',
        fileName: body.fileName || '',
        rowCount: body.rowCount || 0,
        ...body.customMetrics,
      };
    } else {
      const driftLevel = typeof body.drift === 'number' ? body.drift : 0;
      newEntry = {
        month: body.month || months[nextMonthIdx],
        timestamp: new Date().toISOString(),
        source: 'simulation',
        ...calculateAllMetrics(driftLevel),
      };
    }

    history.push(newEntry);
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    return NextResponse.json(newEntry);
  } catch (error) {
    console.error('Error POST /api/risk-score:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}