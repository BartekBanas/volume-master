import {
  clampIntensity,
  DEFAULT_INTENSITY,
  isCapturableUrl,
  NATIVE_PERCENT,
  NATIVE_TARGET,
  snapPercent,
  snapTarget,
  type BackgroundRequest,
  type OffscreenRequest,
  type OffscreenTabState,
  type TabStateView,
} from "./messages.js";
import {
  DEFAULT_SETTINGS,
  onSettingsChanged,
  readSettings,
  writeSettings,
  type Settings,
} from "./settings.js";

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
  if (next.compression !== previous.compression) {
    void switchCompression(next.compression);
  }
});

const BADGE_COLOR = "#1c1c24";
const NOT_CAPTURED: OffscreenTabState = {
  captured: false,
  percent: NATIVE_PERCENT,
  target: NATIVE_TARGET,
  intensity: DEFAULT_INTENSITY,
};

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
  percent?: number;
  target?: number;
  intensity?: number;
  empty?: boolean;
  states?: Array<OffscreenTabState & { tabId: number }>;
  error?: string;
};

async function sendOffscreen(message: OffscreenRequest): Promise<OffscreenResponse> {
  return chrome.runtime.sendMessage(message);
}

/** The offscreen document owns the audio graph, so it is the source of truth. */
async function offscreenState(tabId: number): Promise<OffscreenTabState> {
  if (!(await hasOffscreen())) return NOT_CAPTURED;
  const result = await sendOffscreen({ target: "offscreen", type: "getState", tabId });
  if (!result?.captured) return NOT_CAPTURED;
  return {
    captured: true,
    percent: result.percent ?? NATIVE_PERCENT,
    target: result.target ?? NATIVE_TARGET,
    intensity: result.intensity ?? DEFAULT_INTENSITY,
  };
}

/**
 * Gain mode shows the bare percent, compression mode prefixes the target with
 * "T" so the two never read the same. Nothing is shown for a tab we don't hold.
 */
async function setBadge(tabId: number, state: OffscreenTabState): Promise<void> {
  const text = !state.captured
    ? ""
    : settings.compression
      ? `T${state.target}`
      : state.percent === NATIVE_PERCENT
        ? ""
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

async function capture(tabId: number, state: OffscreenTabState): Promise<void> {
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
    compression: settings.compression,
  });
  if (!result?.ok) {
    throw new Error(result?.error ?? "attach failed");
  }
  if (meterTabId !== null) {
    await sendOffscreen({ target: "offscreen", type: "watchMeter", tabId: meterTabId });
  }
}

async function fallBackNative(tabId: number): Promise<void> {
  await detachTab(tabId).catch(() => undefined);
  await closeOffscreenIfEmpty();
  await setBadge(tabId, NOT_CAPTURED);
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
    active: state.captured,
    compression: settings.compression,
    capturable,
    limiter: settings.limiter,
  };
}

async function getState(tabId: number): Promise<TabStateView> {
  const capturable = await tabCapturable(tabId);
  if (!capturable) {
    return view(NOT_CAPTURED, false);
  }
  return view(await offscreenState(tabId), true);
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
  return { ...view(NOT_CAPTURED, true), limiter: enabled };
}

/** Drop the capture for a tab and clear its badge. */
async function release(tabId: number): Promise<TabStateView> {
  const capturable = await tabCapturable(tabId);
  await detachTab(tabId);
  await closeOffscreenIfEmpty();
  await setBadge(tabId, NOT_CAPTURED);
  return view(NOT_CAPTURED, capturable);
}

/**
 * Send one parameter to an attached tab, or capture it first. `update`
 * mutates the state that a fresh capture would start from.
 */
async function pushToTab(
  tabId: number,
  update: (state: OffscreenTabState) => OffscreenTabState,
  message: (state: OffscreenTabState) => OffscreenRequest,
): Promise<TabStateView> {
  try {
    const current = await offscreenState(tabId);
    const next = update(current);
    if (current.captured) {
      const result = await sendOffscreen(message(next));
      if (!result?.ok) throw new Error(result?.error ?? "offscreen update failed");
    } else {
      await capture(tabId, { ...next, captured: true });
    }
    const captured = { ...next, captured: true };
    await setBadge(tabId, captured);
    return view(captured, true);
  } catch {
    await fallBackNative(tabId);
    return view(NOT_CAPTURED, true);
  }
}

async function setGain(tabId: number, percent: number): Promise<TabStateView> {
  const capturable = await tabCapturable(tabId);
  if (!capturable) {
    return view(NOT_CAPTURED, false);
  }
  const snapped = snapPercent(percent);

  // Native is the do-nothing point in gain mode; drop the capture.
  if (snapped === NATIVE_PERCENT && !settings.compression) {
    return release(tabId);
  }

  return pushToTab(
    tabId,
    (state) => ({ ...state, percent: snapped }),
    () => ({ target: "offscreen", type: "setGain", tabId, percent: snapped }),
  );
}

/** Compression mode: touching the target attaches; only Reset detaches. */
async function setTarget(tabId: number, percent: number): Promise<TabStateView> {
  const capturable = await tabCapturable(tabId);
  if (!capturable) {
    return view(NOT_CAPTURED, false);
  }
  const snapped = snapTarget(percent);
  return pushToTab(
    tabId,
    (state) => ({ ...state, target: snapped }),
    () => ({ target: "offscreen", type: "setTarget", tabId, percent: snapped }),
  );
}

async function setIntensity(tabId: number, intensity: number): Promise<TabStateView> {
  const capturable = await tabCapturable(tabId);
  if (!capturable) {
    return view(NOT_CAPTURED, false);
  }
  const clamped = clampIntensity(intensity);
  return pushToTab(
    tabId,
    (state) => ({ ...state, intensity: clamped }),
    () => ({ target: "offscreen", type: "setIntensity", tabId, intensity: clamped }),
  );
}

/**
 * Mode switch. Every attached graph flips who carries the volume. Tabs whose
 * gain is native have nothing left to do once compression is off, so they
 * are released; everything else gets its badge redrawn for the new mode.
 */
async function switchCompression(enabled: boolean): Promise<void> {
  if (!(await hasOffscreen())) return;
  await sendOffscreen({ target: "offscreen", type: "setCompression", enabled });
  const result = await sendOffscreen({ target: "offscreen", type: "listStates" });
  for (const state of result?.states ?? []) {
    if (!enabled && state.percent === NATIVE_PERCENT) {
      await detachTab(state.tabId);
      await setBadge(state.tabId, NOT_CAPTURED);
    } else {
      await setBadge(state.tabId, state);
    }
  }
  await closeOffscreenIfEmpty();
}

async function recapture(tabId: number): Promise<void> {
  const state = await offscreenState(tabId);
  if (!state.captured) return;
  try {
    await detachTab(tabId);
    await capture(tabId, state);
    await setBadge(tabId, state);
  } catch {
    await fallBackNative(tabId);
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
  if (!message || message.target !== "background") return;
  void settingsReady.then(() => dispatch(message)).then(sendResponse);
  return true;
});

async function dispatch(message: BackgroundRequest): Promise<unknown> {
  switch (message.type) {
    case "getState":
      return getState(message.tabId);
    case "setLimiter":
      return setLimiter(message.enabled);
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
    case "release":
      return release(message.tabId);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  needsRecapture.delete(tabId);
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
