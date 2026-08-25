import type { Easing } from "./schema";

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

/** Exact Manim Community 0.21 `smooth(t, inflection=10.0)`. */
function manimSmooth(progress: number): number {
  const t = clampUnit(progress);
  const error = sigmoid(-5);
  return clampUnit((sigmoid(10 * (t - 0.5)) - error) / (1 - 2 * error));
}

/**
 * Browser-side mirror of the named rate functions emitted by the compiler.
 * Keep this table synchronized with `manimRateFunctionName` below.
 */
export function easingProgress(easing: Easing, progress: number): number {
  const t = clampUnit(progress);
  switch (easing) {
    case "linear": return t;
    case "ease-in": return 2 * manimSmooth(t / 2);
    case "ease-out": return 2 * manimSmooth(t / 2 + 0.5) - 1;
    case "ease-in-out": return manimSmooth(t);
    case "there-and-back": return manimSmooth(t < 0.5 ? t * 2 : (1 - t) * 2);
    case "editorial": return 1 - (1 - t) ** 4;
    case "spring-soft": {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
    }
  }
}

export function manimRateFunctionName(easing: Easing): string {
  switch (easing) {
    case "linear": return "linear";
    case "ease-in": return "rush_into";
    case "ease-out": return "rush_from";
    case "ease-in-out": return "smooth";
    case "there-and-back": return "rate_functions.there_and_back";
    case "editorial": return "rate_functions.ease_out_quart";
    case "spring-soft": return "rate_functions.ease_out_back";
  }
}

/** Extrema of each named Manim rate function over authored progress [0, 1]. */
export function easingProgressBounds(easing: Easing): readonly [number, number] {
  if (easing !== "spring-soft") return [0, 1];
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const peakTime = 1 - (2 * c1) / (3 * c3);
  return [0, easingProgress(easing, peakTime)];
}
