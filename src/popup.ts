import {
  isCapturableUrl,
  MAX_PERCENT,
  NATIVE_PERCENT,
  percentFromPosition,
  positionFromPercent,
  type BackgroundRequest,
  type TabStateView,
} from "./messages.js";

const slider = document.querySelector("#slider") as HTMLInputElement;
const sliderWrap = document.querySelector(".slider-wrap") as HTMLElement;
const readout = document.querySelector("#readout") as HTMLParagraphElement;
const reset = document.querySelector("#reset") as HTMLButtonElement;
const limiter = document.querySelector("#limiter") as HTMLInputElement;
const note = document.querySelector("#note") as HTMLParagraphElement;
const badge = document.querySelector("#badge") as HTMLSpanElement;
const panel = document.querySelector("main") as HTMLElement;

let tabId: number | undefined;

sliderWrap.style.setProperty(
  "--native-ratio",
  String(positionFromPercent(NATIVE_PERCENT) / MAX_PERCENT),
);

type Rgb = [number, number, number];
type Stop = [percent: number, color: Rgb];

// Cold and dim at 0, indigo at native, then yellow -> orange -> red.
const PRIMARY_STOPS: Stop[] = [
  [0, [0x3a, 0x4a, 0x6b]],
  [50, [0x56, 0x6e, 0xb0]],
  [100, [0x7c, 0x8c, 0xff]],
  [200, [0xe8, 0xd2, 0x7a]],
  [450, [0xff, 0x9b, 0x4a]],
  [1000, [0xff, 0x4d, 0x5e]],
];

const SECONDARY_STOPS: Stop[] = [
  [0, [0x2c, 0x3a, 0x58]],
  [50, [0x6a, 0x64, 0xc4]],
  [100, [0xa7, 0x8b, 0xfa]],
  [200, [0xf2, 0xb9, 0x5a]],
  [450, [0xff, 0x6b, 0x4a]],
  [1000, [0xe0, 0x30, 0x4a]],
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

function paintTheme(value: number): void {
  panel.style.setProperty("--fill-a", mixColor(PRIMARY_STOPS, value));
  panel.style.setProperty("--fill-b", mixColor(SECONDARY_STOPS, value));
  // 1 at 0%, 0 at native and above: drives panel darkening.
  const dim = Math.max(0, 1 - value / NATIVE_PERCENT);
  panel.style.setProperty("--dim", dim.toFixed(3));
  // 0 at native, 1 at max: drives glow intensity.
  const heat = Math.max(0, (value - NATIVE_PERCENT) / (MAX_PERCENT - NATIVE_PERCENT));
  panel.style.setProperty("--heat", Math.sqrt(heat).toFixed(3));
}

function badgeLabel(value: number, capturable: boolean): string {
  if (!capturable) return "Unavailable";
  if (value === 0) return "Muted";
  if (value < NATIVE_PERCENT) return "Quiet";
  if (value > NATIVE_PERCENT) return "Boost";
  return "Native";
}

function positionRatio(position: number): number {
  return position / MAX_PERCENT;
}

function setSliderPosition(position: number): void {
  slider.max = String(MAX_PERCENT);
  slider.value = String(position);
  slider.style.setProperty("--ratio", String(positionRatio(position)));
}

function paint(state: TabStateView, syncSlider = true): void {
  if (syncSlider) setSliderPosition(positionFromPercent(state.percent));
  readout.innerHTML = `${state.percent}<span class="unit">%</span>`;
  badge.textContent = badgeLabel(state.percent, state.capturable);
  paintTheme(state.capturable ? state.percent : NATIVE_PERCENT);
  panel.classList.toggle("off", !state.capturable);
  slider.disabled = !state.capturable;
  reset.disabled = !state.capturable;
  limiter.disabled = !state.capturable;
  limiter.checked = state.limiter;
  note.hidden = state.capturable;
}

async function send(request: BackgroundRequest): Promise<TabStateView> {
  return chrome.runtime.sendMessage(request);
}

let pending: number | undefined;
let pendingSync = false;
let sending = false;

async function apply(next: number, syncSlider = false): Promise<void> {
  pending = next;
  pendingSync = pendingSync || syncSlider;
  if (sending) return;
  sending = true;
  while (pending !== undefined && tabId !== undefined) {
    const value = pending;
    const sync = pendingSync;
    pending = undefined;
    pendingSync = false;
    const state = await send({
      target: "background",
      type: "setGain",
      tabId,
      percent: value,
    });
    paint(state, sync);
  }
  sending = false;
}

slider.addEventListener("input", () => {
  const position = Number(slider.value);
  slider.style.setProperty("--ratio", String(positionRatio(position)));
  void apply(percentFromPosition(position));
});

reset.addEventListener("click", () => {
  void apply(NATIVE_PERCENT, true);
});

limiter.addEventListener("change", () => {
  void send({
    target: "background",
    type: "setLimiter",
    enabled: limiter.checked,
  }).then((state) => {
    limiter.checked = state.limiter;
  });
});

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
tabId = tab?.id;
if (tabId === undefined || !isCapturableUrl(tab?.url)) {
  paint({ percent: NATIVE_PERCENT, capturable: false, limiter: true });
} else {
  paint(await send({ target: "background", type: "getState", tabId }));
}
