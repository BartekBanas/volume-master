import {
  isCapturableUrl,
  NATIVE_PERCENT,
  snapPercent,
  type BackgroundRequest,
  type OffscreenRequest,
  type TabStateView,
} from "./messages.js";

type TabState = { percent: number; touched: boolean };

type RestorableState =
  | typeof chrome.windows.WindowState.NORMAL
  | typeof chrome.windows.WindowState.MAXIMIZED;

const tabs = new Map<number, TabState>();
const needsRecapture = new Set<number>();
const promotedWindows = new Map<number, RestorableState>();
let creatingOffscreen: Promise<void> | null = null;

function view(tabId: number, capturable: boolean): TabStateView {
  const state = tabs.get(tabId);
  return {
    percent: state?.percent ?? NATIVE_PERCENT,
    touched: state?.touched ?? false,
    capturable,
  };
}

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

async function sendOffscreen(
  message: OffscreenRequest,
): Promise<{ ok?: boolean; captured?: boolean; empty?: boolean; error?: string }> {
  return chrome.runtime.sendMessage(message);
}

async function isCaptured(tabId: number): Promise<boolean> {
  if (!(await hasOffscreen())) return false;
  const result = await sendOffscreen({ target: "offscreen", type: "hasTab", tabId });
  return Boolean(result?.captured);
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
  tabs.set(tabId, { percent: NATIVE_PERCENT, touched: true });
  await closeOffscreenIfEmpty();
}

async function updateBadge(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  const state = tabs.get(tab.id);
  if (!state?.touched) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#1c1c24" });
  await chrome.action.setBadgeText({ text: String(state.percent) });
}

async function tabCapturable(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.url) return true;
  return isCapturableUrl(tab.url);
}

async function getState(tabId: number): Promise<TabStateView> {
  const capturable = await tabCapturable(tabId);
  if (!capturable) {
    return { percent: NATIVE_PERCENT, touched: false, capturable: false };
  }
  return view(tabId, true);
}

async function setGain(tabId: number, percent: number): Promise<TabStateView> {
  const capturable = await tabCapturable(tabId);
  if (!capturable) {
    return { percent: NATIVE_PERCENT, touched: false, capturable: false };
  }

  const snapped = snapPercent(percent);

  if (snapped === NATIVE_PERCENT) {
    await detachTab(tabId);
    tabs.set(tabId, { percent: NATIVE_PERCENT, touched: true });
    await closeOffscreenIfEmpty();
    await updateBadge();
    return view(tabId, true);
  }

  try {
    if (await isCaptured(tabId)) {
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
    tabs.set(tabId, { percent: snapped, touched: true });
  } catch {
    await fallBackNative(tabId);
  }

  await updateBadge();
  return view(tabId, true);
}

async function recapture(tabId: number): Promise<void> {
  const state = tabs.get(tabId);
  if (!state || state.percent === NATIVE_PERCENT) return;
  try {
    await detachTab(tabId);
    await capture(tabId, state.percent);
  } catch {
    await fallBackNative(tabId);
    await updateBadge();
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
  tabs.delete(tabId);
  needsRecapture.delete(tabId);
  void (async () => {
    await detachTab(tabId);
    await closeOffscreenIfEmpty();
    await updateBadge();
  })();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) needsRecapture.add(tabId);
  if (info.status !== "complete" || !needsRecapture.has(tabId)) return;
  needsRecapture.delete(tabId);
  void recapture(tabId);
});

chrome.tabs.onActivated.addListener(() => {
  void updateBadge();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void updateBadge();
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

void updateBadge();
