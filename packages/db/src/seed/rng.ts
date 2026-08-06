/**
 * Deterministic PRNG. The demo dataset must be byte-identical on every machine
 * so screenshots, tests and the AI evaluation suite all agree on what "last
 * month's revenue" was.
 */
export function makeRng(seed = 20260806) {
  let s = seed >>> 0;
  return {
    next(): number {
      // mulberry32
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(min: number, max: number): number {
      return Math.floor(this.next() * (max - min + 1)) + min;
    },
    pick<T>(arr: readonly T[]): T {
      return arr[Math.floor(this.next() * arr.length)]!;
    },
    /** Weighted pick: [[value, weight], ...] */
    weighted<T>(pairs: readonly (readonly [T, number])[]): T {
      const total = pairs.reduce((a, [, w]) => a + w, 0);
      let r = this.next() * total;
      for (const [v, w] of pairs) {
        r -= w;
        if (r <= 0) return v;
      }
      return pairs[pairs.length - 1]![0];
    },
    bool(p = 0.5): boolean {
      return this.next() < p;
    },
    /** Rounded to 2dp, returned as a string for numeric columns. */
    money(min: number, max: number, step = 1): string {
      const raw = this.int(min / step, max / step) * step;
      return raw.toFixed(2);
    },
  };
}

export type Rng = ReturnType<typeof makeRng>;

export const money = (n: number): string => n.toFixed(4);

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

export function addMonths(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + n);
  return out;
}

export function atTime(d: Date, hour: number, minute = 0): Date {
  const out = new Date(d);
  out.setUTCHours(hour, minute, 0, 0);
  return out;
}
