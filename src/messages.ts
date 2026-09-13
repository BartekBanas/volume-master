export const MAX_PERCENT = 1000;
export const NATIVE_PERCENT = 100;

export type BackgroundRequest =
  | { target: "background"; type: "getState"; tabId: number }
  | { target: "background"; type: "setGain"; tabId: number; percent: number };

export type TabStateView = {
  percent: number;
  capturable: boolean;
};

export type OffscreenTabState = { captured: boolean; percent: number };

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
  | { target: "offscreen"; type: "getState"; tabId: number }
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

export const SLIDER_GAMMA = 2;

export function clampPercent(raw: number): number {
  if (!Number.isFinite(raw)) return NATIVE_PERCENT;
  return Math.min(MAX_PERCENT, Math.max(0, raw));
}

export function snapPercent(raw: number): number {
  if (!Number.isFinite(raw)) return NATIVE_PERCENT;
  return Math.min(MAX_PERCENT, Math.max(0, Math.round(raw)));
}

/** Map a linear slider position (0–MAX) onto volume percent. Steeper at the top. */
export function percentFromPosition(position: number): number {
  const t = snapPercent(position) / MAX_PERCENT;
  return snapPercent(MAX_PERCENT * t ** SLIDER_GAMMA);
}

export function positionFromPercent(percent: number): number {
  const p = snapPercent(percent) / MAX_PERCENT;
  return Math.round(MAX_PERCENT * p ** (1 / SLIDER_GAMMA));
}
