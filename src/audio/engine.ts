import type { StrokeTelemetry } from "../rakes/types.ts";
import type { AudioMix, MoodId } from "../state/types.ts";
import { Ambience } from "./ambience.ts";
import { events, isDrone, midiToHz, MOODS } from "./composer.ts";
import { FoleyNode } from "./foley.ts";
import { playNote, playRakeClack, playStoneThud, playSweepWhoosh, playTriangleDrone } from "./voices.ts";

const DEFAULT_MIX: AudioMix = { master: 5, music: 4, foley: 6, ambience: 4, muted: false };
const MIX_RAMP_SECONDS = 0.08;

export function mixGain(step: number, muted = false): number {
  return muted ? 0 : (Math.max(0, Math.min(7, step)) / 7) ** 2;
}

function rampGain(gain: AudioParam, value: number, now: number, seconds = MIX_RAMP_SECONDS): void {
  if (typeof gain.cancelAndHoldAtTime === "function") {
    gain.cancelAndHoldAtTime(now);
  } else {
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
  }
  gain.linearRampToValueAtTime(value, now + seconds);
}

export interface AudioEngineOptions {
  seed?: number;
  mood?: MoodId;
  mix?: AudioMix;
  rain?: boolean;
  onBambooTip?: (audioTime: number) => void;
}

export class AudioEngine {
  private readonly seed: number;
  private readonly onBambooTip: AudioEngineOptions["onBambooTip"];
  private mood: MoodId;
  private mix: AudioMix;
  private rain: boolean;
  private breath = 0;
  private disposed = false;
  private graph: ReturnType<AudioEngine["createGraph"]> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private musicStart = 0;
  private nextBeat = 0;
  private retired: { lane: GainNode; drone: GainNode; end: number }[] = [];

  constructor(options: AudioEngineOptions = {}) {
    this.seed = options.seed ?? 0;
    this.mood = options.mood ?? "morning";
    this.mix = { ...(options.mix ?? DEFAULT_MIX) };
    this.rain = options.rain ?? false;
    this.onBambooTip = options.onBambooTip;
  }

  private createGraph(context: AudioContext) {
    const master = new GainNode(context, { gain: 0 });
    const music = new GainNode(context, { gain: mixGain(this.mix.music) });
    const foleyBus = new GainNode(context, { gain: mixGain(this.mix.foley) });
    const ambienceBus = new GainNode(context, { gain: mixGain(this.mix.ambience) });
    const musicFade = new GainNode(context, { gain: 0 });
    const lane = new GainNode(context);
    const drone = new GainNode(context, { gain: 1 + 0.16 * this.breath });
    const lowpass = new BiquadFilterNode(context, { type: "lowpass", frequency: 9000 });
    const compressor = new DynamicsCompressorNode(context);
    drone.connect(lane).connect(musicFade).connect(music).connect(master);
    foleyBus.connect(master);
    ambienceBus.connect(master);
    master.connect(lowpass).connect(compressor).connect(context.destination);
    return {
      context, master, music, foleyBus, ambienceBus, musicFade, lane, drone, lowpass, compressor,
      foley: new FoleyNode(foleyBus),
      ambience: new Ambience(ambienceBus, this.onBambooTip),
    };
  }

  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (!this.graph) {
      const context = new AudioContext();
      this.graph = this.createGraph(context);
      this.musicStart = context.currentTime + 0.03;
      rampGain(this.graph.musicFade.gain, 1, this.musicStart, 8);
      this.applyMix();
      this.graph.ambience.setRain(this.rain);
      document.addEventListener("visibilitychange", this.schedule);
      this.timer = setInterval(this.schedule, 40);
    }
    const { context } = this.graph;
    if (context.state !== "running") await context.resume();
    this.schedule();
  }

  private schedule = (): void => {
    const graph = this.graph;
    if (!graph || graph.context.state !== "running") return;
    const now = graph.context.currentTime;
    const horizon = now + (document.hidden ? 2 : 0.2);
    this.retired = this.retired.filter(({ lane, drone, end }) => {
      if (end > now) return true;
      drone.disconnect();
      lane.disconnect();
      return false;
    });
    const secondsPerBeat = 60 / MOODS[this.mood].bpm;
    const untilBeat = (horizon - this.musicStart) / secondsPerBeat;
    if (untilBeat > this.nextBeat) {
      const elapsed = (now - this.musicStart) / secondsPerBeat;
      // Skip stale onsets after a scheduler stall, while restoring a still-sounding drone.
      if (elapsed > this.nextBeat + 0.1 / secondsPerBeat) {
        const phraseStart = Math.floor(elapsed / 16) * 16;
        if (phraseStart >= this.nextBeat && phraseStart < elapsed) {
          for (const note of events(this.seed, this.mood, phraseStart, phraseStart + 0.01)) {
            if (isDrone(note)) {
              playTriangleDrone(graph.drone, now, midiToHz(note.midi),
                (phraseStart + note.durationBeats - elapsed) * secondsPerBeat, note.velocity);
            }
          }
        }
        this.nextBeat = Math.max(this.nextBeat, elapsed);
      }
      for (const note of events(this.seed, this.mood, this.nextBeat, untilBeat)) {
        playNote(graph.lane, graph.drone, this.mood, note, Math.max(now, this.musicStart + note.beat * secondsPerBeat));
      }
      this.nextBeat = untilBeat;
    }
    graph.ambience.tick(now, horizon, this.mood);
  };

  private applyMix(): void {
    const graph = this.graph;
    if (!graph) return;
    const now = graph.context.currentTime;
    rampGain(graph.master.gain, mixGain(this.mix.master, this.mix.muted), now);
    rampGain(graph.music.gain, mixGain(this.mix.music), now);
    rampGain(graph.foleyBus.gain, mixGain(this.mix.foley), now);
    rampGain(graph.ambienceBus.gain, mixGain(this.mix.ambience), now);
  }

  setMix(mix: AudioMix): void {
    this.mix = { ...mix };
    this.applyMix();
  }

  setMute(muted: boolean): void {
    this.mix.muted = muted;
    this.applyMix();
  }

  setMood(mood: MoodId): void {
    if (mood === this.mood) return;
    this.mood = mood;
    const graph = this.graph;
    if (!graph) return;
    const now = graph.context.currentTime;
    rampGain(graph.lane.gain, 0, now);
    this.retired.push({ lane: graph.lane, drone: graph.drone, end: now + MIX_RAMP_SECONDS });
    graph.lane = new GainNode(graph.context);
    graph.drone = new GainNode(graph.context, { gain: 1 + 0.16 * this.breath });
    graph.drone.connect(graph.lane).connect(graph.musicFade);
    this.musicStart = now + MIX_RAMP_SECONDS;
    this.nextBeat = 0;
    this.schedule();
  }

  setBreathAmplitude(amplitude: number): void {
    this.breath = Math.max(0, Math.min(1, amplitude));
    const graph = this.graph;
    if (graph) graph.drone.gain.setTargetAtTime(1 + 0.16 * this.breath, graph.context.currentTime, 0.15);
  }

  setRain(on: boolean): void {
    this.rain = on;
    this.graph?.ambience.setRain(on);
  }

  updateFoley(telemetry: StrokeTelemetry | null, screenX = 0.5): void {
    this.graph?.foley.update(telemetry, screenX);
  }

  playRakeClack(): void {
    const graph = this.graph;
    if (graph) playRakeClack(graph.foleyBus, graph.context.currentTime);
  }

  playStoneThud(): void {
    const graph = this.graph;
    if (graph) playStoneThud(graph.foleyBus, graph.context.currentTime);
  }

  playSweepWhoosh(duration?: number): void {
    const graph = this.graph;
    if (graph) playSweepWhoosh(graph.foleyBus, graph.context.currentTime, duration);
  }

  getDebugState(): { state: AudioContextState | "locked"; masterGain: number } {
    return {
      state: this.disposed ? "closed" : this.graph?.context.state ?? "locked",
      masterGain: this.graph?.master.gain.value ?? 0,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    const graph = this.graph;
    if (!graph) return;
    this.graph = undefined;
    document.removeEventListener("visibilitychange", this.schedule);
    graph.foley.dispose();
    graph.ambience.dispose();
    for (const { drone, lane } of this.retired) {
      drone.disconnect();
      lane.disconnect();
    }
    this.retired = [];
    for (const node of [graph.drone, graph.lane, graph.musicFade, graph.music, graph.foleyBus,
      graph.ambienceBus, graph.master, graph.lowpass, graph.compressor]) node.disconnect();
    await graph.context.close();
  }
}
