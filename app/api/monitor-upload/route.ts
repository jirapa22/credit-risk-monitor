/**
 * POST /api/monitor-upload
 *
 * รับ CSV rows จาก client, score ทุก row ด้วย WOE scorecard,
 * คำนวณ PSI/CSI/AUC/Gini/KS และส่งผลกลับไปทันที
 *
 * NOTE: Vercel serverless environment does NOT support fs.writeFileSync on
 * writable paths. All state (monitor log, psi-history) is kept in memory
 * (via global cache) and returned to the client for in-browser persistence.
 */

import { NextResponse } from 'next/server';
import { generateMockDataset, calculateAScore, scoreToPD, getBinIndex } from '../../utils/dataGenerator';
import { calculatePSI, calculateCSIWithBins, calculateAUC, calculateGini, calculateKS, calculateLift } from '../../utils/stats';

export const dynamic = 'force-dynamic';

// ── In-memory config (bundled at deploy time) ─────────────────────────────
import modelConfigJson from '../../model-config.json';

// Apply missing value strategy for a single feature value
function applyMissingStrategy(value: unknown, strategy: string, baselineDist: Record<string, number> | null): number {
  if (value !== null && value !== undefined && value !== '') return parseFloat(String(value)) || 0;
  switch (strategy) {
    case 'fillMean':    return baselineDist?.mean ?? 0;
    case 'fillMedian':  return baselineDist?.median ?? 0;
    case 'fillDefault': return 0;
    default:            return 0; // 'reject' — caller should skip row
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const customers: Record<string, unknown>[] = body.customers;
    const fileName: string = body.fileName || 'unknown.csv';

    if (!Array.isArray(customers) || customers.length === 0) {
      return NextResponse.json(
        { error: 'Invalid customer data. Expected a non-empty array.' },
        { status: 400 }
      );
    }

    // ── Config from bundled JSON ──────────────────────────────────────────
    const config = modelConfigJson as any;
    const activeId = config.activeModelId;
    const model = config.models[activeId];

    const registry: Record<string, any> = model.featureRegistry || {};
    const csiFeatures: Record<string, any> = model.thresholds?.csi_features || {};
    const scorecard: Record<string, any> = model.scoring?.scorecard || {};

    // Determine monitoring features
    const monitorFeatures: string[] = Object.entries(registry)
      .filter(([, feat]: [string, any]) => feat.monitoringEnabled !== false)
      .sort(([, a]: [string, any], [, b]: [string, any]) => (a.displayOrder || 0) - (b.displayOrder || 0))
      .map(([key]) => key)
      .filter(k => k !== 'default_flag');

    const featuresForCSI = monitorFeatures.length > 0 ? monitorFeatures : Object.keys(csiFeatures);

    // ── Validation ────────────────────────────────────────────────────────
    const validationErrors: { column: string; message: string; severity: string }[] = [];
    const skipRows = new Set<number>();

    for (const colKey of featuresForCSI) {
      const featDef = registry[colKey];
      if (!featDef) continue;

      const hasColumn = Object.prototype.hasOwnProperty.call(customers[0], colKey);
      if (!hasColumn) {
        if (featDef.required) {
          validationErrors.push({
            column: colKey,
            message: `Required column "${featDef.displayName}" is missing`,
            severity: 'error',
          });
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

    // ── 1. Score customers ────────────────────────────────────────────────
    const scoredCustomers = customers
      .map((c, index) => {
        if (skipRows.has(index)) return null;

        const featureValues: Record<string, number> = {};
        for (const feat of featuresForCSI) {
          const featDef = registry[feat];
          const strategy = featDef?.validation?.missingStrategy || 'reject';
          const baseDist = featDef?.baselineDistribution ?? null;
          featureValues[feat] = applyMissingStrategy(c[feat], strategy, baseDist);
        }

        const monthly_income = featureValues['monthly_income'] ?? parseFloat(String(c.monthly_income)) ?? 0;
        const loan_amount    = featureValues['loan_amount']    ?? parseFloat(String(c.loan_amount))    ?? 0;
        const dti_ratio      = featureValues['dti_ratio']      ?? parseFloat(String(c.dti_ratio))      ?? 0;

        const record = { monthly_income, loan_amount, dti_ratio };
        const aScore = calculateAScore(record);
        const pd     = scoreToPD(aScore);

        const bins: Record<string, number> = {};
        for (const [feat, sc] of Object.entries(scorecard)) {
          const val = featureValues[feat] ?? (record as any)[feat] ?? 0;
          bins[`${feat}_bin`] = getBinIndex(val, (sc as any).bins || []);
        }

        let defaultLabel = 0;
        if (c.default_flag !== undefined && c.default_flag !== '')
          defaultLabel = parseInt(String(c.default_flag)) === 1 ? 1 : 0;
        else if (c.defaultLabel !== undefined)
          defaultLabel = parseInt(String(c.defaultLabel)) === 1 ? 1 : 0;

        return {
          id: index + 1,
          customer_id: c.customer_id || `ROW_${index + 1}`,
          monthly_income: Math.round(monthly_income),
          loan_amount:    Math.round(loan_amount),
          dti_ratio:      Math.round(dti_ratio * 1000) / 1000,
          ...bins,
          aScore,
          pd,
          defaultLabel,
          _featureValues: featureValues,
        };
      })
      .filter(Boolean) as any[];

    if (scoredCustomers.length === 0) {
      return NextResponse.json(
        { error: 'No valid rows after validation', validationErrors, skippedRows: skipRows.size },
        { status: 422 }
      );
    }

    // ── 2. Baseline (mock, drift=0) ───────────────────────────────────────
    const baseline    = generateMockDataset(1000, 0);
    const baseScores  = baseline.map(d => d.aScore);
    const actualScores = scoredCustomers.map((d: any) => d.aScore);

    // ── 3. PSI ────────────────────────────────────────────────────────────
    const psi = calculatePSI(baseScores, actualScores);

    // ── 4. CSI per feature ────────────────────────────────────────────────
    const csi: Record<string, number> = {};
    const csiDetail: Record<string, any> = {};

    for (const feat of featuresForCSI) {
      const baseVals   = baseline.map(d => (d as any)[feat] ?? 0);
      const actualVals = scoredCustomers.map((d: any) => d._featureValues?.[feat] ?? (d as any)[feat] ?? 0);

      const featDef   = registry[feat];
      const bins: number[]       = featDef?.binning?.boundaries?.length > 0 ? featDef.binning.boundaries : (csiFeatures[feat]?.bins || []);
      const binLabels: string[]  = featDef?.binning?.binLabels?.length   > 0 ? featDef.binning.binLabels  : (csiFeatures[feat]?.bin_labels || []);
      const threshold: number    = featDef?.csiThreshold ?? csiFeatures[feat]?.threshold ?? 0.10;

      const csiValue = bins.length > 0
        ? calculateCSIWithBins(baseVals, actualVals, bins)
        : calculatePSI(baseVals, actualVals);

      csi[feat] = csiValue;

      const numBins = bins.length + 1;
      const getIdx = (v: number) => { for (let i = 0; i < bins.length; i++) if (v <= bins[i]) return i; return numBins - 1; };
      const baseCounts   = new Array(numBins).fill(0);
      const actualCounts = new Array(numBins).fill(0);
      baseVals.forEach(v => baseCounts[getIdx(v)]++);
      actualVals.forEach(v => actualCounts[getIdx(v)]++);

      csiDetail[feat] = {
        value: csiValue,
        threshold,
        displayName: featDef?.displayName || feat,
        source: featDef?.source || '',
        bins,
        bin_labels: binLabels,
        bin_distribution: baseCounts.map((bc, i) => ({
          label: binLabels[i] || `Bin ${i + 1}`,
          baseline_pct: parseFloat(((bc / baseVals.length) * 100).toFixed(2)),
          actual_pct:   parseFloat(((actualCounts[i] / actualVals.length) * 100).toFixed(2)),
        })),
      };
    }

    // ── 5. Performance metrics ────────────────────────────────────────────
    const dataPoints = scoredCustomers.map((d: any) => ({ score: d.aScore, label: d.defaultLabel }));
    const hasBadFlag = scoredCustomers.some((d: any) => d.defaultLabel === 1);
    const auc  = hasBadFlag ? calculateAUC(dataPoints)      : null;
    const gini = hasBadFlag ? calculateGini(dataPoints)     : null;
    const ks   = hasBadFlag ? calculateKS(dataPoints)       : null;
    const lift = hasBadFlag ? calculateLift(dataPoints, 0.1): null;

    // ── 6. Status ─────────────────────────────────────────────────────────
    const psiWarning  = model.thresholds?.psi_warning  ?? 0.10;
    const psiCritical = model.thresholds?.psi_critical ?? 0.25;
    const status = psi < psiWarning ? 'STABLE' : psi < psiCritical ? 'WARNING' : 'CRITICAL';

    // ── 7. Risk-grade distribution ────────────────────────────────────────
    // Map A-Score to risk grade (based on KS decile bounds from model report)
    const riskGradeDist = (() => {
      const grades = [
        { grade: 'AAA',  minScore: 586.5 },
        { grade: 'AA+',  minScore: 578 },
        { grade: 'AA',   minScore: 572 },
        { grade: 'AA-',  minScore: 565.7 },
        { grade: 'A+',   minScore: 562 },
        { grade: 'A',    minScore: 551.7 },
        { grade: 'A-',   minScore: 547.9 },
        { grade: 'BBB+', minScore: 539.5 },
        { grade: 'BBB',  minScore: 533.2 },
        { grade: 'BBB-', minScore: 0 },
      ];
      const counts: Record<string, number> = {};
      for (const g of grades) counts[g.grade] = 0;
      for (const c of scoredCustomers as any[]) {
        const grade = grades.find(g => c.aScore >= g.minScore)?.grade ?? 'BBB-';
        counts[grade] = (counts[grade] || 0) + 1;
      }
      const total = scoredCustomers.length;
      return grades.map(g => ({
        grade: g.grade,
        count: counts[g.grade] || 0,
        pct: parseFloat(((counts[g.grade] || 0) / total * 100).toFixed(1)),
      }));
    })();

    // ── 8. Log entry (returned to client) ─────────────────────────────────
    const logEntry = {
      logId: `mon_${Date.now()}`,
      modelId: activeId,
      modelName: model.name,
      configVersion: model.configVersion || '1.0.0',
      uploadedAt: new Date().toISOString(),
      fileName,
      rowCount: customers.length,
      processedRows: scoredCustomers.length,
      skippedRows: skipRows.size,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
      results: { psi, csi, auc, gini, ks, lift, status },
      verdict: status,
      notes: '',
    };

    // ── 9. Response ───────────────────────────────────────────────────────
    const cleanedCustomers = (scoredCustomers as any[]).slice(0, 100)
      .map(({ _featureValues, ...rest }: any) => rest);

    return NextResponse.json({
      psi, csi, csiDetail, auc, gini, ks, lift, status,
      logId: logEntry.logId,
      processedRows: scoredCustomers.length,
      skippedRows: skipRows.size,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
      scoredCustomers: cleanedCustomers,
      riskGradeDist,
      logEntry,
    });

  } catch (error) {
    console.error('Error POST /api/monitor-upload:', error);
    return NextResponse.json({ error: 'Internal Server Error', detail: String(error) }, { status: 500 });
  }
}
