/**
 * Calculation of Pool Statistics (Count, Share, Bad Count, Bad Rate, WOE, IV)
 * and Development Stability (Train vs Test/OOT PSI/CSI split by date).
 */
import { calculateCSIWithBins, calculatePSI, getBinIndex } from './stats';
import type { FeatureDefinition, ModelTableDefinition, ModelTableRow } from './types';

export interface PoolStatRow {
  pool_id: string;
  variable: string;
  type?: 'numeric' | 'categorical';
  lower?: number | null;
  upper?: number | null;
  categories?: string | string[] | null;
  points: number;
  count: number;
  share: number;
  badCount: number;
  badRate: number;
  woe: number;
  iv: number;
}

export interface FeatureIvSummary {
  iv: number;
  numBins: number;
  strength: 'Strong (แข็งแรง)' | 'Medium (ปานกลาง)' | 'Weak (อ่อน)' | 'Negligible (ไม่มีนัยสำคัญ)';
  usedInModel: boolean;
}

export interface ModelTablePoolStatsResult {
  source: string;
  totalIV: number;
  features: Record<string, { iv: number; rows: PoolStatRow[] }>;
  ivSummary: Record<string, FeatureIvSummary>;
  enrichedRows: PoolStatRow[];
}

export interface DevelopmentStabilityResult {
  available: boolean;
  reason?: string;
  source: string;
  trainRatio?: number;
  trainCount?: number;
  testCount?: number;
  trainPeriod?: string;
  testPeriod?: string;
  scorePsi?: number | null;
  featureCsi?: Record<string, number>;
}

function classifyIvStrength(iv: number): 'Strong (แข็งแรง)' | 'Medium (ปานกลาง)' | 'Weak (อ่อน)' | 'Negligible (ไม่มีนัยสำคัญ)' {
  if (iv >= 0.30) return 'Strong (แข็งแรง)';
  if (iv >= 0.10) return 'Medium (ปานกลาง)';
  if (iv >= 0.02) return 'Weak (อ่อน)';
  return 'Negligible (ไม่มีนัยสำคัญ)';
}

/**
 * Computes pool statistics (count, bad count, bad rate, WOE, IV) from reference dataset rows and model table definitions.
 * Uses Laplace/Haldane smoothing (adding 0.5 to zero counts) to prevent division by zero or log(0).
 */
export function computeModelTablePoolStats(options: {
  modelTable: ModelTableDefinition;
  referenceRows: Record<string, unknown>[];
  labelColumn: string;
  featureRegistry?: Record<string, FeatureDefinition>;
}): ModelTablePoolStatsResult {
  const { modelTable, referenceRows, labelColumn, featureRegistry } = options;
  const rows = modelTable.rows || [];
  const refRows = referenceRows || [];

  if (refRows.length === 0 || rows.length === 0) {
    return {
      source: 'ไม่มีข้อมูล Baseline',
      totalIV: 0,
      features: {},
      ivSummary: {},
      enrichedRows: rows.map((r: any) => ({
        ...r,
        count: 0,
        share: 0,
        badCount: 0,
        badRate: 0,
        woe: 0,
        iv: 0,
      })),
    };
  }

  // Calculate overall totals
  let totalBads = 0;
  for (const r of refRows) {
    const rawVal = r[labelColumn];
    const num = Number(rawVal);
    if (num === 1 || rawVal === true || rawVal === '1') {
      totalBads++;
    }
  }
  const totalRows = refRows.length;
  const totalGoods = totalRows - totalBads;

  // Group pools by variable
  const groupedByVar = new Map<string, ModelTableRow[]>();
  for (const r of rows) {
    if (!r.variable || r.variable === 'base_points') continue;
    if (!groupedByVar.has(r.variable)) groupedByVar.set(r.variable, []);
    groupedByVar.get(r.variable)!.push(r);
  }

  const enrichedRows: PoolStatRow[] = [];
  const featuresResult: Record<string, { iv: number; rows: PoolStatRow[] }> = {};
  const ivSummary: Record<string, FeatureIvSummary> = {};
  let modelTotalIV = 0;

  for (const [varName, pRows] of groupedByVar.entries()) {
    const featDef = featureRegistry?.[varName];
    const isCat = pRows.some(p => p.categories && p.categories.length > 0) || featDef?.dataType === 'categorical';

    const pCounts = new Array(pRows.length).fill(0);
    const pBads = new Array(pRows.length).fill(0);

    // Prepare matching boundaries or category sets
    let upperBounds: number[] = [];
    if (!isCat) {
      upperBounds = pRows.map(p => (typeof p.upper === 'number' ? p.upper : Infinity));
    }

    // Tally reference rows
    for (const r of refRows) {
      let matchedIdx = -1;
      const isBad = Number(r[labelColumn]) === 1 || r[labelColumn] === true || r[labelColumn] === '1';

      if (isCat) {
        const valStr = String(r[varName] ?? '').trim();
        matchedIdx = pRows.findIndex(p => {
          if (!p.categories) return false;
          if (Array.isArray(p.categories)) {
            return p.categories.some(c => String(c).trim() === valStr);
          }
          return String(p.categories).trim() === valStr;
        });
        if (matchedIdx < 0) {
          // Check pool_id match or fall back to last pool
          matchedIdx = pRows.findIndex(p => p.pool_id === valStr);
          if (matchedIdx < 0) matchedIdx = pRows.length - 1;
        }
      } else {
        const numVal = Number(r[varName]);
        if (Number.isFinite(numVal)) {
          for (let i = 0; i < upperBounds.length; i++) {
            const lower = pRows[i].lower;
            const upper = upperBounds[i];
            const lowerOk = lower === null || lower === undefined ? true : numVal > lower;
            const upperOk = numVal <= upper;
            if (lowerOk && upperOk) {
              matchedIdx = i;
              break;
            }
          }
          if (matchedIdx < 0) {
            // Check getBinIndex style
            const b = pRows.filter(p => typeof p.upper === 'number').map(p => p.upper as number).sort((x, y) => x - y);
            matchedIdx = Math.min(getBinIndex(numVal, b), pRows.length - 1);
          }
        }
      }

      if (matchedIdx >= 0 && matchedIdx < pRows.length) {
        pCounts[matchedIdx]++;
        if (isBad) pBads[matchedIdx]++;
      }
    }

    let varTotalIV = 0;
    const varEnriched: PoolStatRow[] = [];

    for (let i = 0; i < pRows.length; i++) {
      const p = pRows[i];
      const count = pCounts[i];
      const badCount = pBads[i];
      const goodCount = count - badCount;
      const share = totalRows > 0 ? +(count / totalRows).toFixed(6) : 0;
      const badRate = count > 0 ? +(badCount / count).toFixed(6) : 0;

      // Laplace/Haldane smoothing: add 0.5 to zero counts
      const adjG = totalGoods > 0 ? (goodCount === 0 ? 0.5 : goodCount) : 0.5;
      const adjB = totalBads > 0 ? (badCount === 0 ? 0.5 : badCount) : 0.5;
      const distG = totalGoods > 0 ? adjG / totalGoods : 0;
      const distB = totalBads > 0 ? adjB / totalBads : 0;

      let woe = 0;
      let iv = 0;
      if (distG > 0 && distB > 0) {
        woe = +Math.log(distG / distB).toFixed(4);
        iv = +((distG - distB) * woe).toFixed(4);
        if (iv < 0) iv = 0; // IV is mathematically non-negative
      }

      varTotalIV += iv;

      const statRow: PoolStatRow = {
        pool_id: p.pool_id || `P${i + 1}`,
        variable: varName,
        type: isCat ? 'categorical' : 'numeric',
        lower: p.lower,
        upper: p.upper,
        categories: p.categories,
        points: p.points,
        count,
        share,
        badCount,
        badRate,
        woe,
        iv,
      };

      varEnriched.push(statRow);
      enrichedRows.push(statRow);
    }

    featuresResult[varName] = {
      iv: +varTotalIV.toFixed(4),
      rows: varEnriched,
    };

    ivSummary[varName] = {
      iv: +varTotalIV.toFixed(4),
      numBins: pRows.length,
      strength: classifyIvStrength(varTotalIV),
      usedInModel: featDef?.usedInModel !== false,
    };

    if (featDef?.usedInModel !== false) {
      modelTotalIV += varTotalIV;
    }
  }

  return {
    source: 'คำนวณโดยระบบจาก Baseline',
    totalIV: +modelTotalIV.toFixed(4),
    features: featuresResult,
    ivSummary,
    enrichedRows,
  };
}

/**
 * Computes Development Stability (PSI/CSI) by splitting reference rows by dateColumn (75/25 chronological split).
 * If dateColumn is absent or row count < 500, returns available=false with reason.
 */
export function computeDevelopmentStability(options: {
  referenceRows: Record<string, unknown>[];
  dateColumn?: string | null;
  scoreColumn?: string | null;
  modelTable?: ModelTableDefinition | null;
  featureRegistry?: Record<string, FeatureDefinition> | null;
  trainRatio?: number;
  existingStability?: any;
}): DevelopmentStabilityResult {
  const { referenceRows, dateColumn, scoreColumn, modelTable, featureRegistry, trainRatio = 0.75, existingStability } = options;

  if (existingStability && existingStability.scorePsi !== undefined) {
    return {
      ...existingStability,
      available: true,
      source: existingStability.source || 'จาก Model Card',
    };
  }

  const rows = referenceRows || [];
  if (rows.length < 500) {
    return {
      available: false,
      reason: `จำนวนข้อมูลอ้างอิงน้อยกว่า 500 แถว (มีเพียง ${rows.length} แถว)`,
      source: 'ไม่มีข้อมูล',
    };
  }

  if (!dateColumn || !rows.some(r => r[dateColumn] !== undefined && r[dateColumn] !== null && String(r[dateColumn]).trim() !== '')) {
    return {
      available: false,
      reason: 'ไม่มีคอลัมน์วันที่ (Date Column) ในข้อมูลอ้างอิง',
      source: 'ไม่มีข้อมูล',
    };
  }

  // Filter rows with valid date values
  const dateRows = rows.filter(r => r[dateColumn] !== undefined && r[dateColumn] !== null && String(r[dateColumn]).trim() !== '');
  if (dateRows.length < 500) {
    return {
      available: false,
      reason: `ข้อมูลอ้างอิงที่มีวันที่สมบูรณ์น้อยกว่า 500 แถว (มีเพียง ${dateRows.length} แถว)`,
      source: 'ไม่มีข้อมูล',
    };
  }

  // Sort chronologically by date string
  const sorted = [...dateRows].sort((a, b) => String(a[dateColumn]).localeCompare(String(b[dateColumn])));
  const trainCount = Math.floor(sorted.length * trainRatio);
  const trainRows = sorted.slice(0, trainCount);
  const testRows = sorted.slice(trainCount);

  if (trainRows.length === 0 || testRows.length === 0) {
    return {
      available: false,
      reason: 'ไม่สามารถแบ่งข้อมูลตามสัดส่วนที่กำหนดได้',
      source: 'ไม่มีข้อมูล',
    };
  }

  const trainPeriod = `${String(trainRows[0][dateColumn])} – ${String(trainRows[trainRows.length - 1][dateColumn])}`;
  const testPeriod = `${String(testRows[0][dateColumn])} – ${String(testRows[testRows.length - 1][dateColumn])}`;

  // 1. Calculate Score PSI
  let scorePsi: number | null = null;
  if (scoreColumn) {
    const trainScores = trainRows.map(r => Number(r[scoreColumn])).filter(Number.isFinite);
    const testScores = testRows.map(r => Number(r[scoreColumn])).filter(Number.isFinite);
    if (trainScores.length >= 10 && testScores.length >= 10) {
      const sortedTrain = [...trainScores].sort((a, b) => a - b);
      const deciles: number[] = [];
      for (let i = 1; i <= 9; i++) {
        deciles.push(sortedTrain[Math.floor(sortedTrain.length * (i / 10))]);
      }
      scorePsi = +calculatePSI(trainScores, testScores).toFixed(4);
    }
  }

  // 2. Calculate Feature CSI using model pools or bins
  const featureCsi: Record<string, number> = {};

  if (modelTable && Array.isArray(modelTable.rows)) {
    const grouped = new Map<string, ModelTableRow[]>();
    for (const r of modelTable.rows) {
      if (!r.variable || r.variable === 'base_points') continue;
      if (!grouped.has(r.variable)) grouped.set(r.variable, []);
      grouped.get(r.variable)!.push(r);
    }

    for (const [varName, pRows] of grouped.entries()) {
      const featDef = featureRegistry?.[varName];
      const isCat = pRows.some(p => p.categories && p.categories.length > 0) || featDef?.dataType === 'categorical';

      if (isCat) {
        const trainCounts = new Array(pRows.length).fill(0);
        const testCounts = new Array(pRows.length).fill(0);

        for (const r of trainRows) {
          const val = String(r[varName] ?? '').trim();
          let idx = pRows.findIndex(p => {
            if (!p.categories) return false;
            return Array.isArray(p.categories) ? p.categories.some(c => String(c).trim() === val) : String(p.categories).trim() === val;
          });
          if (idx < 0) idx = pRows.length - 1;
          trainCounts[idx]++;
        }
        for (const r of testRows) {
          const val = String(r[varName] ?? '').trim();
          let idx = pRows.findIndex(p => {
            if (!p.categories) return false;
            return Array.isArray(p.categories) ? p.categories.some(c => String(c).trim() === val) : String(p.categories).trim() === val;
          });
          if (idx < 0) idx = pRows.length - 1;
          testCounts[idx]++;
        }

        let csi = 0;
        for (let i = 0; i < pRows.length; i++) {
          const p = Math.max(trainCounts[i], 0.5) / trainRows.length;
          const q = Math.max(testCounts[i], 0.5) / testRows.length;
          csi += (p - q) * Math.log(p / q);
        }
        featureCsi[varName] = +csi.toFixed(4);
      } else {
        const b = pRows.filter(p => typeof p.upper === 'number').map(p => p.upper as number).sort((x, y) => x - y);
        const trainVals = trainRows.map(r => Number(r[varName])).filter(Number.isFinite);
        const testVals = testRows.map(r => Number(r[varName])).filter(Number.isFinite);
        if (trainVals.length > 0 && testVals.length > 0) {
          featureCsi[varName] = +calculateCSIWithBins(trainVals, testVals, b).toFixed(4);
        }
      }
    }
  }

  return {
    available: true,
    source: `คำนวณโดยระบบจาก Baseline (แบ่งตามเวลา ${Math.round(trainRatio * 100)}/${Math.round((1 - trainRatio) * 100)})`,
    trainRatio,
    trainCount: trainRows.length,
    testCount: testRows.length,
    trainPeriod,
    testPeriod,
    scorePsi,
    featureCsi,
  };
}
