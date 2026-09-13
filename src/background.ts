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
const promotedWindows = new Map<number, RestorableState>();
let creatingOffscreen: Promise<void> | null = null;

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
  });
  if (!result?.ok) {
    throw new Error(result?.error ?? "attach failed");
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

async function getState(tabId: number): Promise<TabStateView> {
  const capturable = await tabCapturable(tabId);
  if (!capturable) {
    return { percent: NATIVE_PERCENT, capturable: false };
  }
  const state = await offscreenState(tabId);
  return { percent: state.percent, capturable: true };
}

async function setGain(tabId: number, percent: number): Promise<TabStateView> {
  const capturable = await tabCapturable(tabId);
  if (!capturable) {
    return { percent: NATIVE_PERCENT, capturable: false };
  }

  const snapped = snapPercent(percent);

  if (snapped === NATIVE_PERCENT) {
    await detachTab(tabId);
    await closeOffscreenIfEmpty();
    await setBadge(tabId, NATIVE_PERCENT);
    return { percent: NATIVE_PERCENT, capturable: true };
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
    return { percent: snapped, capturable: true };
  } catch {
    await fallBackNative(tabId);
    return { percent: NATIVE_PERCENT, capturable: true };
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

async function restorePromotedWindow(windowId: number): Promise<void> {
  const prior = promotedWindows.get(windowId);
  if (!prior) return;
  promotedWindows.delete(windowId);
  await chrome.windows.update(windowId, { state: prior }).catch(() => undefined);
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

  const win = await chrome.windows.get(windowId).catch(() => undefined);
  if (!win || win.state === "fullscreen") return;

  promotedWindows.set(windowId, restorableState(win.state));
  await chrome.windows
    .update(windowId, { state: "fullscreen" })
    .catch(() => undefined);
}

chrome.tabCapture.onStatusChanged.addListener((info) => {
  void syncWindowFullscreen(info.tabId, info.fullscreen, info.status);
});
