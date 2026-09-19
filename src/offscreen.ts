import type { OffscreenRequest, OffscreenTabState, PopupEvent } from "./messages.js";
import { DEFAULT_INTENSITY, NATIVE_PERCENT, NATIVE_TARGET } from "./messages.js";

/**
 * Per-tab graph: source -> gain -> leveler -> limiter -> destination.
 * The leveler is always in the chain and bypassed in gain mode, so a mode
 * switch is a parameter change, not a rewire.
 */
type Graph = {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  leveler: AudioWorkletNode | null;
  limiter: AudioWorkletNode | null;
  /** Gain-mode volume. Retained while compression pins the GainNode at 1.0. */
  percent: number;
  /** Compression-mode target in percent of the reference loudness. */
  target: number;
  intensity: number;
};

/**
 * RMS amplitude that a 100% target aims for. Real programme material sits well
 * below full scale (a full-scale sine is only 0.707 RMS), so aiming at 1.0
 * would pin the leveler at its ceiling. 0.2 is about -14 dBFS, the loudness
 * most streaming services normalise to.
 */
const REFERENCE_RMS = 0.2;

const ctx = new AudioContext();
const graphs = new Map<number, Graph>();

let limiterReady: Promise<boolean> | null = null;
let levelerReady: Promise<boolean> | null = null;
let meterTabId: number | null = null;
let compressionOn = false;

function percentToGain(percent: number): number {
  return percent / 100;
}

function targetToRms(percent: number): number {
  return (percent / 100) * REFERENCE_RMS;
}

function param(node: AudioWorkletNode, name: string): AudioParam | undefined {
  return (node.parameters as unknown as Map<string, AudioParam>).get(name);
}

function rampGain(gain: GainNode, value: number): void {
  gain.gain.setTargetAtTime(value, ctx.currentTime, 0.02);
}

function setBypass(node: AudioWorkletNode, enabled: boolean): void {
  param(node, "bypass")?.setValueAtTime(enabled ? 0 : 1, ctx.currentTime);
}

/** Apply the current mode to one graph: who carries the volume, gain or leveler. */
function applyMode(graph: Graph): void {
  if (compressionOn && graph.leveler) {
    rampGain(graph.gain, 1);
    param(graph.leveler, "target")?.setValueAtTime(targetToRms(graph.target), ctx.currentTime);
    param(graph.leveler, "intensity")?.setValueAtTime(graph.intensity, ctx.currentTime);
    setBypass(graph.leveler, true);
  } else {
    if (graph.leveler) setBypass(graph.leveler, false);
    rampGain(graph.gain, percentToGain(graph.percent));
  }
}

function loadWorklet(file: string): Promise<boolean> {
  return ctx.audioWorklet
    .addModule(chrome.runtime.getURL(file))
    .then(() => true)
    .catch(() => false);
}

async function ensureWorklets(): Promise<{ limiter: boolean; leveler: boolean }> {
  limiterReady ??= loadWorklet("limiter-processor.js");
  levelerReady ??= loadWorklet("leveler-processor.js");
  const [limiter, leveler] = await Promise.all([limiterReady, levelerReady]);
  return { limiter, leveler };
}

const WORKLET_OPTIONS: AudioWorkletNodeOptions = {
  numberOfInputs: 1,
  numberOfOutputs: 1,
  outputChannelCount: [2],
  channelCount: 2,
  channelCountMode: "explicit",
  channelInterpretation: "speakers",
};

function createLimiter(tabId: number): AudioWorkletNode {
  const node = new AudioWorkletNode(ctx, "peak-limiter", WORKLET_OPTIONS);
  node.port.onmessage = (event: MessageEvent<number>) => {
    if (meterTabId !== tabId) return;
    const reduction = event.data;
    if (typeof reduction !== "number" || reduction < 0.003) return;
    const message: PopupEvent = {
      target: "popup",
      type: "limiterMeter",
      tabId,
      reduction,
    };
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  };
  return node;
}

function createLeveler(): AudioWorkletNode {
  return new AudioWorkletNode(ctx, "auto-leveler", WORKLET_OPTIONS);
}

async function detach(tabId: number): Promise<void> {
  const graph = graphs.get(tabId);
  if (!graph) return;
  graphs.delete(tabId);
  graph.source.disconnect();
  graph.gain.disconnect();
  graph.leveler?.disconnect();
  graph.limiter?.disconnect();
  for (const track of graph.stream.getTracks()) {
    track.stop();
  }
}

type AttachOptions = {
  percent: number;
  target: number;
  intensity: number;
  limiter: boolean;
  compression: boolean;
};

async function attach(tabId: number, streamId: string, options: AttachOptions): Promise<void> {
  await detach(tabId);
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
  compressionOn = options.compression;
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
  gain.gain.value = compressionOn ? 1 : percentToGain(options.percent);

  const ready = await ensureWorklets();
  let limiter: AudioWorkletNode | null = null;
  let leveler: AudioWorkletNode | null = null;
  if (ready.limiter) {
    try {
      limiter = createLimiter(tabId);
      setBypass(limiter, options.limiter);
    } catch {
      limiter = null;
    }
  }
  if (ready.leveler) {
    try {
      leveler = createLeveler();
    } catch {
      leveler = null;
    }
  }

  let tail: AudioNode = source.connect(gain);
  if (leveler) tail = tail.connect(leveler);
  if (limiter) tail = tail.connect(limiter);
  tail.connect(ctx.destination);

  const graph: Graph = {
    stream,
    source,
    gain,
    leveler,
    limiter,
    percent: options.percent,
    target: options.target,
    intensity: options.intensity,
  };
  graphs.set(tabId, graph);
  applyMode(graph);
}

function setGain(tabId: number, percent: number): void {
  const graph = graphs.get(tabId);
  if (!graph) return;
  graph.percent = percent;
  if (!compressionOn) rampGain(graph.gain, percentToGain(percent));
}

function setTarget(tabId: number, percent: number): void {
  const graph = graphs.get(tabId);
  if (!graph) return;
  graph.target = percent;
  if (compressionOn && graph.leveler) {
    param(graph.leveler, "target")?.setTargetAtTime(targetToRms(percent), ctx.currentTime, 0.02);
  }
}

function setIntensity(tabId: number, intensity: number): void {
  const graph = graphs.get(tabId);
  if (!graph) return;
  graph.intensity = intensity;
  if (compressionOn && graph.leveler) {
    param(graph.leveler, "intensity")?.setTargetAtTime(intensity, ctx.currentTime, 0.02);
  }
}

function setLimiter(enabled: boolean): void {
  for (const graph of graphs.values()) {
    if (graph.limiter) setBypass(graph.limiter, enabled);
  }
}

function setCompression(enabled: boolean): void {
  compressionOn = enabled;
  for (const graph of graphs.values()) applyMode(graph);
}

function getState(tabId: number): OffscreenTabState {
  const graph = graphs.get(tabId);
  return graph
    ? { captured: true, percent: graph.percent, target: graph.target, intensity: graph.intensity }
    : {
        captured: false,
        percent: NATIVE_PERCENT,
        target: NATIVE_TARGET,
        intensity: DEFAULT_INTENSITY,
      };
}

function listStates(): Array<OffscreenTabState & { tabId: number }> {
  return [...graphs.keys()].map((tabId) => ({ tabId, ...getState(tabId) }));
}

async function handle(message: OffscreenRequest): Promise<unknown> {
  switch (message.type) {
    case "attach":
      await attach(message.tabId, message.streamId, {
        percent: message.percent,
        target: message.targetPercent,
        intensity: message.intensity,
        limiter: message.limiter,
        compression: message.compression,
      });
      return { ok: true };
    case "setGain":
      setGain(message.tabId, message.percent);
      return { ok: true };
    case "setTarget":
      setTarget(message.tabId, message.percent);
      return { ok: true };
    case "setIntensity":
      setIntensity(message.tabId, message.intensity);
      return { ok: true };
    case "setCompression":
      setCompression(message.enabled);
      return { ok: true };
    case "listStates":
      return { ok: true, states: listStates() };
    case "setLimiter":
      setLimiter(message.enabled);
      return { ok: true };
    case "detach":
      await detach(message.tabId);
      return { ok: true };
    case "getState":
      return { ok: true, ...getState(message.tabId) };
    case "isEmpty":
      return { ok: true, empty: graphs.size === 0 };
    case "watchMeter":
      meterTabId = message.tabId;
      return { ok: true };
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
