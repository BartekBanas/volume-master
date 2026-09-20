export const GAIN_STOPS: readonly number[] = [
  0, 5, 10, 15, 20, 25, 35, 50, 60, 75, 85, 100, 125, 150, 175, 200, 250, 300, 350, 400,
  500, 600, 750, 850, 1000, 1250, 1500, 1750, 2000,
];

export const TARGET_STOPS: readonly number[] = [
  0, 5, 10, 15, 20, 25, 35, 50, 60, 75, 85, 100,
];

export function stopsFor(mode: "gain" | "target"): readonly number[] {
  return mode === "gain" ? GAIN_STOPS : TARGET_STOPS;
}

/** Closest stop by absolute distance; tie → higher stop. */
export function nearestStopIndex(stops: readonly number[], value: number): number {
  if (stops.length === 0) return 0;
  const first = stops[0]!;
  let best = 0;
  let bestDist = Math.abs(first - value);
  for (let i = 1; i < stops.length; i++) {
    const stop = stops[i]!;
    const dist = Math.abs(stop - value);
    if (dist < bestDist || (dist === bestDist && stop > stops[best]!)) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

export function indexRatio(index: number, stopCount: number): number {
  return stopCount <= 1 ? 0 : index / (stopCount - 1);
}

export function nativeIndex(stops: readonly number[]): number {
  const idx = stops.indexOf(100);
  return idx >= 0 ? idx : 0;
}
