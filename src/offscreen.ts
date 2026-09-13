import type { OffscreenRequest } from "./messages.js";
import { NATIVE_PERCENT } from "./messages.js";

type Graph = {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  percent: number;
};

const ctx = new AudioContext();
const graphs = new Map<number, Graph>();

function percentToGain(percent: number): number {
  return percent / 100;
}

function rampGain(gain: GainNode, percent: number): void {
  gain.gain.setTargetAtTime(percentToGain(percent), ctx.currentTime, 0.02);
}

async function detach(tabId: number): Promise<void> {
  const graph = graphs.get(tabId);
  if (!graph) return;
  graphs.delete(tabId);
  graph.source.disconnect();
  graph.gain.disconnect();
  for (const track of graph.stream.getTracks()) {
    track.stop();
  }
}

async function attach(tabId: number, streamId: string, percent: number): Promise<void> {
  await detach(tabId);
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as unknown as MediaTrackConstraints,
    video: false,
  });
  const source = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = percentToGain(percent);
  source.connect(gain).connect(ctx.destination);
  graphs.set(tabId, { stream, source, gain, percent });
}

function setGain(tabId: number, percent: number): void {
  const graph = graphs.get(tabId);
  if (!graph) return;
  if (percent === NATIVE_PERCENT) return;
  graph.percent = percent;
  rampGain(graph.gain, percent);
}

function getState(tabId: number): { captured: boolean; percent: number } {
  const graph = graphs.get(tabId);
  return graph
    ? { captured: true, percent: graph.percent }
    : { captured: false, percent: NATIVE_PERCENT };
}

async function handle(message: OffscreenRequest): Promise<unknown> {
  switch (message.type) {
    case "attach":
      await attach(message.tabId, message.streamId, message.percent);
      return { ok: true };
    case "setGain":
      setGain(message.tabId, message.percent);
      return { ok: true };
    case "detach":
      await detach(message.tabId);
      return { ok: true };
    case "getState":
      return { ok: true, ...getState(message.tabId) };
    case "isEmpty":
      return { ok: true, empty: graphs.size === 0 };
  }
}

chrome.runtime.onMessage.addListener((message: OffscreenRequest, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return;
  void handle(message).then(sendResponse, (err: unknown) => {
    const error = err instanceof Error ? err.message : String(err);
    sendResponse({ ok: false, error });
  });
  return true;
});
