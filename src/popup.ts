import {
  dbFromPercent,
  DEFAULT_INTENSITY,
  formatDb,
  isCapturableUrl,
  MAX_PERCENT,
  MAX_TARGET,
  NATIVE_PERCENT,
  NATIVE_TARGET,
  percentFromPosition,
  positionFromPercent,
  type BackgroundRequest,
  type PopupEvent,
  type TabStateView,
  type VolumeUnit,
} from "./messages.js";
import { ArcKnob } from "./knob.js";
import {
  DEFAULT_SETTINGS,
  migrateLegacyUnit,
  onSettingsChanged,
  readSettings,
  writeSettings,
  type Settings,
} from "./settings.js";

const slider = document.querySelector("#slider") as HTMLInputElement;
const sliderWrap = document.querySelector(".slider-wrap") as HTMLElement;
const knobHost = document.querySelector("#knob") as HTMLElement;
const readout = document.querySelector("#readout") as HTMLParagraphElement;
const readoutLabel = document.querySelector("#readout-label") as HTMLParagraphElement;
const reset = document.querySelector("#reset") as HTMLButtonElement;
const limiter = document.querySelector("#limiter") as HTMLInputElement;
const limiterChip = document.querySelector(".limiter") as HTMLElement;
const note = document.querySelector("#note") as HTMLParagraphElement;
const badge = document.querySelector("#badge") as HTMLSpanElement;
const panel = document.querySelector("main") as HTMLElement;
const unitSwitch = document.querySelector(".unit-switch") as HTMLElement;
const unitPercent = document.querySelector("#unit-percent") as HTMLButtonElement;
const unitDb = document.querySelector("#unit-db") as HTMLButtonElement;
const tickMin = document.querySelector("#tick-min") as HTMLSpanElement;
const tickNative = document.querySelector("#tick-native") as HTMLSpanElement;
const tickMax = document.querySelector("#tick-max") as HTMLSpanElement;
const settingsToggle = document.querySelector("#settings-toggle") as HTMLButtonElement;
const mainView = document.querySelector("#main-view") as HTMLElement;
const settingsView = document.querySelector("#settings-view") as HTMLElement;
const compressionInput = document.querySelector("#compression") as HTMLInputElement;
const granularInput = document.querySelector("#granular") as HTMLInputElement;

let tabId: number | undefined;
let settings: Settings = DEFAULT_SETTINGS;
let unit: VolumeUnit = settings.unit;

const UNAVAILABLE: TabStateView = {
  percent: NATIVE_PERCENT,
  target: NATIVE_TARGET,
  intensity: DEFAULT_INTENSITY,
  active: false,
  compression: false,
  capturable: false,
  limiter: true,
};
/** Last state the background reported; repainted on unit and mode changes. */
let last: TabStateView = UNAVAILABLE;

function compressionOn(): boolean {
  return last.compression;
}

/* theme */

type Rgb = [number, number, number];
type Stop = [percent: number, color: Rgb];

// Gain mode: cold and dim at 0, indigo at native, then yellow -> orange -> red.
const PRIMARY_STOPS: Stop[] = [
  [0, [0x3a, 0x4a, 0x6b]],
  [50, [0x56, 0x6e, 0xb0]],
  [100, [0x7c, 0x8c, 0xff]],
  [200, [0xe8, 0xd2, 0x7a]],
  [450, [0xff, 0x9b, 0x4a]],
  [1000, [0xff, 0x4d, 0x5e]],
  [2000, [0xf0, 0x22, 0x50]],
];

const SECONDARY_STOPS: Stop[] = [
  [0, [0x2c, 0x3a, 0x58]],
  [50, [0x6a, 0x64, 0xc4]],
  [100, [0xa7, 0x8b, 0xfa]],
  [200, [0xf2, 0xb9, 0x5a]],
  [450, [0xff, 0x6b, 0x4a]],
  [1000, [0xe0, 0x30, 0x4a]],
  [2000, [0xb8, 0x10, 0x40]],
];

// Compression mode: a teal family over 0..100 so the mode reads differently at a glance.
const TARGET_PRIMARY_STOPS: Stop[] = [
  [0, [0x2f, 0x4f, 0x55]],
  [50, [0x38, 0x9c, 0x94]],
  [100, [0x4a, 0xd4, 0xc0]],
];

const TARGET_SECONDARY_STOPS: Stop[] = [
  [0, [0x2a, 0x40, 0x60]],
  [50, [0x3f, 0x8c, 0xc8]],
  [100, [0x6a, 0xb8, 0xff]],
];

function mixColor(stops: readonly Stop[], value: number): string {
  let lo: Stop = stops[0] ?? [0, [0, 0, 0]];
  let hi: Stop = lo;
  for (const stop of stops) {
    if (stop[0] <= value) lo = stop;
    hi = stop;
    if (stop[0] >= value) break;
  }
  const span = hi[0] - lo[0];
  const t = span === 0 ? 0 : (value - lo[0]) / span;
  const lerp = (i: 0 | 1 | 2) => Math.round(lo[1][i] + (hi[1][i] - lo[1][i]) * t);
  return `rgb(${lerp(0)} ${lerp(1)} ${lerp(2)})`;
}

function paintGainTheme(value: number): void {
  panel.style.setProperty("--fill-a", mixColor(PRIMARY_STOPS, value));
  panel.style.setProperty("--fill-b", mixColor(SECONDARY_STOPS, value));
  // 1 at 0%, 0 at native and above: drives panel darkening.
  const dim = Math.max(0, 1 - value / NATIVE_PERCENT);
  panel.style.setProperty("--dim", dim.toFixed(3));
  // 0 at native, 1 at max: drives glow intensity.
  const heat = Math.max(0, (value - NATIVE_PERCENT) / (MAX_PERCENT - NATIVE_PERCENT));
  panel.style.setProperty("--heat", heat.toFixed(3));
}

/** Nothing exceeds full scale in compression mode, so there is no heat. */
function paintTargetTheme(target: number): void {
  panel.style.setProperty("--fill-a", mixColor(TARGET_PRIMARY_STOPS, target));
  panel.style.setProperty("--fill-b", mixColor(TARGET_SECONDARY_STOPS, target));
  panel.style.setProperty("--dim", Math.max(0, 1 - target / MAX_TARGET).toFixed(3));
  panel.style.setProperty("--heat", "0");
}

function badgeLabel(state: TabStateView): string {
  if (!state.capturable) return "Unavailable";
  if (compressionOn()) {
    if (!state.active) return "Idle";
    if (state.intensity === 0) return "Passthrough";
    return "Leveling";
  }
  if (state.percent === 0) return "Muted";
  if (state.percent < NATIVE_PERCENT) return "Quiet";
  if (state.percent > NATIVE_PERCENT) return "Boost";
  return "Native";
}

/* slider domain */

function sliderMax(): number {
  return compressionOn() ? MAX_TARGET : MAX_PERCENT;
}

function positionRatio(position: number): number {
  return position / sliderMax();
}

/** Slider value for a state: linear target in compression mode, gamma position otherwise. */
function positionFor(state: TabStateView): number {
  return compressionOn() ? state.target : positionFromPercent(state.percent);
}

function valueFromPosition(position: number): number {
  return compressionOn() ? Math.round(position) : percentFromPosition(position);
}

function setSliderPosition(position: number): void {
  slider.max = String(sliderMax());
  slider.value = String(position);
  slider.style.setProperty("--ratio", String(positionRatio(position)));
}

/** Mode-dependent chrome around the slider: knob, tick labels, anchor position. */
function paintMode(remapSlider = false): void {
  const compression = compressionOn();
  sliderWrap.classList.toggle("compression", compression);
  knobHost.hidden = !compression;
  readoutLabel.hidden = !compression;
  sliderWrap.style.setProperty(
    "--native-ratio",
    compression ? "0.5" : String(positionFromPercent(NATIVE_PERCENT) / MAX_PERCENT),
  );
  slider.max = String(sliderMax());
  if (remapSlider) {
    setSliderPosition(positionFor(last));
  } else {
    slider.style.setProperty("--ratio", String(positionRatio(Number(slider.value))));
  }
  paintUnitLabels();
}

function paintUnitLabels(): void {
  const db = unit === "db";
  if (compressionOn()) {
    tickMin.textContent = db ? "−∞" : "0";
    tickNative.textContent = db ? formatDb(50) : "50";
    tickMax.textContent = db ? "0" : String(MAX_TARGET);
    readoutLabel.textContent = db ? "Target dB" : "Target Volume";
    reset.textContent = db ? "Reset to 0 dB" : "Reset to 100%";
    slider.setAttribute("aria-label", db ? "Target volume in decibels" : "Target volume");
    return;
  }
  tickMin.textContent = db ? "−∞" : "0";
  tickNative.textContent = db ? "0" : "100";
  tickMax.textContent = db ? `+${Math.round(dbFromPercent(MAX_PERCENT))}` : String(MAX_PERCENT);
  reset.textContent = db ? "Reset to 0 dB" : "Reset to 100%";
  slider.setAttribute("aria-label", db ? "Volume in decibels" : "Volume");
}

/** Paint the unit into every control that shows it. Does not persist. */
function setUnit(next: VolumeUnit): void {
  unit = next;
  unitSwitch.dataset.unit = next;
  unitPercent.setAttribute("aria-pressed", String(next === "percent"));
  unitDb.setAttribute("aria-pressed", String(next === "db"));
  paintUnitLabels();
}

function paintReadout(value: number): void {
  if (unit === "db") {
    readout.innerHTML = `${formatDb(value)}<span class="unit">dB</span>`;
    return;
  }
  readout.innerHTML = `${value}<span class="unit">%</span>`;
}

function paint(state: TabStateView, syncSlider = true): void {
  last = state;
  compressionInput.checked = state.compression;
  compressionInput.disabled = !state.capturable;
  paintMode(syncSlider);
  const compression = compressionOn();
  const value = compression ? state.target : state.percent;
  if (syncSlider) {
    knob.set(state.intensity);
  }
  paintReadout(value);
  badge.textContent = badgeLabel(state);
  if (compression) paintTargetTheme(state.capturable ? value : NATIVE_TARGET);
  else paintGainTheme(state.capturable ? value : NATIVE_PERCENT);
  panel.classList.toggle("off", !state.capturable);
  slider.disabled = !state.capturable;
  knob.disabled = !state.capturable;
  reset.disabled = !state.capturable;
  limiter.disabled = !state.capturable;
  limiter.checked = state.limiter;
  note.hidden = state.capturable;
  if (!state.capturable || !state.limiter) setClip(0);
}

/* messaging */

async function send(request: BackgroundRequest): Promise<TabStateView> {
  return chrome.runtime.sendMessage(request);
}

type RequestFor = (tabId: number) => BackgroundRequest;

let pending: RequestFor | undefined;
let pendingSync = false;
let sending = false;

/** Coalesce rapid input: only the newest request is sent once the previous one returns. */
async function apply(build: RequestFor, syncSlider = false): Promise<void> {
  pending = build;
  pendingSync = pendingSync || syncSlider;
  if (sending) return;
  sending = true;
  while (pending !== undefined && tabId !== undefined) {
    const request = pending(tabId);
    const sync = pendingSync;
    pending = undefined;
    pendingSync = false;
    const state = await send(request);
    paint(state, sync);
  }
  sending = false;
}

slider.addEventListener("input", () => {
  const position = Number(slider.value);
  slider.style.setProperty("--ratio", String(positionRatio(position)));
  const value = valueFromPosition(position);
  if (compressionOn()) {
    void apply((id) => ({ target: "background", type: "setTarget", tabId: id, percent: value }));
  } else {
    void apply((id) => ({ target: "background", type: "setGain", tabId: id, percent: value }));
  }
});

const knob = new ArcKnob(knobHost, {
  label: "Leveling intensity",
  onInput: (value) => {
    void apply((id) => ({ target: "background", type: "setIntensity", tabId: id, intensity: value }));
  },
});

reset.addEventListener("click", () => {
  if (compressionOn()) {
    void apply((id) => ({ target: "background", type: "release", tabId: id }), true);
  } else {
    void apply(
      (id) => ({ target: "background", type: "setGain", tabId: id, percent: NATIVE_PERCENT }),
      true,
    );
  }
});

/* settings */

function chooseUnit(next: VolumeUnit): void {
  setUnit(next);
  paintReadout(valueFromSlider());
  void writeSettings({ unit: next });
}

unitPercent.addEventListener("click", () => chooseUnit("percent"));
unitDb.addEventListener("click", () => chooseUnit("db"));

compressionInput.addEventListener("change", () => {
  last = { ...last, compression: compressionInput.checked };
  paintMode(true);
  void apply(
    (id) => ({
      target: "background",
      type: "setCompression",
      tabId: id,
      enabled: compressionInput.checked,
    }),
    true,
  );
});

granularInput.addEventListener("change", () => {
  void writeSettings({ granular: granularInput.checked });
});

function showSettings(open: boolean): void {
  settingsToggle.setAttribute("aria-expanded", String(open));
  settingsToggle.setAttribute("aria-label", open ? "Back" : "Settings");
  mainView.hidden = open;
  settingsView.hidden = !open;
}

settingsToggle.addEventListener("click", () => {
  showSettings(settingsToggle.getAttribute("aria-expanded") !== "true");
});

/** Reflect the persisted settings in the settings view and the mode-dependent main view. */
function applySettings(next: Settings): void {
  settings = next;
  granularInput.checked = next.granular;
  if (next.unit !== unit) {
    setUnit(next.unit);
    paintReadout(valueFromSlider());
  }
}

function valueFromSlider(): number {
  return valueFromPosition(Number(slider.value));
}

limiter.addEventListener("change", () => {
  if (!limiter.checked) setClip(0);
  void send({
    target: "background",
    type: "setLimiter",
    enabled: limiter.checked,
  }).then((state) => {
    limiter.checked = state.limiter;
    if (!state.limiter) setClip(0);
  });
});

/* limiter clip meter */

const motionOk = !matchMedia("(prefers-reduced-motion: reduce)").matches;
let clipShown = 0;
let clipPeak = 0;
let clipRaf = 0;

function setClip(value: number): void {
  if (value <= 0) {
    clipShown = 0;
    clipPeak = 0;
    if (clipRaf) {
      cancelAnimationFrame(clipRaf);
      clipRaf = 0;
    }
  }
  limiterChip.style.setProperty("--clip", value.toFixed(3));
}

function tickClip(): void {
  if (clipPeak > clipShown) clipShown = clipPeak;
  else clipShown *= 0.82;
  clipPeak *= 0.7;
  if (clipShown < 0.008 && clipPeak < 0.008) {
    clipShown = 0;
    clipPeak = 0;
    clipRaf = 0;
    setClip(0);
    return;
  }
  setClip(clipShown);
  clipRaf = requestAnimationFrame(tickClip);
}

function bumpClip(reduction: number): void {
  if (!motionOk || !limiter.checked) return;
  const visual = Math.sqrt(Math.min(1, Math.max(0, reduction)));
  clipPeak = Math.max(clipPeak, visual);
  if (!clipRaf) clipRaf = requestAnimationFrame(tickClip);
}

/* startup */

await migrateLegacyUnit();
settings = await readSettings();
setUnit(settings.unit);
granularInput.checked = settings.granular;
onSettingsChanged(applySettings);
requestAnimationFrame(() => unitSwitch.classList.add("ready"));

chrome.runtime.onMessage.addListener((message: PopupEvent) => {
  if (message?.target !== "popup" || message.type !== "limiterMeter") return;
  if (message.tabId !== tabId) return;
  bumpClip(message.reduction);
});

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
tabId = tab?.id;
if (tabId === undefined || !isCapturableUrl(tab?.url)) {
  paint({ ...UNAVAILABLE, limiter: settings.limiter });
} else {
  paint(await send({ target: "background", type: "getState", tabId }));
  void chrome.runtime.sendMessage({
    target: "background",
    type: "watchMeter",
    tabId,
  }).catch(() => undefined);
}

window.addEventListener("pagehide", () => {
  void chrome.runtime.sendMessage({ target: "background", type: "unwatchMeter" }).catch(
    () => undefined,
  );
});
