/* ============================================================================
 * noise-gate-processor.js — AudioWorklet downward noise gate
 *
 * Silences signal below the threshold (hiss / background noise in quiet
 * parts) with smoothed attack/release so there are no clicks.
 * Controlled via port messages: { enabled, thresholdDb, attackSec, releaseSec }
 * Loaded via `audioWorklet.addModule('./noise-gate-processor.js')`.
 * ========================================================================== */
class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.thresholdDb = -45;
    this.attackSec = 0.003;
    this.releaseSec = 0.15;
    this.envelope = 0;
    this.gain = 1;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.enabled !== undefined) this.enabled = !!d.enabled;
      if (d.thresholdDb !== undefined) this.thresholdDb = d.thresholdDb;
      if (d.attackSec !== undefined) this.attackSec = Math.max(0.0005, d.attackSec);
      if (d.releaseSec !== undefined) this.releaseSec = Math.max(0.01, d.releaseSec);
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) return true;

    const nCh = Math.min(input.length, output.length);
    const n = input[0].length;

    // Disabled / bypassed: transparent passthrough
    if (!this.enabled) {
      for (let ch = 0; ch < nCh; ch++) output[ch].set(input[ch]);
      this.envelope = 0;
      this.gain = 1;
      return true;
    }

    const threshLin = Math.pow(10, this.thresholdDb / 20);
    const atkCoef = Math.exp(-1 / (this.attackSec * sampleRate));
    const relCoef = Math.exp(-1 / (this.releaseSec * sampleRate));

    for (let i = 0; i < n; i++) {
      // Peak across channels drives a single shared envelope
      let peak = 0;
      for (let ch = 0; ch < nCh; ch++) {
        const a = Math.abs(input[ch][i]);
        if (a > peak) peak = a;
      }

      // Envelope follower
      if (peak > this.envelope) {
        this.envelope = atkCoef * (this.envelope - peak) + peak;
      } else {
        this.envelope = relCoef * (this.envelope - peak) + peak;
      }

      // Gate gain with smoothed transitions (no clicks)
      const target = this.envelope >= threshLin ? 1 : 0;
      const gCoef = target > this.gain ? atkCoef : relCoef;
      this.gain += (target - this.gain) * (1 - gCoef);

      const g = this.gain;
      for (let ch = 0; ch < nCh; ch++) {
        output[ch][i] = input[ch][i] * g;
      }
    }
    return true;
  }
}

registerProcessor('noise-gate', NoiseGateProcessor);
