import type { VolumeUnit } from "./messages.js";

export type Granularity = "off" | "on";

export type Settings = {
  unit: VolumeUnit;
  granularity: Granularity;
  limiter: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  unit: "percent",
  granularity: "off",
  limiter: true,
};

const STORAGE_KEY = "settings";
/** Pre-0.3 the popup kept the unit in localStorage under this key. */
const LEGACY_UNIT_KEY = "volume-master.unit";

function normalizeGranularity(value: Record<string, unknown>): Granularity {
  if (value.granularity === "on" || value.granularity === "off") {
    return value.granularity;
  }
  // Legacy: boolean toggle or multi-level enum all map to on.
  if (value.granular === true) return "on";
  if (
    value.granularity === "small" ||
    value.granularity === "medium" ||
    value.granularity === "large"
  ) {
    return "on";
  }
  return DEFAULT_SETTINGS.granularity;
}

function normalize(raw: unknown): Settings {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    unit: value.unit === "db" ? "db" : DEFAULT_SETTINGS.unit,
    granularity: normalizeGranularity(value),
    limiter: typeof value.limiter === "boolean" ? value.limiter : DEFAULT_SETTINGS.limiter,
  };
}

export async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.local
    .get(STORAGE_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  return normalize(stored[STORAGE_KEY]);
}

/** Read-merge-write. Concurrent writers from different contexts can race; last write wins. */
export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalize({ ...(await readSettings()), ...patch });
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** Fires with the full settings object whenever any field changes. Returns an unsubscribe. */
export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== "local") return;
    const change = changes[STORAGE_KEY];
    if (!change) return;
    listener(normalize(change.newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/**
 * Popup only. Moves the old localStorage unit into chrome.storage.local once,
 * then deletes the old key. No-op when there is nothing to migrate.
 */
export async function migrateLegacyUnit(): Promise<void> {
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY_UNIT_KEY);
  } catch {
    return;
  }
  if (legacy === null) return;
  const unit: VolumeUnit = legacy === "db" ? "db" : "percent";
  await writeSettings({ unit });
  localStorage.removeItem(LEGACY_UNIT_KEY);
}
