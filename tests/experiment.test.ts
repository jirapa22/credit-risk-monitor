import { describe, expect, it } from 'vitest';
import { runTrial, DETECTORS } from '../lib/experiment';
import modelConfig from '../app/model-config.json';

const model = structuredClone((modelConfig as any).models.ascore_v1);
const strip = (t: ReturnType<typeof runTrial>) => { const { timingMs: _t, ...rest } = t; return rest; };

describe('experiment runner', () => {
  it('(1) none: TP = FN = 0 and precision/recall are null (not NaN)', () => {
    const t = runTrial(model, { type: 'none', seed: 1 });
    for (const d of DETECTORS) {
      const m = t.detectors[d];
      expect(m.TP).toBe(0); expect(m.FN).toBe(0);
      expect(m.recall).toBeNull();
      expect(m.FP === 0 ? m.precision === null : m.precision === 0).toBe(true);
      expect(Number.isNaN(m.precision as any)).toBe(false);
    }
  });

  it('(2) extreme_outlier medium rate 0.05 seed 42: all_layers recall = 1', () => {
    const t = runTrial(model, { type: 'extreme_outlier', severity: 'medium', rate: 0.05, seed: 42 });
    expect(t.detectors.all_layers.recall).toBe(1);
  });

  it('(3) TP+FP+FN+TN = rows entering each detector', () => {
    for (const type of ['unit_error', 'duplicate_rows', 'schema_break', 'mean_shift'] as const) {
      const t = runTrial(model, { type, severity: 'medium', rate: 0.2, seed: 3 });
      for (const d of DETECTORS) {
        const m = t.detectors[d];
        expect(m.TP + m.FP + m.FN + m.TN).toBe(m.n);
      }
      expect(t.detectors.validation.n).toBe(t.rowCount);
      expect(t.detectors.all_layers.n).toBe(t.rowCount);
    }
  });

  it('(4) same seed → identical TrialResult (timing excluded)', () => {
    const a = runTrial(model, { type: 'swapped_columns', severity: 'medium', rate: 0.1, seed: 9 });
    const b = runTrial(model, { type: 'swapped_columns', severity: 'medium', rate: 0.1, seed: 9 });
    expect(strip(b)).toEqual(strip(a));
  });

  it('(5) mean_shift medium: detected = true', () => {
    const t = runTrial(model, { type: 'mean_shift', severity: 'medium', seed: 1 });
    expect(t.file.detected).toBe(true);
  });
});
