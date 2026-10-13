import {
  clampIntensity,
  DEFAULT_INTENSITY,
  DEFAULT_TARGET,
  NATIVE_PERCENT,
  snapPercent,
  snapTarget,
  type TabSettings,
} from "./messages.js";

export const DEFAULT_TAB_SETTINGS: TabSettings = {
  percent: NATIVE_PERCENT,
  target: DEFAULT_TARGET,
  intensity: DEFAULT_INTENSITY,
  compression: false,
};

/**
 * Per-tab values, remembered across Bypassed so turning it off re-applies them.
 * chrome.storage.session survives a service-worker restart, not a browser quit.
 */
const STORAGE_KEY = "tabSettings";
const byTab = new Map<number, TabSettings>();

function normalize(raw: unknown): TabSettings {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    percent: snapPercent(Number(value.percent ?? DEFAULT_TAB_SETTINGS.percent)),
    target: snapTarget(Number(value.target ?? DEFAULT_TAB_SETTINGS.target)),
    intensity: clampIntensity(Number(value.intensity ?? DEFAULT_TAB_SETTINGS.intensity)),
    compression: value.compression === true,
  };
}

export const tabSettingsReady: Promise<void> = chrome.storage.session
  .get(STORAGE_KEY)
  .catch(() => ({}) as Record<string, unknown>)
  .then((stored) => {
    const value = stored[STORAGE_KEY];
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      const tabId = Number(key);
      if (Number.isInteger(tabId)) byTab.set(tabId, normalize(entry));
    }
  });

async function persist(): Promise<void> {
  await chrome.storage.session
    .set({ [STORAGE_KEY]: Object.fromEntries(byTab) })
    .catch(() => undefined);
}

/** Call only after tabSettingsReady. */
export function getTabSettings(tabId: number): TabSettings {
  return byTab.get(tabId) ?? DEFAULT_TAB_SETTINGS;
}

export async function patchTabSettings(
  tabId: number,
  patch: Partial<TabSettings>,
): Promise<TabSettings> {
  await tabSettingsReady;
  const next = { ...getTabSettings(tabId), ...patch };
  byTab.set(tabId, next);
  await persist();
  return next;
}

export async function forgetTab(tabId: number): Promise<void> {
  await tabSettingsReady;
  if (!byTab.delete(tabId)) return;
  await persist();
}
