export const MAX_PERCENT = 1000;
export const NATIVE_PERCENT = 100;

export type BackgroundRequest =
  | { target: "background"; type: "getState"; tabId: number }
  | { target: "background"; type: "setGain"; tabId: number; percent: number };

export type TabStateView = {
  percent: number;
  touched: boolean;
  capturable: boolean;
};

export type OffscreenRequest =
  | {
      target: "offscreen";
      type: "attach";
      tabId: number;
      streamId: string;
      percent: number;
    }
  | { target: "offscreen"; type: "setGain"; tabId: number; percent: number }
  | { target: "offscreen"; type: "detach"; tabId: number }
  | { target: "offscreen"; type: "hasTab"; tabId: number }
  | { target: "offscreen"; type: "isEmpty" };

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

export function clampPercent(raw: number): number {
  if (!Number.isFinite(raw)) return NATIVE_PERCENT;
  return Math.min(MAX_PERCENT, Math.max(0, raw));
}

export function snapPercent(raw: number): number {
  const n = Math.round(clampPercent(raw));
  if (n <= NATIVE_PERCENT) return n;
  const steps = Math.max(1, Math.round((n - NATIVE_PERCENT) / 5));
  return Math.min(MAX_PERCENT, NATIVE_PERCENT + steps * 5);
}

export function nextPercent(prev: number, raw: number): number {
  const clamped = Math.round(clampPercent(raw));
  if (prev <= NATIVE_PERCENT && clamped > NATIVE_PERCENT) {
    return clamped >= 103 ? snapPercent(clamped) : 105;
  }
  if (prev >= 105 && clamped > NATIVE_PERCENT && clamped < 105) {
    return NATIVE_PERCENT;
  }
  return snapPercent(clamped);
}

export function sliderStep(percent: number): number {
  return percent <= NATIVE_PERCENT ? 1 : 5;
}
