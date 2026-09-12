import {
  isCapturableUrl,
  MAX_PERCENT,
  NATIVE_PERCENT,
  nextPercent,
  sliderStep,
  type BackgroundRequest,
  type TabStateView,
} from "./messages.js";

const slider = document.querySelector("#slider") as HTMLInputElement;
const readout = document.querySelector("#readout") as HTMLParagraphElement;
const reset = document.querySelector("#reset") as HTMLButtonElement;
const note = document.querySelector("#note") as HTMLParagraphElement;
const badge = document.querySelector("#badge") as HTMLSpanElement;
const panel = document.querySelector("main") as HTMLElement;

let tabId: number | undefined;
let percent = NATIVE_PERCENT;

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

function paint(state: TabStateView): void {
  percent = state.percent;
  slider.max = String(MAX_PERCENT);
  slider.value = String(state.percent);
  slider.step = String(sliderStep(state.percent));
  slider.style.setProperty("--pct", `${(state.percent / MAX_PERCENT) * 100}%`);
  readout.innerHTML = `${state.percent}<span class="unit">%</span>`;
  badge.textContent = badgeLabel(state.percent, state.capturable);
  paintTheme(state.capturable ? state.percent : NATIVE_PERCENT);
  panel.classList.toggle("off", !state.capturable);
  slider.disabled = !state.capturable;
  reset.disabled = !state.capturable;
  note.hidden = state.capturable;
}

async function send(request: BackgroundRequest): Promise<TabStateView> {
  return chrome.runtime.sendMessage(request);
}

let pending: number | undefined;
let sending = false;

async function apply(next: number): Promise<void> {
  pending = next;
  if (sending) return;
  sending = true;
  while (pending !== undefined && tabId !== undefined) {
    const value = pending;
    pending = undefined;
    const state = await send({
      target: "background",
      type: "setGain",
      tabId,
      percent: value,
    });
    paint(state);
  }
  sending = false;
}

slider.addEventListener("input", () => {
  const next = nextPercent(percent, Number(slider.value));
  void apply(next);
});

reset.addEventListener("click", () => {
  void apply(NATIVE_PERCENT);
});

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
tabId = tab?.id;
if (tabId === undefined || !isCapturableUrl(tab?.url)) {
  paint({ percent: NATIVE_PERCENT, touched: false, capturable: false });
} else {
  paint(await send({ target: "background", type: "getState", tabId }));
}
