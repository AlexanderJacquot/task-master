// Paper sounds on the parchment theme: a sheet crumpling when a task opens, a quill
// scribbling when one is created, the sheet burning when one is deleted. Remembered per
// machine like the theme. They are synthesized with the Web Audio API from filtered noise,
// so there are no audio files to ship or license.

export type PaperSound = "crumple" | "scribble" | "burn";

const KEY = "task-master.sounds";

/** On by default; off only when turned off in Settings → Appearance. */
export function loadSoundsOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveSoundsOn(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Not persisted; the choice still holds for this session.
  }
}

/** Parchment is the theme with neither `dark` nor `clean` on <html> (lib/theme.ts). */
export function isParchment(root: HTMLElement | undefined = globalThis.document?.documentElement) {
  if (!root) return false;
  return !root.classList.contains("dark") && !root.classList.contains("clean");
}

export function shouldPlay(root?: HTMLElement): boolean {
  return loadSoundsOn() && isParchment(root);
}

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor: typeof AudioContext | undefined =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  // Two seconds of white noise, reused by every sound (each plays a slice of it).
  noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return ctx;
}

/** Plays `sound` if paper sounds are on and the parchment theme shows. Never throws. */
export function playSound(sound: PaperSound) {
  if (!shouldPlay()) return;
  try {
    const ac = audio();
    if (!ac || !noise) return;
    if (ac.state === "suspended") void ac.resume().catch(() => {});
    const out = ac.createGain();
    out.gain.value = 0.5;
    out.connect(ac.destination);
    const t = ac.currentTime + 0.01;
    if (sound === "crumple") crumple(ac, noise, out, t);
    else if (sound === "scribble") scribble(ac, noise, out, t);
    else burn(ac, noise, out, t);
  } catch {
    // Sound is decoration: a failing audio device must never break the action.
  }
}

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/**
 * One burst of filtered noise: `attack` up to `peak`, then an exponential fall over `decay`.
 * Returns the filter so callers can sweep it.
 */
function burst(
  ac: AudioContext,
  buf: AudioBuffer,
  out: AudioNode,
  at: number,
  opts: {
    freq: number;
    q: number;
    peak: number;
    attack: number;
    decay: number;
    type?: BiquadFilterType;
  },
): BiquadFilterNode {
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = opts.type ?? "bandpass";
  filter.frequency.setValueAtTime(opts.freq, at);
  filter.Q.value = opts.q;
  const env = ac.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(opts.peak, at + opts.attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + opts.attack + opts.decay);
  src.connect(filter).connect(env).connect(out);
  const length = opts.attack + opts.decay + 0.02;
  src.start(at, rand(0, buf.duration - length - 0.01), length);
  return filter;
}

/** Many short, bright crackles bunched in two handfuls: a sheet being crushed. */
function crumple(ac: AudioContext, buf: AudioBuffer, out: AudioNode, t: number) {
  for (const [start, span, count] of [
    [0, 0.18, 14],
    [0.22, 0.2, 12],
  ] as const) {
    for (let i = 0; i < count; i++) {
      burst(ac, buf, out, t + start + rand(0, span), {
        freq: rand(1800, 6500),
        q: rand(0.8, 2.5),
        peak: rand(0.15, 0.6),
        attack: 0.002,
        decay: rand(0.01, 0.05),
      });
    }
  }
  // The soft body of the paper under the crackles.
  burst(ac, buf, out, t, { freq: 900, q: 0.7, peak: 0.12, attack: 0.03, decay: 0.4 });
}

/** A few quick strokes of a nib on paper: narrow, scratchy noise that rises and falls. */
function scribble(ac: AudioContext, buf: AudioBuffer, out: AudioNode, t: number) {
  let at = t;
  const strokes = 5 + Math.floor(Math.random() * 3);
  for (let i = 0; i < strokes; i++) {
    const length = rand(0.06, 0.14);
    const filter = burst(ac, buf, out, at, {
      freq: rand(2500, 4200),
      q: rand(3, 6),
      peak: rand(0.25, 0.45),
      attack: length * 0.4,
      decay: length * 0.6,
    });
    // The pitch of the scratch follows the stroke's direction.
    filter.frequency.linearRampToValueAtTime(rand(2500, 5000), at + length);
    at += length + rand(0.01, 0.05);
  }
}

/** A rising, then dying whoosh of flame with crackles of the sheet catching. */
function burn(ac: AudioContext, buf: AudioBuffer, out: AudioNode, t: number) {
  const whoosh = burst(ac, buf, out, t, {
    freq: 250,
    q: 0.6,
    peak: 0.5,
    attack: 0.35,
    decay: 0.9,
    type: "lowpass",
  });
  whoosh.frequency.exponentialRampToValueAtTime(2200, t + 0.35);
  whoosh.frequency.exponentialRampToValueAtTime(400, t + 1.25);
  for (let i = 0; i < 22; i++) {
    burst(ac, buf, out, t + rand(0.05, 1.1), {
      freq: rand(1500, 5000),
      q: rand(1, 4),
      peak: rand(0.1, 0.35),
      attack: 0.001,
      decay: rand(0.005, 0.03),
    });
  }
}
