const THRESHOLD = 0.99;
const LOOKAHEAD_SEC = 0.005;
const RELEASE_SEC = 0.05;
const METER_BLOCKS = 16;

class PeakLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "bypass",
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();
    this.delaySamples = Math.max(1, Math.round(LOOKAHEAD_SEC * sampleRate));
    this.writeIndex = 0;
    this.envelope = 0;
    this.buffers = [];
    this.releaseCoeff = Math.exp(-1 / (RELEASE_SEC * sampleRate));
    this.peakReduction = 0;
    this.meterBlocks = 0;
  }

  ensureBuffers(channels) {
    while (this.buffers.length < channels) {
      this.buffers.push(new Float32Array(this.delaySamples));
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || input.length === 0 || output.length === 0) {
      return true;
    }

    const inputChannel = input[0];
    const outputChannel = output[0];
    if (!inputChannel || !outputChannel) return true;

    const frames = outputChannel.length;
    const channelCount = Math.min(input.length, output.length);
    this.ensureBuffers(channelCount);

    const bypass = (parameters.bypass[0] ?? 0) >= 0.5;
    const delay = this.delaySamples;
    const coeff = this.releaseCoeff;
    const threshold = THRESHOLD;

    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let c = 0; c < channelCount; c++) {
        const samples = input[c];
        const x = samples ? samples[i] ?? 0 : 0;
        const ax = x < 0 ? -x : x;
        if (ax > peak) peak = ax;
      }

      if (peak > this.envelope) {
        this.envelope = peak;
      } else {
        this.envelope = peak + coeff * (this.envelope - peak);
      }

      let gain = 1;
      if (!bypass && this.envelope > threshold) {
        gain = threshold / this.envelope;
        const reduction = 1 - gain;
        if (reduction > this.peakReduction) this.peakReduction = reduction;
      }

      const idx = this.writeIndex;
      for (let c = 0; c < channelCount; c++) {
        const samples = input[c];
        const dest = output[c];
        if (!dest) continue;
        const x = samples ? samples[i] ?? 0 : 0;
        const delayed = this.buffers[c][idx] ?? 0;
        this.buffers[c][idx] = x;
        let y = bypass ? delayed : delayed * gain;
        if (!bypass) {
          if (y > 1) y = 1;
          else if (y < -1) y = -1;
        }
        dest[i] = y;
      }

      this.writeIndex = idx + 1 === delay ? 0 : idx + 1;
    }

    this.meterBlocks += 1;
    if (this.meterBlocks >= METER_BLOCKS) {
      this.port.postMessage(this.peakReduction);
      this.peakReduction = 0;
      this.meterBlocks = 0;
    }

    return true;
  }
}

registerProcessor("peak-limiter", PeakLimiterProcessor);
