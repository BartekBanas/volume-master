/**
 * Small building blocks shared by the audio worklets. Plain classes with
 * preallocated typed arrays: process() runs on the audio thread and must not
 * allocate.
 */

/** Running maximum of the last `size` pushed values, O(1) amortized per push. */
export class SlidingMax {
  constructor(size) {
    this.size = size;
    // Monotonic deque in a ring: values decrease from head to tail, so the
    // head is always the window maximum. `stamps` record when each entered.
    this.values = new Float32Array(size);
    this.stamps = new Float64Array(size);
    this.head = 0;
    this.count = 0;
    this.time = 0;
  }

  /** Add a value and return the maximum of the last `size` values pushed. */
  push(value) {
    const size = this.size;
    while (this.count > 0) {
      const back = (this.head + this.count - 1) % size;
      if (this.values[back] > value) break;
      this.count -= 1;
    }
    if (this.count > 0 && this.stamps[this.head] <= this.time - size) {
      this.head = (this.head + 1) % size;
      this.count -= 1;
    }
    const tail = (this.head + this.count) % size;
    this.values[tail] = value;
    this.stamps[tail] = this.time;
    this.count += 1;
    this.time += 1;
    return this.values[this.head];
  }
}
