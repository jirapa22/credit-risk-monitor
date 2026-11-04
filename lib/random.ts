/**
 * Shared seeded PRNG. Used by Isolation Forest (lib/anomaly/multivariate.ts)
 * and the Sandbox anomaly injector (lib/injection.ts) so experiments are reproducible.
 */

/** mulberry32 — small, fast 32-bit seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
