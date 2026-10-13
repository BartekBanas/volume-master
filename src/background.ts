import {
  clampIntensity,
  DEFAULT_INTENSITY,
  isCapturableUrl,
  NATIVE_PERCENT,
  DEFAULT_TARGET,
  dbFromTarget,
  snapPercent,
  snapTarget,
  type BackgroundRequest,
  type OffscreenRequest,
  type OffscreenTabState,
  type TabSettings,
  type TabStateView,
} from "./messages.js";
import {
  DEFAULT_SETTINGS,
  onSettingsChanged,
  readSettings,
  writeSettings,
  type Settings,
} from "./settings.js";
import {
  DEFAULT_TAB_SETTINGS,
  forgetTab,
  getTabSettings,
  patchTabSettings,
  tabSettingsReady,
} from "./tabSettings.js";

type RestorableState =
  | typeof chrome.windows.WindowState.NORMAL
  | typeof chrome.windows.WindowState.MAXIMIZED;

const needsRecapture = new Set<number>();
/**
 * Windows we promoted to F11-style fullscreen, keyed by window id, with the
 * state to restore. Lives in chrome.storage.session (memory only, cleared when
 * the browser closes) because the service worker is shut down after ~30s of
 * idle time and an in-memory map would be lost mid-fullscreen. Losing it meant
 * the window stayed in F11 after the site exited fullscreen.
 */
const PROMOTED_WINDOWS_KEY = "promotedWindows";
type PromotedWindows = Record<string, RestorableState>;
/** Bumped per window whenever we promote it, so a stale restore loop stops. */
const promotionGeneration = new Map<number, number>();
let creatingOffscreen: Promise<void> | null = null;
let meterTabId: number | null = null;

/**
 * Cached copy of chrome.storage.local "settings". The service worker restarts
 * after idle, so the cache is reloaded on startup and kept fresh by onChanged.
 */
let settings: Settings = DEFAULT_SETTINGS;
const settingsReady: Promise<void> = readSettings().then((loaded) => {
  settings = loaded;
});

onSettingsChanged((next) => {
  const previous = settings;
  settings = next;
  if (next.limiter !== previous.limiter) {
    void (async () => {
      if (await hasOffscreen()) {
        await sendOffscreen({ target: "offscreen", type: "setLimiter", enabled: next.limiter });
      }
    })();
  }
  if (next.unit !== previous.unit) {
    void refreshBadges();
  }
});

const BADGE_COLOR = "#1c1c24";
const DEFAULT_STATE: OffscreenTabState = { ...DEFAULT_TAB_SETTINGS, captured: false };

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Replay captured tab audio through a gain node.",
      })
      .then(() => undefined)
      .catch(async (err: unknown) => {
        if (await hasOffscreen()) return;
        throw err;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

type OffscreenResponse = {
  ok?: boolean;
  captured?: boolean;
  empty?: boolean;
  states?: Array<OffscreenTabState & { tabId: number }>;
  error?: string;
};

async function sendOffscreen(message: OffscreenRequest): Promise<OffscreenResponse> {
  return chrome.runtime.sendMessage(message);
}

/** The offscreen graph decides whether a tab is captured; Bypassed is the inverse. */
async function isCaptured(tabId: number): Promise<boolean> {
  if (!(await hasOffscreen())) return false;
  const result = await sendOffscreen({ target: "offscreen", type: "getState", tabId });
  return result?.captured === true;
}

async function tabState(tabId: number): Promise<OffscreenTabState> {
  return { ...getTabSettings(tabId), captured: await isCaptured(tabId) };
}

/** Compression target for the badge. Follows the Units setting; mute is −∞ or 0. */
function targetBadge(position: number): string {
  if (settings.unit === "percent") return String(snapTarget(position));
  const db = dbFromTarget(position);
  return Number.isFinite(db) ? String(Math.round(db)) : "-∞";
}

/**
 * Gain mode shows the bare percent. Compression mode shows the target in the
 * current unit. Nothing is shown for a Bypassed tab.
 */
async function setBadge(tabId: number, state: OffscreenTabState): Promise<void> {
  const text = !state.captured
    ? ""
    : state.compression
      ? targetBadge(state.target)
      : String(state.percent);
  if (text === "") {
    await chrome.action.setBadgeText({ text: "", tabId }).catch(() => undefined);
    return;
  }
  await chrome.action
    .setBadgeBackgroundColor({ color: BADGE_COLOR, tabId })
    .catch(() => undefined);
  await chrome.action.setBadgeText({ text, tabId }).catch(() => undefined);
}

async function refreshBadges(): Promise<void> {
  if (!(await hasOffscreen())) return;
  const result = await sendOffscreen({ target: "offscreen", type: "listStates" });
  for (const state of result.states ?? []) {
    await setBadge(state.tabId, state);
  }
}

async function detachTab(tabId: number): Promise<void> {
  if (!(await hasOffscreen())) return;
  await sendOffscreen({ target: "offscreen", type: "detach", tabId });
}

async function closeOffscreenIfEmpty(): Promise<void> {
  if (!(await hasOffscreen())) return;
  const result = await sendOffscreen({ target: "offscreen", type: "isEmpty" });
  if (result?.empty) {
    await chrome.offscreen.closeDocument();
  }
}

async function capture(tabId: number, state: TabSettings): Promise<void> {
  await ensureOffscreen();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const result = await sendOffscreen({
    target: "offscreen",
    type: "attach",
    tabId,
    streamId,
    percent: state.percent,
    targetPercent: state.target,
    intensity: state.intensity,
    limiter: settings.limiter,
    compression: state.compression,
  });
  if (!result?.ok) {
    throw new Error(result?.error ?? "attach failed");
  }
  if (meterTabId !== null) {
    await sendOffscreen({ target: "offscreen", type: "watchMeter", tabId: meterTabId });
  }
}

/**
 * Drop the capture for a tab and clear its badge. A failed detach is ignored:
 * it only fails when the offscreen document is already gone, and the stream
 * died with it, so Bypassed is the true state either way.
 */
async function dropCapture(tabId: number): Promise<void> {
  await detachTab(tabId).catch(() => undefined);
  await closeOffscreenIfEmpty();
  await setBadge(tabId, DEFAULT_STATE);
}

async function tabCapturable(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.url) return true;
  return isCapturableUrl(tab.url);
}

function view(state: OffscreenTabState, capturable: boolean): TabStateView {
  return {
    percent: state.percent,
    target: state.target,
    intensity: state.intensity,
    bypassed: !state.captured,
    compression: state.compression,
    capturable,
    limiter: settings.limiter,
  };
}

/** Run a tab action, or report the tab as uncapturable without touching it. */
async function whenCapturable(
  tabId: number,
  action: () => Promise<TabStateView>,
): Promise<TabStateView> {
  if (!(await tabCapturable(tabId))) return view(DEFAULT_STATE, false);
  return action();
}

async function getState(tabId: number): Promise<TabStateView> {
  return whenCapturable(tabId, async () => view(await tabState(tabId), true));
}

async function watchMeter(tabId: number | null): Promise<void> {
  meterTabId = tabId;
  if (await hasOffscreen()) {
    await sendOffscreen({ target: "offscreen", type: "watchMeter", tabId });
  }
}

/** Persists the flag; the onSettingsChanged listener pushes it to the offscreen graph. */
async function setLimiter(enabled: boolean): Promise<TabStateView> {
  await writeSettings({ limiter: enabled });
  return { ...view(DEFAULT_STATE, true), limiter: enabled };
}

async function sendAll(messages: OffscreenRequest[]): Promise<void> {
  for (const message of messages) {
    const result = await sendOffscreen(message);
    if (!result?.ok) throw new Error(result?.error ?? "offscreen update failed");
  }
}

/** Remember the patch. A captured tab hears it now; a Bypassed tab on its next capture. */
async function remember(
  tabId: number,
  patch: Partial<TabSettings>,
  messages: OffscreenRequest[],
): Promise<OffscreenTabState> {
  const captured = await isCaptured(tabId);
  const next = await patchTabSettings(tabId, patch);
  if (captured) await sendAll(messages);
  return { ...next, captured };
}

async function settle(tabId: number, state: OffscreenTabState): Promise<TabStateView> {
  await setBadge(tabId, state);
  return view(state, true);
}

async function bypass(tabId: number): Promise<TabStateView> {
  await dropCapture(tabId);
  return view({ ...getTabSettings(tabId), captured: false }, true);
}

/** Apply a change and turn Bypassed off, capturing with the remembered values. */
async function applyToTab(
  tabId: number,
  patch: Partial<TabSettings>,
  messages: OffscreenRequest[],
): Promise<TabStateView> {
  try {
    const state = await remember(tabId, patch, messages);
    if (!state.captured) await capture(tabId, state);
    return await settle(tabId, { ...state, captured: true });
  } catch {
    return bypass(tabId);
  }
}

async function setGain(tabId: number, percent: number): Promise<TabStateView> {
  return whenCapturable(tabId, () => {
    const snapped = snapPercent(percent);
    return applyToTab(tabId, { percent: snapped }, [
      { target: "offscreen", type: "setGain", tabId, percent: snapped },
    ]);
  });
}

async function setTarget(tabId: number, percent: number): Promise<TabStateView> {
  return whenCapturable(tabId, () => {
    const snapped = snapTarget(percent);
    return applyToTab(tabId, { target: snapped }, [
      { target: "offscreen", type: "setTarget", tabId, percent: snapped },
    ]);
  });
}

async function setIntensity(tabId: number, intensity: number): Promise<TabStateView> {
  return whenCapturable(tabId, () => {
    const clamped = clampIntensity(intensity);
    return applyToTab(tabId, { intensity: clamped }, [
      { target: "offscreen", type: "setIntensity", tabId, intensity: clamped },
    ]);
  });
}

async function setCompression(tabId: number, enabled: boolean): Promise<TabStateView> {
  return whenCapturable(tabId, () =>
    applyToTab(tabId, { compression: enabled }, [
      { target: "offscreen", type: "setCompression", tabId, enabled },
    ]),
  );
}

async function setBypassed(tabId: number, bypassed: boolean): Promise<TabStateView> {
  return whenCapturable(tabId, () => (bypassed ? bypass(tabId) : applyToTab(tabId, {}, [])));
}

type Change = { patch: Partial<TabSettings>; messages: OffscreenRequest[] };

function resetChange(tabId: number, compression: boolean): Change {
  if (compression) {
    return {
      patch: { target: DEFAULT_TARGET, intensity: DEFAULT_INTENSITY },
      messages: [
        { target: "offscreen", type: "setTarget", tabId, percent: DEFAULT_TARGET },
        { target: "offscreen", type: "setIntensity", tabId, intensity: DEFAULT_INTENSITY },
      ],
    };
  }
  return {
    patch: { percent: NATIVE_PERCENT },
    messages: [{ target: "offscreen", type: "setGain", tabId, percent: NATIVE_PERCENT }],
  };
}

/** Restore the current mode's defaults. Bypassed stays as it was. */
async function reset(tabId: number): Promise<TabStateView> {
  return whenCapturable(tabId, async () => {
    const { patch, messages } = resetChange(tabId, getTabSettings(tabId).compression);
    try {
      return await settle(tabId, await remember(tabId, patch, messages));
    } catch {
      return bypass(tabId);
    }
  });
}

async function recapture(tabId: number): Promise<void> {
  await tabSettingsReady;
  if (!(await isCaptured(tabId))) return;
  const state = getTabSettings(tabId);
  try {
    await detachTab(tabId);
    await capture(tabId, state);
    await setBadge(tabId, { ...state, captured: true });
  } catch {
    await dropCapture(tabId);
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
  if (!message || message.target !== "background") return;
  void Promise.all([settingsReady, tabSettingsReady])
    .then(() => dispatch(message))
    .then(sendResponse);
  return true;
});

async function dispatch(message: BackgroundRequest): Promise<unknown> {
  switch (message.type) {
    case "getState":
      return getState(message.tabId);
    case "setLimiter":
      return setLimiter(message.enabled);
    case "setCompression":
      return setCompression(message.tabId, message.enabled);
    case "watchMeter":
      return watchMeter(message.tabId);
    case "unwatchMeter":
      return watchMeter(null);
    case "setGain":
      return setGain(message.tabId, message.percent);
    case "setTarget":
      return setTarget(message.tabId, message.percent);
    case "setIntensity":
      return setIntensity(message.tabId, message.intensity);
    case "setBypassed":
      return setBypassed(message.tabId, message.bypassed);
    case "reset":
      return reset(message.tabId);
    default: {
      const unhandled: never = message;
      return unhandled;
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  needsRecapture.delete(tabId);
  void forgetTab(tabId);
  void (async () => {
    await detachTab(tabId);
    await closeOffscreenIfEmpty();
  })();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) needsRecapture.add(tabId);
  if (info.status !== "complete" || !needsRecapture.has(tabId)) return;
  needsRecapture.delete(tabId);
  void recapture(tabId);
});

function restorableState(
  state: `${chrome.windows.WindowState}` | undefined,
): RestorableState {
  return state === chrome.windows.WindowState.MAXIMIZED
    ? chrome.windows.WindowState.MAXIMIZED
    : chrome.windows.WindowState.NORMAL;
}

async function readPromotedWindows(): Promise<PromotedWindows> {
  const stored = await chrome.storage.session
    .get(PROMOTED_WINDOWS_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  const value = stored[PROMOTED_WINDOWS_KEY];
  return value && typeof value === "object" ? (value as PromotedWindows) : {};
}

async function writePromotedWindows(promoted: PromotedWindows): Promise<void> {
  await chrome.storage.session
    .set({ [PROMOTED_WINDOWS_KEY]: promoted })
    .catch(() => undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bumpGeneration(windowId: number): number {
  const next = (promotionGeneration.get(windowId) ?? 0) + 1;
  promotionGeneration.set(windowId, next);
  return next;
}

/**
 * Leave F11 fullscreen. Chromium is still finishing the tab-fullscreen exit
 * when onStatusChanged fires, and a single windows.update issued during that
 * transition is sometimes dropped, so verify and retry a few times. Abort if
 * the window was promoted again in the meantime.
 */
async function leaveWindowFullscreen(
  windowId: number,
  prior: RestorableState,
  generation: number,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (promotionGeneration.get(windowId) !== generation) return;
    await chrome.windows.update(windowId, { state: prior }).catch(() => undefined);
    await sleep(100 + attempt * 150);
    const win = await chrome.windows.get(windowId).catch(() => undefined);
    if (!win || win.state !== "fullscreen") return;
  }
}

async function restorePromotedWindow(windowId: number): Promise<void> {
  const promoted = await readPromotedWindows();
  const prior = promoted[String(windowId)];
  if (!prior) return;
  delete promoted[String(windowId)];
  await writePromotedWindows(promoted);
  await leaveWindowFullscreen(windowId, prior, bumpGeneration(windowId));
}

async function promoteWindow(windowId: number): Promise<void> {
  const win = await chrome.windows.get(windowId).catch(() => undefined);
  if (!win) return;
  const promoted = await readPromotedWindows();
  const key = String(windowId);
  if (win.state === "fullscreen") {
    // Either already promoted by us (record exists, keep it) or the user
    // pressed F11 themselves (no record, leave their window alone).
    return;
  }
  if (!promoted[key]) {
    promoted[key] = restorableState(win.state);
    await writePromotedWindows(promoted);
  }
  bumpGeneration(windowId);
  await chrome.windows
    .update(windowId, { state: "fullscreen" })
    .catch(() => undefined);
}

async function syncWindowFullscreen(
  tabId: number,
  fullscreen: boolean,
  status: chrome.tabCapture.CaptureInfo["status"],
): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.windowId) return;
  const { windowId } = tab;

  if (!fullscreen || status === "stopped" || status === "error") {
    await restorePromotedWindow(windowId);
    return;
  }

  if (status !== "active") return;
  await promoteWindow(windowId);
}

chrome.tabCapture.onStatusChanged.addListener((info) => {
  void syncWindowFullscreen(info.tabId, info.fullscreen, info.status);
});

chrome.windows.onRemoved.addListener((windowId) => {
  promotionGeneration.delete(windowId);
  void (async () => {
    const promoted = await readPromotedWindows();
    if (!promoted[String(windowId)]) return;
    delete promoted[String(windowId)];
    await writePromotedWindows(promoted);
  })();
});
