// Seeded random numbers so every forecast is reproducible: the same data and seed give the same
// percentiles, which keeps tests deterministic and lets a user re-run a forecast and get the same card.

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Standard normal (Box-Muller). */
  normal(): number
  /** Integer in [0, n). */
  int(n: number): number
}

/** mulberry32: tiny, fast, good enough for Monte Carlo (not for cryptography). */
export function rng(seed: number): Rng {
  let a = seed >>> 0
  let spare: number | null = null
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    normal() {
      if (spare !== null) { const s = spare; spare = null; return s }
      let u = 0
      while (u <= 1e-12) u = next()
      const v = next()
      const r = Math.sqrt(-2 * Math.log(u))
      spare = r * Math.sin(2 * Math.PI * v)
      return r * Math.cos(2 * Math.PI * v)
    },
    int(n) { return Math.min(n - 1, Math.floor(next() * n)) }
  }
}

/** A stable 32-bit seed from text (FNV-1a), e.g. symbol + as-of date. */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
