/**
 * Tamer: turns down sound that rises well above the stream's normal speech
 * level, such as TTS donations and alert sounds, so they land near the
 * streamer's voice instead of over it. Runs inside the leveler, on the same
 * look-ahead, so it adds no latency.
 *
 * It keeps a slow, gated reference of the speech level: quiet and silent
 * stretches are ignored, and anything louder than the reference moves it so
 * slowly that a 10-20 s TTS shifts it only 1-2 LU. Only loudness more than
 * THRESHOLD_LU above the reference is turned down, at RATIO, with an instant
 * attack and a RELEASE_SEC release.
 *
 * Levels are BS.1770 loudness (K-weighted, channels summed) in LUFS.
 */
const LOUDNESS_ATTACK_SEC = 0.4; // loudness smoother while it rises
const LOUDNESS_RELEASE_SEC = 3; // while it falls: bridges pauses between words
const GATE_LUFS = -50; // quieter than this is silence; the reference ignores it
const REFERENCE_FLOOR_LU = 12; // quieter than reference - this is ignored too
const REFERENCE_SEC = 15; // reference time constant for normal speech
const REFERENCE_LOUD_SEC = 60; // for loudness above the threshold: barely moves
const THRESHOLD_LU = 3; // loudness this far above the reference is turned down
const RATIO = 10; // 10 LU over the threshold comes out 1 LU over
const RELEASE_SEC = 1; // how fast turned-down gain comes back

export class Tamer {
  constructor(sampleRate, quantumFrames) {
    const quantumSec = quantumFrames / sampleRate;
    const coeff = (sec) => Math.exp(-quantumSec / sec);
    this.loudnessAttackCoeff = coeff(LOUDNESS_ATTACK_SEC);
    this.loudnessReleaseCoeff = coeff(LOUDNESS_RELEASE_SEC);
    this.referenceRate = 1 - coeff(REFERENCE_SEC);
    this.referenceLoudRate = 1 - coeff(REFERENCE_LOUD_SEC);
    this.releaseCoeff = coeff(RELEASE_SEC);
    this.weighting = new KWeighting(sampleRate);
    this.meanSquare = 0;
    // Speech reference in LUFS; null until the first non-silent quantum.
    this.reference = null;
    this.reductionDb = 0;
  }

  /** Fold in one quantum of incoming audio; returns the gain to apply to it. */
  update(input, channelCount, frames) {
    const block = this.weighting.meanSquare(input, channelCount, frames);
    const coeff = block > this.meanSquare ? this.loudnessAttackCoeff : this.loudnessReleaseCoeff;
    this.meanSquare = block + coeff * (this.meanSquare - block);
    const loudness = -0.691 + 10 * Math.log10(this.meanSquare + 1e-14);

    let targetDb = 0;
    if (loudness > GATE_LUFS) {
      const reference = this.nextReference(loudness);
      const over = loudness - reference - THRESHOLD_LU;
      if (over > 0) targetDb = over * (1 - 1 / RATIO);
      this.reference = reference;
    }
    this.reductionDb =
      targetDb > this.reductionDb
        ? targetDb
        : targetDb + this.releaseCoeff * (this.reductionDb - targetDb);
    return 10 ** (-this.reductionDb / 20);
  }

  nextReference(loudness) {
    const reference = this.reference;
    if (reference === null) return loudness;
    if (loudness <= reference - REFERENCE_FLOOR_LU) return reference;
    const rate =
      loudness < reference + THRESHOLD_LU ? this.referenceRate : this.referenceLoudRate;
    return reference + (loudness - reference) * rate;
  }
}

/** BS.1770 K-weighting: high shelf then high pass, designed for any sample rate. */
class KWeighting {
  constructor(sampleRate) {
    // Coefficients as in libebur128; at 48 kHz they equal the BS.1770 table.
    const shelf = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
    const shelfQ = 0.7071752369554196;
    const vh = 10 ** (3.999843853973347 / 20);
    const vb = vh ** 0.4996667741545416;
    const shelfA0 = 1 + shelf / shelfQ + shelf * shelf;
    this.shelfB0 = (vh + (vb * shelf) / shelfQ + shelf * shelf) / shelfA0;
    this.shelfB1 = (2 * (shelf * shelf - vh)) / shelfA0;
    this.shelfB2 = (vh - (vb * shelf) / shelfQ + shelf * shelf) / shelfA0;
    this.shelfA1 = (2 * (shelf * shelf - 1)) / shelfA0;
    this.shelfA2 = (1 - shelf / shelfQ + shelf * shelf) / shelfA0;
    const pass = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
    const passQ = 0.5003270373238773;
    const passA0 = 1 + pass / passQ + pass * pass;
    this.passA1 = (2 * (pass * pass - 1)) / passA0;
    this.passA2 = (1 - pass / passQ + pass * pass) / passA0;
    // Per channel: two transposed direct form II states per stage.
    this.states = [];
  }

  /** Weighted mean square of one quantum, summed over channels. */
  meanSquare(input, channelCount, frames) {
    while (this.states.length < channelCount) this.states.push(new Float64Array(4));
    let sum = 0;
    for (let c = 0; c < channelCount; c++) {
      const src = input[c];
      if (!src) continue;
      const z = this.states[c];
      for (let i = 0; i < frames; i++) {
        const x = src[i];
        const y = this.shelfB0 * x + z[0];
        z[0] = this.shelfB1 * x - this.shelfA1 * y + z[1];
        z[1] = this.shelfB2 * x - this.shelfA2 * y;
        const w = y + z[2];
        z[2] = -2 * y - this.passA1 * w + z[3];
        z[3] = y - this.passA2 * w;
        sum += w * w;
      }
    }
    return sum / frames;
  }
}
