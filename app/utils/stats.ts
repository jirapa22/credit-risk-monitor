export interface DataPoint {
  score: number;
  label: number; // 0 = Good, 1 = Bad (Default)
}

/**
 * Calculates PSI (Population Stability Index) or CSI (Characteristic Stability Index)
 * between a baseline array of numbers and an actual array of numbers.
 */
export function calculatePSI(baseValues: number[], actualValues: number[]): number {
  if (baseValues.length === 0 || actualValues.length === 0) return 0;

  // 1. Sort base values to find decile boundaries
  const sortedBase = [...baseValues].sort((a, b) => a - b);
  const boundaries: number[] = [];
  const numBins = 10;
  
  for (let i = 1; i < numBins; i++) {
    const idx = Math.floor(sortedBase.length * (i / numBins));
    boundaries.push(sortedBase[idx]);
  }

  // 2. Count frequencies in each bin for both expected (base) and actual datasets
  const expectedCounts = new Array(numBins).fill(0);
  const actualCounts = new Array(numBins).fill(0);

  const getBinIndex = (val: number): number => {
    for (let i = 0; i < boundaries.length; i++) {
      if (val <= boundaries[i]) return i;
    }
    return numBins - 1;
  };

  baseValues.forEach(val => {
    expectedCounts[getBinIndex(val)]++;
  });

  actualValues.forEach(val => {
    actualCounts[getBinIndex(val)]++;
  });

  // 3. Compute PSI
  let psi = 0;
  const eps = 0.0001; // Small epsilon to avoid division by zero or log of zero

  for (let i = 0; i < numBins; i++) {
    const expectedPct = expectedCounts[i] / baseValues.length;
    const actualPct = actualCounts[i] / actualValues.length;

    // Apply Laplace smoothing/epsilon adjustment if percentage is 0
    const adjExpected = expectedPct === 0 ? eps : expectedPct;
    const adjActual = actualPct === 0 ? eps : actualPct;

    psi += (adjActual - adjExpected) * Math.log(adjActual / adjExpected);
  }

  return psi;
}

/**
 * Calculates CSI (Characteristic Stability Index) using FIXED bin boundaries.
 * This gives consistent, comparable results across different monitoring periods.
 * 
 * @param baseValues   Baseline feature values (reference population)
 * @param actualValues Actual/new feature values (current population)
 * @param binBoundaries Array of N-1 boundaries creating N bins.
 *                      e.g. [25000, 35000, 45000] → bins: (<25k), (25k-35k), (35k-45k), (≥45k)
 */
export function calculateCSIWithBins(
  baseValues: number[],
  actualValues: number[],
  binBoundaries: number[]
): number {
  if (baseValues.length === 0 || actualValues.length === 0) return 0;

  const numBins = binBoundaries.length + 1; // N boundaries → N+1 bins

  const getBinIndex = (val: number): number => {
    for (let i = 0; i < binBoundaries.length; i++) {
      if (val <= binBoundaries[i]) return i;
    }
    return numBins - 1;
  };

  const baseCounts = new Array(numBins).fill(0);
  const actualCounts = new Array(numBins).fill(0);

  baseValues.forEach(v => baseCounts[getBinIndex(v)]++);
  actualValues.forEach(v => actualCounts[getBinIndex(v)]++);

  let csi = 0;
  const eps = 0.0001;

  for (let i = 0; i < numBins; i++) {
    const basePct = baseCounts[i] / baseValues.length;
    const actualPct = actualCounts[i] / actualValues.length;
    const adjBase = basePct === 0 ? eps : basePct;
    const adjActual = actualPct === 0 ? eps : actualPct;
    csi += (adjActual - adjBase) * Math.log(adjActual / adjBase);
  }

  return csi;
}

/**
 * Calculates AUC (Area Under the ROC Curve) using the Wilcoxon-Mann-Whitney Rank Sum method.
 * Handles ties by assigning average ranks.
 */
export function calculateAUC(data: DataPoint[]): number {
  const n = data.length;
  if (n === 0) return 0.5;

  const totalGood = data.filter(d => d.label === 0).length;
  const totalBad = data.filter(d => d.label === 1).length;

  if (totalGood === 0 || totalBad === 0) return 0.5;

  // Sort by score ascending
  const sorted = [...data].sort((a, b) => a.score - b.score);
  const ranks = new Array(n);
  
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && sorted[j].score === sorted[i].score) {
      j++;
    }
    // Assign average rank to ties
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      ranks[k] = avgRank;
    }
    i = j;
  }

  let rankSumBad = 0;
  for (let k = 0; k < n; k++) {
    if (sorted[k].label === 1) {
      rankSumBad += ranks[k];
    }
  }

  const auc = (rankSumBad - (totalBad * (totalBad + 1)) / 2) / (totalGood * totalBad);
  return Math.min(Math.max(auc, 0), 1); // Clamp between 0 and 1
}

/**
 * Calculates Gini Coefficient based on AUC.
 * Gini = 2 * AUC - 1
 */
export function calculateGini(data: DataPoint[]): number {
  const auc = calculateAUC(data);
  return 2 * auc - 1;
}

/**
 * Calculates Kolmogorov-Smirnov (KS) statistic.
 */
export function calculateKS(data: DataPoint[]): number {
  if (data.length === 0) return 0;

  const totalGood = data.filter(d => d.label === 0).length;
  const totalBad = data.filter(d => d.label === 1).length;

  if (totalGood === 0 || totalBad === 0) return 0;

  // Sort by score ascending
  const sorted = [...data].sort((a, b) => a.score - b.score);

  let cumGood = 0;
  let cumBad = 0;
  let maxDiff = 0;

  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].label === 1) {
      cumBad++;
    } else {
      cumGood++;
    }

    const goodPct = cumGood / totalGood;
    const badPct = cumBad / totalBad;
    const diff = Math.abs(goodPct - badPct);

    if (diff > maxDiff) {
      maxDiff = diff;
    }
  }

  return maxDiff;
}

/**
 * Calculates Cumulative Lift at a specific top percentile (e.g., top 10% or 0.1).
 */
export function calculateLift(data: DataPoint[], percentile: number = 0.1): number {
  const n = data.length;
  if (n === 0) return 0;

  const totalBad = data.filter(d => d.label === 1).length;
  if (totalBad === 0) return 0;

  // Sort by score descending (high score = high default risk)
  const sorted = [...data].sort((a, b) => b.score - a.score);

  const cutOff = Math.max(1, Math.floor(n * percentile));
  const topBad = sorted.slice(0, cutOff).filter(d => d.label === 1).length;

  const overallBadRate = totalBad / n;
  const topBadRate = topBad / cutOff;

  return overallBadRate === 0 ? 0 : topBadRate / overallBadRate;
}
