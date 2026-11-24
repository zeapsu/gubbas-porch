import type { MoodId } from "../state/types.ts";
import { midiToHz, MOODS } from "./composer.ts";
import { noiseBuffer, playBell, playPulse, playSine, playWoodTick, stopSource } from "./voices.ts";

export class Ambience {
  private readonly rainSource: AudioBufferSourceNode;
  private readonly rainGain: GainNode;
  private readonly rainHighpass: BiquadFilterNode;
  private readonly rainLowpass: BiquadFilterNode;
  private rain = false;
  private nextPip = Infinity;
  private nextBamboo: number;
  private bambooTipAt = Infinity;
  private nextChime: number;
  private nextAnimal: number;

  constructor(private readonly output: AudioNode, private readonly onBambooTip?: (audioTime: number) => void) {
    const context = output.context;
    const now = context.currentTime;
    this.nextBamboo = now + this.between(45, 90);
    this.nextChime = now + this.between(30, 120);
    this.nextAnimal = now + this.between(18, 40);
    this.rainSource = new AudioBufferSourceNode(context, { buffer: noiseBuffer(context), loop: true });
    this.rainGain = new GainNode(context, { gain: 0 });
    this.rainHighpass = new BiquadFilterNode(context, { type: "highpass", frequency: 400 });
    this.rainLowpass = new BiquadFilterNode(context, { type: "lowpass", frequency: 2500 });
    this.rainSource.connect(this.rainHighpass).connect(this.rainLowpass).connect(this.rainGain).connect(output);
    this.rainSource.start();
  }

  private between(min: number, max: number): number {
    return min + (max - min) * Math.random();
  }

  setRain(on: boolean): void {
    if (this.rain === on) return;
    this.rain = on;
    const at = this.output.context.currentTime;
    this.rainGain.gain.setTargetAtTime(on ? 0.09 : 0, at, 0.2);
    this.nextPip = on ? at + this.between(0.9, 4) : Infinity;
  }

  tick(now: number, horizon: number, mood: MoodId): void {
    if (this.bambooTipAt <= now) {
      const at = this.bambooTipAt;
      this.bambooTipAt = Infinity;
      this.onBambooTip?.(at);
    }
    if (this.nextBamboo < horizon) {
      const at = Math.max(now, this.nextBamboo);
      this.nextBamboo = at + this.between(45, 90);
      this.bambooTipAt = at;
      playPulse(this.output, at, 320, 0.09, 0.14, 0.125, 180);
      playWoodTick(this.output, at, 0.09);
      playPulse(this.output, at + 0.18, 220, 0.065, 0.045, 0.125, 150);
    }
    if (this.nextChime < horizon) {
      const at = Math.max(now, this.nextChime);
      this.nextChime = at + this.between(30, 120);
      const { root, scale } = MOODS[mood];
      const count = Math.floor(this.between(3, 6));
      for (let i = 0; i < count; i++) {
        const semitone = scale[Math.floor(this.between(0, scale.length))]!;
        playBell(this.output, at + i * 0.23, midiToHz(root + 24 + semitone), 0.036);
      }
    }
    if (this.nextPip < horizon) {
      const at = Math.max(now, this.nextPip);
      this.nextPip = at + this.between(0.9, 4);
      playSine(this.rainGain, at, this.between(1500, 3000), 0.07, 0.14);
    }
    if (this.nextAnimal < horizon) {
      const at = Math.max(now, this.nextAnimal);
      this.nextAnimal = at + (mood === "moonlit" ? this.between(2, 6) : this.between(38, 85));
      if (mood === "morning") {
        playSine(this.output, at, 1520, 0.12, 0.027, 2240);
        playSine(this.output, at + 0.15, 2190, 0.1, 0.023, 1770);
      } else if (mood === "moonlit") {
        for (let i = 0; i < 3; i++) playPulse(this.output, at + i * 0.09, 4000, 0.04, 0.009, 0.125);
      }
    }
  }

  dispose(): void {
    stopSource(this.rainSource, this.output.context.currentTime, this.rainGain, this.rainHighpass, this.rainLowpass);
  }
}
