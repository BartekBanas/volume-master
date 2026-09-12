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

let tabId: number | undefined;
let percent = NATIVE_PERCENT;

function formatPercent(value: number): string {
  return `${value}%`;
}

function paint(state: TabStateView): void {
  percent = state.percent;
  slider.max = String(MAX_PERCENT);
  slider.value = String(state.percent);
  slider.step = String(sliderStep(state.percent));
  readout.textContent = formatPercent(state.percent);
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
