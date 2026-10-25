import { DelayLine, SlidingMax } from "./dsp.js";
import { Tamer } from "./tamer.js";

/**
 * Auto-leveler: rides gain so the smoothed RMS of the signal approaches
 * `target`. Sits between the GainNode and the peak limiter; the limiter
 * downstream catches anything this overshoots.
 *
 * Look-ahead: level is measured on incoming audio but gain is applied to
 * audio delayed by LOOKAHEAD_SEC, so a sudden loud start (an alert sound, a
 * TTS voice out of silence) is turned down before it is heard. The delay also
 * applies when the `bypass` param is set (Gain mode), so switching between Gain
 * mode and Compression mode never jumps the audio in time.
 *
 * The Tamer (tamer.js) rides on the same look-ahead: its gain multiplies the
 * leveler's, and the leveler measures level as if already tamed, so it does
 * not lift tamed sound back up. The Tamer is not scaled by intensity.
 *
 * Parameters (all k-rate):
 *   target    linear RMS amplitude of full scale the leveler aims for.
 *             offscreen.ts sets it on every graph, so the default is only a
 *             fallback; it mirrors DEFAULT_TARGET (-20 dBFS) in src/messages.ts.
 *   intensity 0 = unity gain, 1 = full leveling; gain = desired ** intensity
 *   bypass    >= 0.5 passes audio through at unity gain (still delayed)
 */
const LOOKAHEAD_SEC = 0.02; // how far ahead of what is heard the level is measured
const ATTACK_SEC = 0.01; // smoother time constant while level rises: catch loud fast
const RELEASE_SEC = 0.9; // while level falls: lift quiet gradually
const NOISE_FLOOR = 0.001; // about -60 dBFS RMS; below this the gain is held
const MAX_GAIN = 7.94; // about +18 dB; stops the noise floor being amplified
const MIN_GAIN = 0.05; // about -26 dB
const PEAK_HEADROOM = 2.82; // +9 dB: peaks may sit this far above target (-11 dBFS at the default)
const QUANTUM_FRAMES = 128; // Web Audio render quantum

class AutoLevelerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "target",
        defaultValue: 0.1,
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
    // One-pole coefficients per render quantum, not per sample, since the
    // mean square is folded in once per process() call.
    const quantumSec = QUANTUM_FRAMES / sampleRate;
    this.attackCoeff = Math.exp(-quantumSec / ATTACK_SEC);
    this.releaseCoeff = Math.exp(-quantumSec / RELEASE_SEC);
    this.meanSquare = 0;
    this.gain = 1;
    this.tamer = new Tamer(sampleRate, QUANTUM_FRAMES);
    const delaySamples = Math.round(LOOKAHEAD_SEC * sampleRate);
    this.delay = new DelayLine(delaySamples);
    // Quantum peaks covering everything output during the gain ramp to the
    // next quantum's end: the delay line plus the quantum entering it.
    this.peaks = new SlidingMax(Math.ceil(delaySamples / QUANTUM_FRAMES) + 1);
    this.peak = 0;
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
    this.delay.ensureChannels(channelCount);

    // Track level while bypassed too, so the first quantum after enabling
    // starts from a sensible gain instead of unity-from-silence.
    const tamerGain = this.tamer.update(input, channelCount, frames);
    this.trackLevel(input, channelCount, frames, tamerGain);
    const nextGain = this.nextGain(
      (parameters.bypass[0] ?? 1) >= 0.5,
      parameters.target[0] ?? 0.5,
      parameters.intensity[0] ?? 0.5,
      tamerGain,
    );

    // Ramp across the quantum so gain changes never step (no zipper noise).
    const step = (nextGain - this.gain) / frames;
    let g = this.gain;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channelCount; c++) {
        const src = input[c];
        const dest = output[c];
        if (!dest) continue;
        dest[i] = this.delay.shift(c, src ? src[i] ?? 0 : 0) * g;
      }
      this.delay.advance();
      g += step;
    }
    this.gain = nextGain;
    return true;
  }

  /** Gain to reach by the end of this quantum. */
  nextGain(bypass, target, intensity, tamerGain) {
    if (bypass || intensity <= 0) return 1;
    // A 0% target means mute; the MIN_GAIN floor below would leave it audible.
    if (target <= 0) return 0;

    let gain = this.gain;
    const rms = Math.sqrt(this.meanSquare);
    if (rms >= NOISE_FLOOR) {
      let desired = target / rms;
      if (desired > MAX_GAIN) desired = MAX_GAIN;
      else if (desired < MIN_GAIN) desired = MIN_GAIN;
      gain = Math.pow(desired, intensity) * tamerGain;
    }
    // Pull gain down before a peak in the look-ahead window is heard; the RMS
    // smoother alone reacts too late to a loud start.
    const ceiling = target * PEAK_HEADROOM;
    if (gain * this.peak > ceiling) gain = ceiling / this.peak;
    return gain;
  }

  /**
   * Fold this quantum into the RMS smoother, as heard after `tamerGain`, and
   * into the look-ahead peak window.
   */
  trackLevel(input, channelCount, frames, tamerGain) {
    let sum = 0;
    let count = 0;
    let peak = 0;
    for (let c = 0; c < channelCount; c++) {
      const src = input[c];
      if (!src) continue;
      for (let i = 0; i < frames; i++) {
        const x = src[i];
        sum += x * x;
        const ax = x < 0 ? -x : x;
        if (ax > peak) peak = ax;
      }
      count += frames;
    }
    const block = count > 0 ? (sum / count) * tamerGain * tamerGain : 0;
    const coeff = block > this.meanSquare ? this.attackCoeff : this.releaseCoeff;
    this.meanSquare = block + coeff * (this.meanSquare - block);
    this.peak = this.peaks.push(peak);
  }
}

registerProcessor("auto-leveler", AutoLevelerProcessor);
