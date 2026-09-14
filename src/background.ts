import {
  isCapturableUrl,
  NATIVE_PERCENT,
  snapPercent,
  type BackgroundRequest,
  type OffscreenRequest,
  type OffscreenTabState,
  type TabStateView,
} from "./messages.js";

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
let limiterEnabled = true;
let meterTabId: number | null = null;

const BADGE_COLOR = "#1c1c24";

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

async function sendOffscreen(message: OffscreenRequest): Promise<{
  ok?: boolean;
  captured?: boolean;
  percent?: number;
  empty?: boolean;
  error?: string;
}> {
  return chrome.runtime.sendMessage(message);
}

/** The offscreen document owns the audio graph, so it is the source of truth. */
async function offscreenState(tabId: number): Promise<OffscreenTabState> {
  if (!(await hasOffscreen())) return { captured: false, percent: NATIVE_PERCENT };
  const result = await sendOffscreen({ target: "offscreen", type: "getState", tabId });
  if (!result?.captured) return { captured: false, percent: NATIVE_PERCENT };
  return { captured: true, percent: result.percent ?? NATIVE_PERCENT };
}

async function setBadge(tabId: number, percent: number): Promise<void> {
  if (percent === NATIVE_PERCENT) {
    await chrome.action.setBadgeText({ text: "", tabId }).catch(() => undefined);
    return;
  }
  await chrome.action
    .setBadgeBackgroundColor({ color: BADGE_COLOR, tabId })
    .catch(() => undefined);
  await chrome.action.setBadgeText({ text: String(percent), tabId }).catch(() => undefined);
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

async function capture(tabId: number, percent: number): Promise<void> {
  await ensureOffscreen();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const result = await sendOffscreen({
    target: "offscreen",
    type: "attach",
    tabId,
    streamId,
    percent,
    limiter: limiterEnabled,
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
  await setBadge(tabId, NATIVE_PERCENT);
}

async function tabCapturable(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.url) return true;
  return isCapturableUrl(tab.url);
}

function view(percent: number, capturable: boolean): TabStateView {
  return { percent, capturable, limiter: limiterEnabled };
}

async function getState(tabId: number): Promise<TabStateView> {
  const capturable = await tabCapturable(tabId);
  if (!capturable) {
    return view(NATIVE_PERCENT, false);
  }
  const state = await offscreenState(tabId);
  return view(state.percent, true);
}

async function watchMeter(tabId: number | null): Promise<void> {
  meterTabId = tabId;
  if (await hasOffscreen()) {
    await sendOffscreen({ target: "offscreen", type: "watchMeter", tabId });
  }
}

async function setLimiter(enabled: boolean): Promise<TabStateView> {
  limiterEnabled = enabled;
  if (await hasOffscreen()) {
    await sendOffscreen({ target: "offscreen", type: "setLimiter", enabled });
  }
  return view(NATIVE_PERCENT, true);
}

async function setGain(tabId: number, percent: number): Promise<TabStateView> {
  const capturable = await tabCapturable(tabId);
  if (!capturable) {
    return view(NATIVE_PERCENT, false);
  }

  const snapped = snapPercent(percent);

  if (snapped === NATIVE_PERCENT) {
    await detachTab(tabId);
    await closeOffscreenIfEmpty();
    await setBadge(tabId, NATIVE_PERCENT);
    return view(NATIVE_PERCENT, true);
  }

  try {
    const current = await offscreenState(tabId);
    if (current.captured) {
      const result = await sendOffscreen({
        target: "offscreen",
        type: "setGain",
        tabId,
        percent: snapped,
      });
      if (!result?.ok) throw new Error(result?.error ?? "setGain failed");
    } else {
      await capture(tabId, snapped);
    }
    await setBadge(tabId, snapped);
    return view(snapped, true);
  } catch {
    await fallBackNative(tabId);
    return view(NATIVE_PERCENT, true);
  }
}

async function recapture(tabId: number): Promise<void> {
  const state = await offscreenState(tabId);
  if (!state.captured) return;
  try {
    await detachTab(tabId);
    await capture(tabId, state.percent);
    await setBadge(tabId, state.percent);
  } catch {
    await fallBackNative(tabId);
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
  if (!message || message.target !== "background") return;
  const task =
    message.type === "getState"
      ? getState(message.tabId)
      : message.type === "setLimiter"
        ? setLimiter(message.enabled)
        : message.type === "watchMeter"
          ? watchMeter(message.tabId)
          : message.type === "unwatchMeter"
            ? watchMeter(null)
            : setGain(message.tabId, message.percent);
  void task.then(sendResponse);
  return true;
});

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
