import { clamp } from "./utils";

/**
 * Moteur audio 100 % procédural (WebAudio) : aucun fichier, aucun CDN.
 * Tout est synthétisé (oscillateurs + bruit filtré) et joué en fonction de
 * l'état physique de la voiture : régime, charge, glisse, sauts, chocs.
 */

interface AudioNodes {
  ctx: AudioContext | null;
  master: GainNode | null;
  engine: GainNode | null;
  road: GainNode | null;
  wind: GainNode | null;
  osc: OscillatorNode | null;
  sub: OscillatorNode | null;
  saw: OscillatorNode | null;
  oscFilter: BiquadFilterNode | null;
  noise: AudioBufferSourceNode | null;
  noiseFilter: BiquadFilterNode | null;
  roadSource: AudioBufferSourceNode | null;
  roadFilter: BiquadFilterNode | null;
  windSource: AudioBufferSourceNode | null;
  windFilter: BiquadFilterNode | null;
  windGain: GainNode | null;
  screechSource: AudioBufferSourceNode | null;
  screechFilter: BiquadFilterNode | null;
  screechGain: GainNode | null;
  buffer: AudioBuffer | null;
  started: boolean;
  volume: number;
  muted: boolean;
}

export const audio: AudioNodes = {
  ctx: null, master: null, engine: null, road: null, wind: null,
  osc: null, sub: null, saw: null, oscFilter: null,
  noise: null, noiseFilter: null,
  roadSource: null, roadFilter: null,
  windSource: null, windFilter: null, windGain: null,
  screechSource: null, screechFilter: null, screechGain: null,
  buffer: null, started: false, volume: 0.7, muted: false,
};

const ENGINE_BASE = 0.17;

function noiseBuffer(ctx: AudioContext, seconds = 2): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    last = 0.94 * last + 0.06 * white;
    data[i] = clamp(last * 3 + white * 0.35, -1, 1);
  }
  return buffer;
}

/** Baisse le moteur quand un écran de menu est affiché. */
export function duckEngine(on: boolean): void {
  if (!audio.ctx || !audio.engine) return;
  const base = ENGINE_BASE * (audio.muted ? 0 : audio.volume * audio.volume);
  audio.engine.gain.setTargetAtTime(on ? base * 0.25 : base, audio.ctx.currentTime, 0.15);
}

export function initAudio(volume = 0.7, muted = false): void {
  if (audio.ctx) {
    void audio.ctx.resume().catch(() => undefined);
    return;
  }
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  const ctx = new Ctor();
  audio.ctx = ctx;
  audio.volume = clamp(volume, 0, 1);
  audio.muted = muted;

  const master = ctx.createGain();
  master.gain.value = muted ? 0 : audio.volume * audio.volume;
  master.connect(ctx.destination);
  audio.master = master;

  audio.buffer = noiseBuffer(ctx);

  const engineGain = ctx.createGain();
  engineGain.gain.value = 0;
  const oscFilter = ctx.createBiquadFilter();
  oscFilter.type = "lowpass";
  oscFilter.frequency.value = 420;
  oscFilter.Q.value = 3.5;
  engineGain.connect(master);
  oscFilter.connect(engineGain);
  audio.engine = engineGain;
  audio.oscFilter = oscFilter;

  const roadGain = ctx.createGain();
  roadGain.gain.value = 0;
  const roadFilter = ctx.createBiquadFilter();
  roadFilter.type = "bandpass";
  roadFilter.frequency.value = 320;
  roadFilter.Q.value = 0.8;
  roadGain.connect(master);
  roadFilter.connect(roadGain);
  audio.road = roadGain;
  audio.roadFilter = roadFilter;

  const windGain = ctx.createGain();
  windGain.gain.value = 0;
  const windFilter = ctx.createBiquadFilter();
  windFilter.type = "highpass";
  windFilter.frequency.value = 1400;
  windGain.connect(master);
  windFilter.connect(windGain);
  audio.wind = windGain;
  audio.windGain = windGain;
  audio.windFilter = windFilter;

  const screechGain = ctx.createGain();
  screechGain.gain.value = 0;
  const screechFilter = ctx.createBiquadFilter();
  screechFilter.type = "bandpass";
  screechFilter.frequency.value = 1750;
  screechFilter.Q.value = 5;
  screechGain.connect(master);
  screechFilter.connect(screechGain);
  audio.screechGain = screechGain;
  audio.screechFilter = screechFilter;
}

export function startEngine(): void {
  const ctx = audio.ctx;
  const oscFilter = audio.oscFilter;
  const roadFilter = audio.roadFilter;
  const windFilter = audio.windFilter;
  const screechFilter = audio.screechFilter;
  if (!ctx || !oscFilter || !roadFilter || !windFilter || !screechFilter || audio.started) return;
  audio.started = true;

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = 60;
  osc.connect(oscFilter);
  osc.start();
  audio.osc = osc;

  const sub = ctx.createOscillator();
  sub.type = "square";
  sub.frequency.value = 30;
  const subGain = ctx.createGain();
  subGain.gain.value = 0.45;
  sub.connect(subGain);
  subGain.connect(oscFilter);
  sub.start();
  audio.sub = sub;

  const saw = ctx.createOscillator();
  saw.type = "sawtooth";
  saw.detune.value = 12;
  const sawGain = ctx.createGain();
  sawGain.gain.value = 0.35;
  saw.connect(sawGain);
  sawGain.connect(oscFilter);
  saw.start();
  audio.saw = saw;

  audio.noise = startNoise(ctx, oscFilter, 0.28, "lowpass", 800);
  audio.roadSource = startNoise(ctx, roadFilter, 0.16, "bandpass", 320);
  audio.windSource = startNoise(ctx, windFilter, 0.5, "highpass", 1400);
  audio.screechSource = startNoise(ctx, screechFilter, 0.6, "bandpass", 1750);
}

export function stopEngine(): void {
  const ctx = audio.ctx;
  if (!ctx) return;
  for (const node of [audio.osc, audio.sub, audio.saw, audio.noise, audio.roadSource, audio.windSource, audio.screechSource]) {
    try {
      node?.stop();
    } catch {
      /* déjà arrêté */
    }
  }
  audio.osc = audio.sub = audio.saw = null;
  audio.noise = audio.roadSource = audio.windSource = audio.screechSource = null;
  audio.started = false;
  if (audio.engine) audio.engine.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
}

/**
 * Pilote le moteur en fonction de l'état physique.
 * @param speed01 vitesse / vitesse max (0..~1.2)
 * @param load    charge (0 roue libre, 1 pleine accélération)
 * @param throttle garde-gaz (0..1)
 * @param offroad suspension sale : plus de bas médium
 */
export function setEngineParams(speed01: number, load: number, throttle: number, offroad: boolean): void {
  const ctx = audio.ctx;
  if (!ctx || !audio.osc || !audio.engine || !audio.oscFilter) return;
  const t = ctx.currentTime;
  const speed = clamp(speed01, 0, 1.25);
  const idle = 58;
  const target = idle + speed * 205 + load * 46 + throttle * 34;
  audio.osc.frequency.setTargetAtTime(target, t, 0.07);
  audio.sub?.frequency.setTargetAtTime(target * 0.5, t, 0.09);
  audio.saw?.frequency.setTargetAtTime(target * 1.01, t, 0.07);
  audio.oscFilter.frequency.setTargetAtTime(420 + speed * 1300 + throttle * 500, t, 0.08);
  const base = ENGINE_BASE * (audio.muted ? 0 : audio.volume * audio.volume);
  audio.engine.gain.setTargetAtTime(base * (0.42 + 0.5 * throttle + 0.3 * speed), t, 0.09);
  audio.oscFilter.Q.value = 3 + (offroad ? 1.5 : 0);
}

/** Bruits de roulement, de vent et de patinage continus. */
export function updateAudio(speed: number, slip: number, offroad: boolean, grounded: boolean): void {
  const ctx = audio.ctx;
  if (!ctx || !audio.road || !audio.wind || !audio.screechGain) return;
  const t = ctx.currentTime;
  const v = clamp(speed / 62, 0, 1);
  const base = audio.muted ? 0 : audio.volume * audio.volume;

  const roadLevel = grounded ? (offroad ? 0.12 + v * 0.3 : 0.03 + v * 0.17) : 0.012;
  audio.road.gain.setTargetAtTime(roadLevel * base, t, 0.1);
  audio.roadFilter?.frequency.setTargetAtTime(offroad ? 180 + v * 240 : 300 + v * 520, t, 0.12);

  audio.wind.gain.setTargetAtTime(base * v * v * 0.14, t, 0.16);
  audio.windFilter?.frequency.setTargetAtTime(900 + v * 2100, t, 0.2);

  const level = clamp(slip * 1.15 - 0.2, 0, 1) * clamp(speed / 10, 0, 1) * (grounded ? 1 : 0.1);
  audio.screechGain.gain.setTargetAtTime(level * 0.15 * base, t, 0.05);
  audio.screechFilter?.frequency.setTargetAtTime(1500 + slip * 950 + v * 400, t, 0.07);
}

function beep(freq: number, duration: number, type: OscillatorType, gain: number, at = 0): void {
  const ctx = audio.ctx;
  if (!ctx || !audio.master) return;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const start = ctx.currentTime + at;
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(gain, start + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(env);
  env.connect(audio.master);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function startNoise(
  ctx: AudioContext,
  destination: AudioNode,
  gain: number,
  type: BiquadFilterType,
  frequency: number,
): AudioBufferSourceNode | null {
  if (!audio.buffer) return null;
  const source = ctx.createBufferSource();
  source.buffer = audio.buffer;
  source.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  const level = ctx.createGain();
  level.gain.value = gain;
  source.connect(filter);
  filter.connect(level);
  level.connect(destination);
  source.start();
  return source;
}

function tone(freq: number, endFreq: number, duration: number, type: OscillatorType, gain: number): void {
  const ctx = audio.ctx;
  if (!ctx || !audio.master) return;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  const start = ctx.currentTime;
  osc.frequency.setValueAtTime(freq, start);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), start + duration);
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(gain, start + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(env);
  env.connect(audio.master);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function noiseBurst(duration: number, gain: number, type: BiquadFilterType, frequency: number, sweep = 1): void {
  const ctx = audio.ctx;
  if (!ctx || !audio.master || !audio.buffer) return;
  const source = ctx.createBufferSource();
  source.buffer = audio.buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.Q.value = 1.2;
  const env = ctx.createGain();
  const start = ctx.currentTime;
  filter.frequency.setValueAtTime(frequency, start);
  filter.frequency.exponentialRampToValueAtTime(Math.max(60, frequency * sweep), start + duration);
  env.gain.setValueAtTime(gain, start);
  env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  source.connect(filter);
  filter.connect(env);
  env.connect(audio.master);
  source.start(start);
  source.stop(start + duration + 0.02);
}

/** Fréquence moteur affichée dans le mode diagnostic. */
export function engineFrequency(): number {
  return audio.osc ? audio.osc.frequency.value : 0;
}

/** Applique volume et muet sans recréer le graphe audio. */
export function setAudioVolume(volume: number, muted: boolean): void {
  if (!audio.ctx) return;
  const v = clamp(volume, 0, 1);
  const target = muted ? 0 : v * v;
  if (audio.master) audio.master.gain.value = target;
  if (audio.wind) audio.wind.gain.value = target;
  if (audio.road) audio.road.gain.value = target;
  if (audio.engine) audio.engine.gain.value = ENGINE_BASE * target;
}

/* --- Effets ponctuels --------------------------------------------------- */

export function tireScreech(intensity: number): void {
  const level = clamp(intensity, 0, 1);
  noiseBurst(0.16 + level * 0.14, 0.05 + level * 0.09, "bandpass", 1500 + level * 700, 0.8);
}

export function crash(intensity: number): void {
  const level = clamp(intensity, 0.2, 1);
  noiseBurst(0.22, 0.22 * level, "lowpass", 420, 0.25);
  tone(140 * level + 60, 42, 0.26, "square", 0.13 * level);
}

export function checkpoint(perfect: boolean): void {
  beep(perfect ? 880 : 620, 0.12, "triangle", 0.12);
  if (perfect) beep(1320, 0.18, "triangle", 0.11, 0.09);
}

export function lap(): void {
  [784, 988, 1175].forEach((f, i) => beep(f, 0.16, "triangle", 0.12, i * 0.08));
}

export function wrongWay(): void {
  tone(520, 300, 0.32, "sawtooth", 0.09);
}

export function land(): void {
  noiseBurst(0.14, 0.14, "lowpass", 260, 0.4);
}

export function finish(): void {
  [659, 784, 988, 1319].forEach((f, i) => beep(f, 0.4, "triangle", 0.14, i * 0.14));
}

