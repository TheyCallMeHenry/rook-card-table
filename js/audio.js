/**
 * audio.js — WebAudio-synthesis sound effects, no samples, no network.
 * The AudioContext is created lazily on the first user gesture and every
 * call is wrapped so a broken audio stack can never take gameplay with it.
 * Mute state persists in localStorage under 'rook-muted'. Sound is ON by
 * default; the mute toggle is a visible button (main.js wires it).
 */

const MUTE_KEY = 'rook-muted';

let ctx = null;          // Lazily-created AudioContext
let unlocked = false;    // True once a user gesture has initialized audio

function loadMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}
let muted = loadMuted();

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Call once from the first pointerdown/keydown so browsers allow playback. */
export function unlock() {
  if (unlocked) return;
  unlocked = true;
  try { ensureCtx(); } catch { /* audio unavailable; gameplay unaffected */ }
}

export function isMuted() { return muted; }

export function setMuted(on) {
  muted = Boolean(on);
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* private mode */ }
  return muted;
}

export function toggleMuted() { return setMuted(!muted); }

/** Run fn only when audible; swallow every audio failure. */
function play(fn) {
  if (muted || !unlocked) return;
  try {
    const ac = ensureCtx();
    if (ac) fn(ac, ac.currentTime);
  } catch { /* never break gameplay over sound */ }
}

function envelope(ac, t, dest, peak, attack, decay) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(dest);
  return g;
}

/** Short filtered noise burst — a card sliding off the deck (~40 ms). */
export function dealFlick() {
  play((ac, t) => {
    const dur = 0.04;
    const n = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 0.8;
    const g = envelope(ac, t, ac.destination, 0.18, 0.004, dur - 0.004);
    src.connect(bp).connect(g);
    src.start(t);
    src.stop(t + dur);
  });
}

/** Filtered sine click — card flip pop. */
export function flip() {
  play((ac, t) => {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1250, t);
    osc.frequency.exponentialRampToValueAtTime(720, t + 0.07);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    const g = envelope(ac, t, ac.destination, 0.16, 0.004, 0.07);
    osc.connect(lp).connect(g);
    osc.start(t);
    osc.stop(t + 0.09);
  });
}

/** Two-note rising chime — trick won. */
export function trickWin() {
  play((ac, t) => {
    const note = (freq, at, len, peak) => {
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const g = envelope(ac, at, ac.destination, peak, 0.012, len);
      osc.connect(g);
      osc.start(at);
      osc.stop(at + len + 0.05);
    };
    note(659.25, t, 0.12, 0.14);          // E5
    note(880.0, t + 0.13, 0.2, 0.14);     // A5
  });
}

/** Descending buzz — contract failed. */
export function bidFail() {
  play((ac, t) => {
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(85, t + 0.55);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(320, t + 0.55);
    const g = envelope(ac, t, ac.destination, 0.14, 0.02, 0.55);
    osc.connect(lp).connect(g);
    osc.start(t);
    osc.stop(t + 0.62);
  });
}

/** Three-note fanfare — game won. */
export function gameWin() {
  play((ac, t) => {
    const note = (freq, at, len) => {
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const osc2 = ac.createOscillator();
      osc2.type = 'square';
      osc2.frequency.value = freq * 2;
      const g = envelope(ac, at, ac.destination, 0.15, 0.015, len);
      const g2 = ac.createGain();
      g2.gain.value = 0.25;
      osc.connect(g);
      osc2.connect(g2).connect(g);
      osc.start(at); osc.stop(at + len + 0.06);
      osc2.start(at); osc2.stop(at + len + 0.06);
    };
    note(523.25, t, 0.16);            // C5
    note(659.25, t + 0.17, 0.16);     // E5
    note(783.99, t + 0.34, 0.42);     // G5
  });
}
