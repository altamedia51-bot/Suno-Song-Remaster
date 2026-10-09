/* ============================================================================
 * pitcher.js — Pitch / tempo DSP + BPM & key detection (pure JS, no DOM)
 *
 * - wsolaStretch(channels, rate, onProgress): time-stretch. rate > 1 = faster
 *   (shorter output). Pitch is preserved.
 * - pitchShift(channels, sampleRate, semitones, onProgress): shift pitch by
 *   N semitones, preserving tempo (resample + stretch-back).
 * - resampleChannel(x, ratio): cubic-interpolation resampler. ratio > 1 =
 *   faster playback (shorter output, higher pitch) — varispeed.
 * - detectBPM(channels, sampleRate): onset-flux + autocorrelation.
 * - detectKey(channels, sampleRate): chromagram + Krumhansl-Schmuckler.
 * ========================================================================== */

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/**
 * WSOLA time-stretch. `rate` > 1 → faster (output length ≈ input/rate).
 * Stereo-safe: the alignment search runs on channel 0, the winning offset is
 * applied to every channel so the stereo image doesn't wobble.
 * Async: yields to the UI thread periodically; onProgress receives 0..1.
 */
export async function wsolaStretch(channels, rate, onProgress) {
  if (!channels.length) return channels;
  if (Math.abs(rate - 1) < 1e-6) return channels.map((c) => c.slice());

  const N = 2048; // frame size
  const Hs = 512; // synthesis hop (output samples)
  const tol = 192; // search tolerance (samples)
  // Time mapping: output position y <=> input position x = y * rate.
  // Per frame: y advances Hs, so x must advance Ha = Hs * rate.
  const Ha = Hs * rate; // analysis hop
  const win = hann(N);
  const inLen = channels[0].length;
  const outLen = Math.max(N, Math.floor(inLen / rate) + N);
  const nCh = channels.length;

  const y = [];
  const wsum = new Float64Array(outLen);
  for (let ch = 0; ch < nCh; ch++) y.push(new Float64Array(outLen));

  const ref = channels[0];
  // first frame at position 0
  const firstN = Math.min(N, inLen);
  for (let ch = 0; ch < nCh; ch++) {
    const yc = y[ch], xc = channels[ch];
    for (let n = 0; n < firstN; n++) {
      yc[n] += xc[n] * win[n];
      if (ch === 0) wsum[n] += win[n];
    }
  }

  let xPos = Ha;
  let yPos = Hs;
  let frames = 0;
  // The new frame lands at [yPos, yPos+N]; it overlaps existing output on
  // [yPos, yPos+(N-Hs)]. Correlate the candidate's head with that region
  // (512-sample window for speed) to find the most coherent placement.
  const ovSearch = 512;

  for (;;) {
    const xNom = Math.round(xPos);
    const start = Math.max(0, xNom - tol);
    const end = Math.min(inLen - N, xNom + tol);
    if (start > end || yPos + N > outLen) break;

    const yOv = y[0].subarray(yPos, yPos + ovSearch);

    // coarse-to-fine search for max cross-correlation
    let best = start;
    let bestCorr = -Infinity;
    const step = 2;
    for (let c = start; c <= end; c += step) {
      let corr = 0;
      for (let n = 0; n < ovSearch; n++) corr += ref[c + n] * yOv[n];
      if (corr > bestCorr) {
        bestCorr = corr;
        best = c;
      }
    }
    for (let c = Math.max(start, best - step); c <= Math.min(end, best + step); c++) {
      let corr = 0;
      for (let n = 0; n < ovSearch; n++) corr += ref[c + n] * yOv[n];
      if (corr > bestCorr) {
        bestCorr = corr;
        best = c;
      }
    }

    for (let ch = 0; ch < nCh; ch++) {
      const yc = y[ch], xc = channels[ch];
      for (let n = 0; n < N; n++) {
        yc[yPos + n] += xc[best + n] * win[n];
        if (ch === 0) wsum[yPos + n] += win[n];
      }
    }

    yPos += Hs;
    xPos += Ha;
    frames++;
    if (frames % 40 === 0) {
      if (onProgress) onProgress(Math.min(0.99, yPos / outLen));
      await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
    }
  }

  const finalLen = Math.min(outLen, Math.floor(inLen / rate) + N);
  const out = [];
  for (let ch = 0; ch < nCh; ch++) {
    const yc = y[ch];
    const res = new Float32Array(finalLen);
    for (let n = 0; n < finalLen; n++) {
      const w = wsum[n];
      res[n] = w > 1e-8 ? yc[n] / w : 0;
    }
    out.push(res);
  }
  if (onProgress) onProgress(1);
  return out;
}

/** Cubic (Catmull-Rom) resampler. ratio > 1 → faster & higher pitch (varispeed). */
export function resampleChannel(x, ratio) {
  if (Math.abs(ratio - 1) < 1e-9) return x.slice();
  const inLen = x.length;
  const outLen = Math.max(1, Math.floor(inLen / ratio));
  const y = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const t = pos - i0;
    const p0 = x[Math.max(0, i0 - 1)];
    const p1 = x[i0];
    const p2 = x[Math.min(inLen - 1, i0 + 1)];
    const p3 = x[Math.min(inLen - 1, i0 + 2)];
    y[i] =
      0.5 *
      (2 * p1 +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  }
  return y;
}

/**
 * Pitch-shift by `semitones` (can be fractional), preserving tempo.
 * Method: varispeed resample (pitch+tempo change) then WSOLA stretch-back.
 * Async: yields to the UI thread; onProgress receives 0..1.
 */
export async function pitchShift(channels, semitones, onProgress) {
  if (Math.abs(semitones) < 1e-9) return channels.map((c) => c.slice());
  const r = Math.pow(2, semitones / 12);
  const sped = channels.map((c) => resampleChannel(c, r));
  if (onProgress) onProgress(0.3);
  await new Promise((res) => setTimeout(res, 0));
  // stretch back: output length must return to original → rate = 1/r
  return wsolaStretch(sped, 1 / r, (f) => onProgress && onProgress(0.3 + 0.7 * f));
}

/** Downmix + downsample to mono at ~8kHz for analysis. */
function analysisMono(channels, sampleRate, maxSeconds = 90) {
  const targetSr = 8000;
  const nCh = channels.length;
  const maxLen = Math.min(channels[0].length, Math.floor(sampleRate * maxSeconds));
  // use the middle excerpt for long files (skip intro/outro fade)
  let start = 0;
  if (channels[0].length > maxLen) start = Math.floor((channels[0].length - maxLen) / 3);
  const step = sampleRate / targetSr;
  const outLen = Math.floor(maxLen / step);
  const mono = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = start + Math.floor(i * step);
    let s = 0;
    for (let ch = 0; ch < nCh; ch++) s += channels[ch][pos];
    mono[i] = s / nCh;
  }
  return { mono, sr: targetSr };
}

/** Rough BPM via onset-flux + autocorrelation. Returns rounded BPM or null. */
export function detectBPM(channels, sampleRate) {
  const { mono, sr } = analysisMono(channels, sampleRate, 60);
  const hop = 256;
  const nHops = Math.floor(mono.length / hop);
  if (nHops < 64) return null;
  // RMS per hop
  const rms = new Float64Array(nHops);
  for (let h = 0; h < nHops; h++) {
    let e = 0;
    const o = h * hop;
    for (let n = 0; n < hop; n++) e += mono[o + n] * mono[o + n];
    rms[h] = Math.sqrt(e / hop);
  }
  // onset flux (positive differences)
  const flux = new Float64Array(nHops);
  for (let h = 1; h < nHops; h++) flux[h] = Math.max(0, rms[h] - rms[h - 1]);
  const mean = flux.reduce((a, b) => a + b, 0) / nHops;
  if (mean < 1e-9) return null;

  const hopDur = hop / sr; // seconds per hop
  const minLag = Math.max(1, Math.round(60 / 220 / hopDur)); // 220 BPM
  const maxLag = Math.round(60 / 50 / hopDur); // 50 BPM
  const ac = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= Math.min(maxLag, nHops - 1); lag++) {
    let v = 0;
    for (let h = 0; h + lag < nHops; h++) v += flux[h] * flux[h + lag];
    ac[lag] = v;
  }
  let bestLag = 0;
  let bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (ac[lag] > bestVal) {
      bestVal = ac[lag];
      bestLag = lag;
    }
  }
  if (!bestLag || bestVal < 1e-12) return null;

  // Octave correction: prefer 90–180 BPM when a harmonic supports it
  let bpm = 60 / (bestLag * hopDur);
  let guard = 0;
  while (bpm < 90 && guard++ < 3) {
    const dblLag = Math.round(bestLag / 2);
    if (dblLag >= minLag && ac[dblLag] > 0.35 * bestVal) {
      bestLag = dblLag;
      bestVal = ac[dblLag];
      bpm = 60 / (bestLag * hopDur);
    } else break;
  }
  guard = 0;
  while (bpm > 180 && guard++ < 3) {
    const halfLag = bestLag * 2;
    if (halfLag <= maxLag && ac[halfLag] > 0.35 * bestVal) {
      bestLag = halfLag;
      bestVal = ac[halfLag];
      bpm = 60 / (bestLag * hopDur);
    } else break;
  }
  return Math.round(bpm);
}

/* --- Key detection --- */

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let j2 = 0; j2 < len / 2; j2++) {
        const ur = re[i + j2], ui = im[i + j2];
        const vr = re[i + j2 + len / 2] * cwr - im[i + j2 + len / 2] * cwi;
        const vi = re[i + j2 + len / 2] * cwi + im[i + j2 + len / 2] * cwr;
        re[i + j2] = ur + vr; im[i + j2] = ui + vi;
        re[i + j2 + len / 2] = ur - vr; im[i + j2 + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) * (a[i] - ma);
    db += (b[i] - mb) * (b[i] - mb);
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

function rotate(arr, k) {
  return arr.map((_, i) => arr[(i + k) % 12]);
}

/** Detect musical key. Returns e.g. "Bb minor" or null. */
export function detectKey(channels, sampleRate) {
  const { mono, sr } = analysisMono(channels, sampleRate, 90);
  const N = 2048;
  const hop = 1024;
  const win = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const chroma = new Float64Array(12);
  let frames = 0;
  for (let off = 0; off + N <= mono.length; off += hop) {
    for (let n = 0; n < N; n++) {
      re[n] = mono[off + n] * win[n];
      im[n] = 0;
    }
    fftInPlace(re, im);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * sr) / N;
      if (f < 55 || f > 2000) continue;
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const midi = Math.round(69 + 12 * Math.log2(f / 440));
      const pc = ((midi % 12) + 12) % 12;
      chroma[pc] += Math.log1p(mag);
    }
    frames++;
  }
  if (!frames) return null;
  const total = chroma.reduce((a, b) => a + b, 0);
  if (total < 1e-9) return null;

  let bestName = null;
  let bestScore = -Infinity;
  for (let root = 0; root < 12; root++) {
    // rotate so the profile's tonic (index 0) lands on pitch class `root`
    const k = (12 - root) % 12;
    const sMaj = pearson(chroma, rotate(KRUMHANSL_MAJOR, k));
    if (sMaj > bestScore) {
      bestScore = sMaj;
      bestName = NOTE_NAMES[root] + ' major';
    }
    const sMin = pearson(chroma, rotate(KRUMHANSL_MINOR, k));
    if (sMin > bestScore) {
      bestScore = sMin;
      bestName = NOTE_NAMES[root] + ' minor';
    }
  }
  return bestName;
}
