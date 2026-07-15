import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { generateMockDataset, calculateAScore, scoreToPD, getBinIndex } from '../../utils/dataGenerator';
import { calculatePSI, calculateCSIWithBins, calculateAUC, calculateGini, calculateKS, calculateLift } from '../../utils/stats';

export const dynamic = 'force-dynamic';

const configPath = path.join(process.cwd(), 'app', 'model-config.json');
const monitorLogPath = path.join(process.cwd(), 'monitor-log.json');
const historyPath = path.join(process.cwd(), 'psi-history.json');

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function readMonitorLog(): any[] {
  if (!fs.existsSync(monitorLogPath)) return [];
  try { return JSON.parse(fs.readFileSync(monitorLogPath, 'utf8')); }
  catch { return []; }
}

// Apply missing value strategy for a single feature value
function applyMissingStrategy(value: any, strategy: string, baselineDist: any): number {
  if (value !== null && value !== undefined && value !== '') return parseFloat(String(value)) || 0;
  switch (strategy) {
    case 'fillMean':   return baselineDist?.mean ?? 0;
    case 'fillMedian': return baselineDist?.median ?? 0;
    case 'fillDefault': return 0;
    default: return 0; // 'reject' — caller should skip row
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const customers: any[] = body.customers;

    if (!Array.isArray(customers) || customers.length === 0) {
      return NextResponse.json({ error: 'Invalid customer data. Expected a non-empty array.' }, { status: 400 });
    }

    const config = readConfig();
    const activeId = config.activeModelId;
    const model = config.models[activeId];

    // ── Read feature definitions from featureRegistry (primary) with fallback to csi_features ──
    const registry = model.featureRegistry || {};
    const csiFeatures = model.thresholds?.csi_features || {};
    const scorecard = model.scoring?.scorecard || {};

    // Determine monitoring features (monitoringEnabled = true in registry, or listed in csi_features)
    const monitorFeatures: string[] = Object.entries(registry)
      .filter(([, feat]: [string, any]) => feat.monitoringEnabled !== false)
      .sort(([, a]: [string, any], [, b]: [string, any]) => (a.displayOrder || 0) - (b.displayOrder || 0))
      .map(([key]) => key)
      .filter(k => k !== 'default_flag');

    // If registry is empty, fall back to csi_features keys
    const featuresForCSI = monitorFeatures.length > 0 ? monitorFeatures : Object.keys(csiFeatures);

    // ── Run dataset validation inline (no HTTP call to avoid circular) ──
    const validationErrors: { column: string; message: string; severity: string }[] = [];
    let skipRows = new Set<number>();

    for (const colKey of featuresForCSI) {
      const featDef = registry[colKey];
      if (!featDef) continue;

      const hasColumn = Object.prototype.hasOwnProperty.call(customers[0], colKey);
      if (!hasColumn) {
        if (featDef.required) {
          validationErrors.push({ column: colKey, message: `Required column "${featDef.displayName}" is missing`, severity: 'error' });
        }
        continue;
      }

      const strategy = featDef.validation?.missingStrategy || 'reject';
      if (strategy === 'reject') {
        customers.forEach((c, i) => {
          const v = c[colKey];
          if (v === null || v === undefined || v === '') skipRows.add(i);
        });
      }
    }

    // ── 1. Score uploaded customers (respecting missing value strategy) ──
    const scoredCustomers = customers
      .map((c: any, index: number) => {
        if (skipRows.has(index)) return null;

        // Apply missing value strategy per feature
        const featureValues: Record<string, number> = {};
        for (const feat of featuresForCSI) {
          const featDef = registry[feat];
          const strategy = featDef?.validation?.missingStrategy || 'reject';
          const baseDist = featDef?.baselineDistribution;
          featureValues[feat] = applyMissingStrategy(c[feat], strategy, baseDist);
        }

        // Keep required scorecard features
        const monthly_income = featureValues['monthly_income'] ?? parseFloat(c.monthly_income) ?? 0;
        const loan_amount = featureValues['loan_amount'] ?? parseFloat(c.loan_amount) ?? 0;
        const dti_ratio = featureValues['dti_ratio'] ?? parseFloat(c.dti_ratio) ?? 0;

        const record = { monthly_income, loan_amount, dti_ratio };
        const aScore = calculateAScore(record);
        const pd = scoreToPD(aScore);

        // Bin assignments for each scorecard feature
        const bins: Record<string, number> = {};
        for (const [feat, sc] of Object.entries(scorecard)) {
          const val = (featureValues[feat] ?? record[feat as keyof typeof record]) ?? 0;
          bins[`${feat}_bin`] = getBinIndex(val, (sc as any).bins || []);
        }

        let defaultLabel = 0;
        if (c.default_flag !== undefined && c.default_flag !== '') defaultLabel = parseInt(c.default_flag) === 1 ? 1 : 0;
        else if (c.defaultLabel !== undefined) defaultLabel = parseInt(c.defaultLabel) === 1 ? 1 : 0;

        return {
          id: index + 1,
          customer_id: c.customer_id || `ROW_${index + 1}`,
          monthly_income: Math.round(monthly_income),
          loan_amount: Math.round(loan_amount),
          dti_ratio: Math.round(dti_ratio * 1000) / 1000,
          ...bins,
          aScore,
          pd,
          defaultLabel,
          _featureValues: featureValues,
        };
      })
      .filter(Boolean) as any[];

    if (scoredCustomers.length === 0) {
      return NextResponse.json({
        error: 'No valid rows after validation',
        validationErrors,
        skippedRows: skipRows.size,
      }, { status: 422 });
    }

    // ── 2. Generate baseline (1000 samples, drift=0) ──
    const baseline = generateMockDataset(1000, 0);
    const baseScores = baseline.map(d => d.aScore);
    const actualScores = scoredCustomers.map(d => d.aScore);

    // ── 3. PSI on score ──
    const psi = calculatePSI(baseScores, actualScores);

    // ── 4. CSI per feature using featureRegistry bins (fallback to csi_features) ──
    const csi: Record<string, number> = {};
    const csiDetail: Record<string, any> = {};

    for (const feat of featuresForCSI) {
      const baseVals = baseline.map(d => (d as any)[feat] ?? 0);
      const actualVals = scoredCustomers.map(d => d._featureValues?.[feat] ?? (d as any)[feat] ?? 0);

      // Prefer featureRegistry binning, fallback to csi_features
      const featDef = registry[feat];
      const bins: number[] = featDef?.binning?.boundaries?.length > 0
        ? featDef.binning.boundaries
        : (csiFeatures[feat]?.bins || []);
      const binLabels: string[] = featDef?.binning?.binLabels?.length > 0
        ? featDef.binning.binLabels
        : (csiFeatures[feat]?.bin_labels || []);
      const threshold = featDef?.csiThreshold ?? csiFeatures[feat]?.threshold ?? 0.10;

      const csiValue = bins.length > 0
        ? calculateCSIWithBins(baseVals, actualVals, bins)
        : calculatePSI(baseVals, actualVals);

      csi[feat] = csiValue;

      // Bin distribution
      const numBins = bins.length + 1;
      const getIdx = (v: number) => {
        for (let i = 0; i < bins.length; i++) if (v <= bins[i]) return i;
        return numBins - 1;
      };
      const baseCounts = new Array(numBins).fill(0);
      const actualCounts = new Array(numBins).fill(0);
      baseVals.forEach(v => baseCounts[getIdx(v)]++);
      actualVals.forEach(v => actualCounts[getIdx(v)]++);

      const bin_distribution = baseCounts.map((bc, i) => ({
        label: binLabels[i] || `Bin ${i + 1}`,
        baseline_pct: parseFloat(((bc / baseVals.length) * 100).toFixed(2)),
        actual_pct: parseFloat(((actualCounts[i] / actualVals.length) * 100).toFixed(2)),
      }));

      csiDetail[feat] = {
        value: csiValue,
        threshold,
        displayName: featDef?.displayName || feat,
        source: featDef?.source || '',
        bins,
        bin_labels: binLabels,
        bin_distribution,
      };
    }

    // ── 5. Performance metrics (requires default_flag) ──
    const dataPoints = scoredCustomers.map(d => ({ score: d.aScore, label: d.defaultLabel }));
    const hasBadFlag = scoredCustomers.some(d => d.defaultLabel === 1);
    const auc = hasBadFlag ? calculateAUC(dataPoints) : null;
    const gini = hasBadFlag ? calculateGini(dataPoints) : null;
    const ks = hasBadFlag ? calculateKS(dataPoints) : null;
    const lift = hasBadFlag ? calculateLift(dataPoints, 0.1) : null;

    // ── 6. Determine status ──
    const psiWarning = model.thresholds?.psi_warning ?? 0.10;
    const psiCritical = model.thresholds?.psi_critical ?? 0.25;
    const status = psi < psiWarning ? 'STABLE' : psi < psiCritical ? 'WARNING' : 'CRITICAL';

    // ── 7. Save to monitor log ──
    const logEntry = {
      logId: `mon_${Date.now()}`,
      modelId: activeId,
      modelName: model.name,
      configVersion: model.configVersion || '1.0.0',
      uploadedAt: new Date().toISOString(),
      fileName: body.fileName || 'unknown.csv',
      rowCount: customers.length,
      processedRows: scoredCustomers.length,
      skippedRows: skipRows.size,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
      results: { psi, csi, auc, gini, ks, lift, status },
      verdict: status,
      notes: '',
    };

    const log = readMonitorLog();
    log.push(logEntry);
    fs.writeFileSync(monitorLogPath, JSON.stringify(log, null, 2));

    // ── 8. Append to psi-history ──
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const now = new Date();
    try {
      const history = fs.existsSync(historyPath)
        ? JSON.parse(fs.readFileSync(historyPath, 'utf8'))
        : [];
      history.push({
        month: months[now.getMonth()],
        timestamp: now.toISOString(),
        source: 'upload',
        fileName: body.fileName || '',
        rowCount: scoredCustomers.length,
        psi, csi, auc, gini, ks, lift, status,
      });
      fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    } catch (_) {}

    // ── 9. Cleanup _featureValues from response ──
    const cleanedCustomers = scoredCustomers.slice(0, 100).map(({ _featureValues, ...rest }: any) => rest);

    return NextResponse.json({
      psi, csi, csiDetail, auc, gini, ks, lift, status,
      logId: logEntry.logId,
      processedRows: scoredCustomers.length,
      skippedRows: skipRows.size,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
      scoredCustomers: cleanedCustomers,
    });
  } catch (error) {
    console.error('Error POST /api/monitor-upload:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
