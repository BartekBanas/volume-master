/**
 * Auto-leveler: measures 400 ms K-weighted loudness and adjusts gain toward
 * the target. It sits before the peak limiter, which catches overshoots.
 *
 * Parameters (all k-rate):
 *   target    linear level equivalent for the target LUFS; 0 mutes.
 *   intensity 0 = unity gain, 1 = full leveling.
 *   bypass    >= 0.5 passes audio through untouched.
 */
const MOMENTARY_SEC = 0.4;
const NOISE_FLOOR_LUFS = -60;
const MAX_GAIN_DB = 36;
const MIN_GAIN_DB = 20 * Math.log10(0.05);
const ATTACK_SEC = 0.12;
const RELEASE_SEC = 0.9;

function makeKWeightingFilters(rate) {
  const shelfFrequency = 1681.974450955533;
  const shelfGain = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const shelfK = Math.tan(Math.PI * shelfFrequency / rate);
  const shelfHigh = 10 ** (shelfGain / 20);
  const shelfMid = shelfHigh ** 0.4996667741545416;
  const shelfA0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  const shelf = {
    b0: (shelfHigh + shelfMid * shelfK / shelfQ + shelfK * shelfK) / shelfA0,
    b1: 2 * (shelfK * shelfK - shelfHigh) / shelfA0,
    b2: (shelfHigh - shelfMid * shelfK / shelfQ + shelfK * shelfK) / shelfA0,
    a1: 2 * (shelfK * shelfK - 1) / shelfA0,
    a2: (1 - shelfK / shelfQ + shelfK * shelfK) / shelfA0,
  };

  const highPassFrequency = 38.13547087602444;
  const highPassQ = 0.5003270373238773;
  const highPassK = Math.tan(Math.PI * highPassFrequency / rate);
  const highPassA0 = 1 + highPassK / highPassQ + highPassK * highPassK;
  const highPass = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: 2 * (highPassK * highPassK - 1) / highPassA0,
    a2: (1 - highPassK / highPassQ + highPassK * highPassK) / highPassA0,
  };
  return { shelf, highPass };
}

function filterSample(sample, coefficients, state) {
  const output = coefficients.b0 * sample + state.z1;
  state.z1 = coefficients.b1 * sample - coefficients.a1 * output + state.z2;
  state.z2 = coefficients.b2 * sample - coefficients.a2 * output;
  return output;
}

function makeChannelFilters() {
  return {
    shelf: { z1: 0, z2: 0 },
    highPass: { z1: 0, z2: 0 },
  };
}

class AutoLevelerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "target",
        defaultValue: 0.18,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate",
      },
      {
        name: "intensity",
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate",
      },
      {
        name: "bypass",
        defaultValue: 1,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();
    const quantumSec = 128 / sampleRate;
    this.attackCoeff = Math.exp(-quantumSec / ATTACK_SEC);
    this.releaseCoeff = Math.exp(-quantumSec / RELEASE_SEC);
    this.filters = makeKWeightingFilters(sampleRate);
    this.channelFilters = [];
    this.windowFrames = Math.round(sampleRate * MOMENTARY_SEC);
    this.energyHistory = new Float64Array(this.windowFrames);
    this.energyIndex = 0;
    this.energyFrames = 0;
    this.windowEnergy = 0;
    this.gain = 1;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || input.length === 0 || output.length === 0) {
      return true;
    }
    const outputChannel = output[0];
    if (!outputChannel) return true;

    const frames = outputChannel.length;
    const channelCount = Math.min(input.length, output.length);
    const bypass = (parameters.bypass[0] ?? 1) >= 0.5;

    if (bypass) {
      for (let c = 0; c < channelCount; c++) {
        const src = input[c];
        const dest = output[c];
        if (!dest) continue;
        if (src) dest.set(src);
        else dest.fill(0);
      }
      this.measureLufs(input, channelCount, frames);
      this.gain = 1;
      return true;
    }

    const lufs = this.measureLufs(input, channelCount, frames);
    const target = parameters.target[0] ?? 0.5;
    const intensity = parameters.intensity[0] ?? 0.5;

    let nextGain = this.gain;
    if (intensity <= 0) {
      nextGain = 1;
    } else if (target <= 0) {
      nextGain = 0;
    } else if (lufs !== null && lufs > NOISE_FLOOR_LUFS) {
      let gainDb = 20 * Math.log10(target) - lufs;
      gainDb = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, gainDb));
      nextGain = 10 ** (gainDb * intensity / 20);
      const coeff = nextGain < this.gain ? this.attackCoeff : this.releaseCoeff;
      nextGain += (this.gain - nextGain) * coeff;
    }

    const start = this.gain;
    const step = (nextGain - start) / frames;
    for (let c = 0; c < channelCount; c++) {
      const src = input[c];
      const dest = output[c];
      if (!dest) continue;
      if (!src) {
        dest.fill(0);
        continue;
      }
      let gain = start;
      for (let i = 0; i < frames; i++) {
        dest[i] = src[i] * gain;
        gain += step;
      }
    }
    this.gain = nextGain;
    return true;
  }

  /** Measure the current 400 ms BS.1770 momentary loudness, without gating. */
  measureLufs(input, channelCount, frames) {
    for (let c = 0; c < channelCount; c++) {
      this.channelFilters[c] ??= makeChannelFilters();
    }

    for (let i = 0; i < frames; i++) {
      let frameEnergy = 0;
      for (let c = 0; c < channelCount; c++) {
        const sample = input[c]?.[i] ?? 0;
        const channel = this.channelFilters[c];
        const shelf = filterSample(sample, this.filters.shelf, channel.shelf);
        const weighted = filterSample(shelf, this.filters.highPass, channel.highPass);
        frameEnergy += weighted * weighted;
      }

      this.windowEnergy += frameEnergy - this.energyHistory[this.energyIndex];
      this.energyHistory[this.energyIndex] = frameEnergy;
      this.energyIndex++;
      if (this.energyIndex === this.windowFrames) this.energyIndex = 0;
      if (this.energyFrames < this.windowFrames) this.energyFrames++;
    }

    if (this.energyFrames < this.windowFrames) return null;
    const meanSquare = Math.max(0, this.windowEnergy / this.windowFrames);
    return meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : Number.NEGATIVE_INFINITY;
  }
}

registerProcessor("auto-leveler", AutoLevelerProcessor);
