import type { MoodId, NoteEvent } from "../state/types.ts";
import { events, isDrone, midiToHz, MOODS } from "./composer.ts";

type Duty = 0.125 | 0.25 | 0.5;
const waves = new WeakMap<BaseAudioContext, Map<Duty, PeriodicWave>>();
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

export function pulseWave(context: BaseAudioContext, duty: Duty): PeriodicWave {
  let cache = waves.get(context);
  if (!cache) {
    cache = new Map();
    waves.set(context, cache);
  }
  const cached = cache.get(duty);
  if (cached) return cached;
  const real = new Float32Array(33);
  const imaginary = new Float32Array(33);
  for (let n = 1; n <= 32; n++) imaginary[n] = 2 * Math.sin(n * Math.PI * duty) / (n * Math.PI);
  const wave = context.createPeriodicWave(real, imaginary);
  cache.set(duty, wave);
  return wave;
}

export function noiseBuffer(context: BaseAudioContext): AudioBuffer {
  const cached = noiseBuffers.get(context);
  if (cached) return cached;
  const buffer = context.createBuffer(1, 2 * context.sampleRate, context.sampleRate);
  const samples = buffer.getChannelData(0);
  let register = 0x7fff;
  for (let index = 0; index < samples.length; index += 4) {
    const feedback = (register ^ (register >>> 1)) & 1;
    register = (register >>> 1) | (feedback << 14);
    samples.fill((register & 1) * 2 - 1, index, index + 4);
  }
  noiseBuffers.set(context, buffer);
  return buffer;
}

export function stopSource(source: AudioScheduledSourceNode, at: number, ...nodes: AudioNode[]): void {
  source.addEventListener("ended", () => {
    source.disconnect();
    for (const node of nodes) node.disconnect();
  }, { once: true });
  source.stop(at);
}

function envelope(
  output: AudioNode, at: number, duration: number, peak: number, attack: number, release?: number,
): GainNode {
  const gain = new GainNode(output.context, { gain: 0 });
  const end = at + duration;
  const peakAt = at + Math.min(attack, duration / 3);
  gain.gain.setTargetAtTime(0, at, 0.001);
  gain.gain.linearRampToValueAtTime(peak, peakAt);
  if (release === undefined) {
    gain.gain.setTargetAtTime(0, peakAt, duration / 6);
    gain.gain.setTargetAtTime(0, end - duration / 10, duration / 60);
  } else {
    gain.gain.linearRampToValueAtTime(peak, Math.max(peakAt, end - release));
    gain.gain.linearRampToValueAtTime(0, end);
  }
  gain.connect(output);
  return gain;
}

export function playPulse(
  output: AudioNode, at: number, hz: number, duration: number, velocity: number, duty: Duty, endHz = hz,
): void {
  const osc = new OscillatorNode(output.context, { frequency: hz, periodicWave: pulseWave(output.context, duty) });
  osc.frequency.setValueAtTime(hz, at);
  osc.frequency.linearRampToValueAtTime(endHz, at + duration);
  const gain = envelope(output, at, duration, velocity, 0.005);
  osc.connect(gain);
  osc.start(at);
  stopSource(osc, at + duration, gain);
}

export function playTriangleDrone(output: AudioNode, at: number, hz: number, duration: number, velocity: number): void {
  const osc = new OscillatorNode(output.context, { type: "triangle", frequency: hz });
  const gain = envelope(output, at, duration, velocity, 2, 3);
  osc.connect(gain);
  osc.start(at);
  stopSource(osc, at + duration, gain);
}

export function playSine(
  output: AudioNode, at: number, hz: number, duration: number, velocity: number, endHz = hz,
): void {
  const osc = new OscillatorNode(output.context, { frequency: hz });
  osc.frequency.setValueAtTime(hz, at);
  osc.frequency.linearRampToValueAtTime(endHz, at + duration);
  const gain = envelope(output, at, duration, velocity, 0.002);
  osc.connect(gain);
  osc.start(at);
  stopSource(osc, at + duration, gain);
}

export function playBell(output: AudioNode, at: number, hz: number, velocity: number, duration = 3): void {
  playSine(output, at, hz, duration, velocity);
  playSine(output, at, 2.76 * hz, duration, velocity * 0.26);
}

function playNoise(
  output: AudioNode, at: number, duration: number, hz: number, peak: number, attack: number, pan = false,
): void {
  const context = output.context;
  const buffer = noiseBuffer(context);
  const source = new AudioBufferSourceNode(context, { buffer, loop: duration > buffer.duration });
  const filter = new BiquadFilterNode(context, { type: "lowpass", frequency: hz });
  const gain = envelope(output, at, duration, peak, attack, pan ? duration * 0.48 : undefined);
  source.connect(filter);
  if (pan) {
    const panner = new StereoPannerNode(context, { pan: -0.6 });
    panner.pan.setValueAtTime(-0.6, at);
    panner.pan.linearRampToValueAtTime(0.6, at + duration);
    filter.connect(panner).connect(gain);
    source.addEventListener("ended", () => panner.disconnect(), { once: true });
  } else {
    filter.connect(gain);
  }
  source.start(at);
  stopSource(source, at + duration, filter, gain);
}

export function playWoodTick(output: AudioNode, at: number, velocity = 0.12): void {
  playNoise(output, at, 0.01, 1200, velocity, 0.001);
}

export function playRakeClack(output: AudioNode, at: number): void {
  playWoodTick(output, at);
  playPulse(output, at, 290, 0.055, 0.045, 0.25, 185);
}

export function playStoneThud(output: AudioNode, at: number): void {
  playNoise(output, at, 0.045, 950, 0.12, 0.002);
  playSine(output, at, 175, 0.08, 0.09, 96);
}

export function playLiftWhisper(output: AudioNode, at: number): void {
  playNoise(output, at, 0.06, 4400, 0.045, 0.008);
}

export function playSweepWhoosh(output: AudioNode, at: number, duration = 2.4): void {
  playNoise(output, at, duration, 3100, 0.14, duration * 0.45, true);
  playWoodTick(output, at + duration);
}

export function playNote(output: AudioNode, drone: AudioNode, mood: MoodId, note: NoteEvent, at: number): void {
  const { bpm, duty } = MOODS[mood];
  const duration = note.durationBeats * 60 / bpm;
  const hz = midiToHz(note.midi);
  if (isDrone(note)) {
    playTriangleDrone(drone, at, hz, duration, note.velocity);
  } else if (note.voice === "bell") {
    playBell(output, at, hz, note.velocity, duration);
  } else if (note.voice === "triangle") {
    const osc = new OscillatorNode(output.context, { type: "triangle", frequency: hz });
    if (mood === "morning") {
      const frequencies = Float32Array.from({ length: 48 }, (_, i) =>
        hz * (1 + 0.003 * Math.sin(2 * Math.PI * 5 * (i / 47) * duration)));
      osc.frequency.setValueCurveAtTime(frequencies, at, duration);
    }
    const gain = envelope(output, at, duration, note.velocity, 0.15, 0.32);
    osc.connect(gain);
    osc.start(at);
    stopSource(osc, at + duration, gain);
  } else {
    playPulse(output, at, hz, duration, note.velocity * (note.voice === "pulseB" ? 0.35 : 1), duty);
  }
}

export function renderOfflinePreview(seed: number, mood: MoodId, bars: number, sampleRate = 44100): Promise<AudioBuffer> {
  const endBeat = bars * 4;
  const secondsPerBeat = 60 / MOODS[mood].bpm;
  const context = new OfflineAudioContext(1, Math.ceil(endBeat * secondsPerBeat * sampleRate), sampleRate);
  const lowpass = new BiquadFilterNode(context, { type: "lowpass", frequency: 9000 });
  lowpass.connect(new DynamicsCompressorNode(context)).connect(context.destination);
  for (const note of events(seed, mood, 0, endBeat)) {
    playNote(lowpass, lowpass, mood, note, note.beat * secondsPerBeat);
  }
  return context.startRendering();
}
