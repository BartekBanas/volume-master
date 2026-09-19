/**
 * Auto-leveler: rides gain so the smoothed RMS of the signal approaches
 * `target`. Sits between the GainNode and the peak limiter; the limiter
 * downstream catches anything this overshoots.
 *
 * Parameters (all k-rate):
 *   target    linear RMS amplitude of full scale the leveler aims for
 *   intensity 0 = unity gain, 1 = full leveling; gain = desired ** intensity
 *   bypass    >= 0.5 passes audio through untouched
 */
const ATTACK_SEC = 0.12; // smoother time constant while level rises: catch loud fast
const RELEASE_SEC = 0.9; // while level falls: lift quiet gradually
const NOISE_FLOOR = 0.001; // about -60 dBFS RMS; below this the gain is held
const MAX_GAIN = 7.94; // about +18 dB; stops the noise floor being amplified
const MIN_GAIN = 0.05; // about -26 dB

class AutoLevelerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "target",
        defaultValue: 0.2,
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
    // One-pole coefficients per render quantum (128 frames), not per sample,
    // since the mean square is folded in once per process() call.
    const quantumSec = 128 / sampleRate;
    this.attackCoeff = Math.exp(-quantumSec / ATTACK_SEC);
    this.releaseCoeff = Math.exp(-quantumSec / RELEASE_SEC);
    this.meanSquare = 0;
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
      // Track level while bypassed so the first quantum after enabling
      // starts from a sensible gain instead of unity-from-silence.
      this.trackLevel(input, channelCount, frames);
      this.gain = 1;
      return true;
    }

    const rms = this.trackLevel(input, channelCount, frames);
    const target = parameters.target[0] ?? 0.2;
    const intensity = parameters.intensity[0] ?? 0.5;

    let nextGain = this.gain;
    if (intensity <= 0) {
      nextGain = 1;
    } else if (target <= 0) {
      // A 0% target means mute; the MIN_GAIN floor below would leave it audible.
      nextGain = 0;
    } else if (rms >= NOISE_FLOOR) {
      let desired = target / rms;
      if (desired > MAX_GAIN) desired = MAX_GAIN;
      else if (desired < MIN_GAIN) desired = MIN_GAIN;
      nextGain = Math.pow(desired, intensity);
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
      let g = start;
      for (let i = 0; i < frames; i++) {
        dest[i] = src[i] * g;
        g += step;
      }
    }
    this.gain = nextGain;
    return true;
  }

  /** Fold this quantum's mean square into the smoother; returns smoothed RMS. */
  trackLevel(input, channelCount, frames) {
    let sum = 0;
    let count = 0;
    for (let c = 0; c < channelCount; c++) {
      const src = input[c];
      if (!src) continue;
      for (let i = 0; i < frames; i++) {
        const x = src[i];
        sum += x * x;
      }
      count += frames;
    }
    const block = count > 0 ? sum / count : 0;
    const coeff = block > this.meanSquare ? this.attackCoeff : this.releaseCoeff;
    this.meanSquare = block + coeff * (this.meanSquare - block);
    return Math.sqrt(this.meanSquare);
  }
}

registerProcessor("auto-leveler", AutoLevelerProcessor);
