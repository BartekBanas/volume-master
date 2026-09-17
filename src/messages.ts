export const MAX_PERCENT = 2000;
export const NATIVE_PERCENT = 100;
/** Linear slider position for native (100%) volume; 1/3 of the track. */
export const NATIVE_POSITION_RATIO = 1 / 3;
export const NATIVE_POSITION = Math.round(MAX_PERCENT * NATIVE_POSITION_RATIO);

export type BackgroundRequest =
  | { target: "background"; type: "getState"; tabId: number }
  | { target: "background"; type: "setGain"; tabId: number; percent: number }
  | { target: "background"; type: "setLimiter"; enabled: boolean }
  | { target: "background"; type: "watchMeter"; tabId: number }
  | { target: "background"; type: "unwatchMeter" };

export type PopupEvent = {
  target: "popup";
  type: "limiterMeter";
  tabId: number;
  reduction: number;
};

export type TabStateView = {
  percent: number;
  capturable: boolean;
  limiter: boolean;
};

export type OffscreenTabState = { captured: boolean; percent: number };

export type OffscreenRequest =
  | {
      target: "offscreen";
      type: "attach";
      tabId: number;
      streamId: string;
      percent: number;
      limiter: boolean;
    }
  | { target: "offscreen"; type: "setGain"; tabId: number; percent: number }
  | { target: "offscreen"; type: "setLimiter"; enabled: boolean }
  | { target: "offscreen"; type: "detach"; tabId: number }
  | { target: "offscreen"; type: "getState"; tabId: number }
  | { target: "offscreen"; type: "isEmpty" }
  | { target: "offscreen"; type: "watchMeter"; tabId: number | null };

const BLOCKED_PROTOCOLS = new Set([
  "chrome:",
  "chrome-extension:",
  "edge:",
  "about:",
  "devtools:",
  "view-source:",
]);

export function isCapturableUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (BLOCKED_PROTOCOLS.has(parsed.protocol)) return false;
  if (parsed.hostname === "chromewebstore.google.com") return false;
  if (parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore")) {
    return false;
  }
  if (
    parsed.hostname === "microsoftedge.microsoft.com" &&
    parsed.pathname.includes("/addons")
  ) {
    return false;
  }
  return true;
}

/** Full-range gamma: anchors 100% at one-third of the track. */
export const SLIDER_GAMMA =
  Math.log(NATIVE_PERCENT / MAX_PERCENT) / Math.log(NATIVE_POSITION_RATIO);
/** Gentler curve for 0–100%; half the exponent of the full range. */
export const NATIVE_GAMMA = SLIDER_GAMMA / 2;

export function clampPercent(raw: number): number {
  if (!Number.isFinite(raw)) return NATIVE_PERCENT;
  return Math.min(MAX_PERCENT, Math.max(0, raw));
}

export function snapPercent(raw: number): number {
  if (!Number.isFinite(raw)) return NATIVE_PERCENT;
  return Math.min(MAX_PERCENT, Math.max(0, Math.round(raw)));
}

/** Map a linear slider position (0–MAX) onto volume percent. */
export function percentFromPosition(position: number): number {
  const pos = Math.min(MAX_PERCENT, Math.max(0, Math.round(position)));
  if (pos <= NATIVE_POSITION) {
    const t = pos / NATIVE_POSITION;
    return snapPercent(NATIVE_PERCENT * t ** NATIVE_GAMMA);
  }
  const t = pos / MAX_PERCENT;
  return snapPercent(MAX_PERCENT * t ** SLIDER_GAMMA);
}

export function positionFromPercent(percent: number): number {
  const p = snapPercent(percent);
  if (p <= NATIVE_PERCENT) {
    const t = p / NATIVE_PERCENT;
    return Math.round(NATIVE_POSITION * t ** (1 / NATIVE_GAMMA));
  }
  const t = p / MAX_PERCENT;
  return Math.round(MAX_PERCENT * t ** (1 / SLIDER_GAMMA));
}

export type VolumeUnit = "percent" | "db";

/** Amplitude dB from percent. 100% is 0 dB, 2000% is +26 dB, 0% is −∞. */
export function dbFromPercent(percent: number): number {
  const p = snapPercent(percent);
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(p / NATIVE_PERCENT);
}

export function formatDb(percent: number): string {
  const db = dbFromPercent(percent);
  if (!Number.isFinite(db)) return "−∞";
  const rounded = Math.round(db * 10) / 10;
  if (Object.is(rounded, -0) || rounded === 0) return "0.0";
  const abs = Math.abs(rounded).toFixed(1);
  return `${rounded > 0 ? "+" : "−"}${abs}`;
}
