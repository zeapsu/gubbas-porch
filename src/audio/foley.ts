import type { StrokeTelemetry } from "../rakes/types.ts";
import { noiseBuffer, playLiftWhisper, playStoneThud, playWoodTick, stopSource } from "./voices.ts";

type FoleyInput = Pick<StrokeTelemetry, "speed" | "tineCount" | "tineWidth" | "tineDepth" | "changeRatio" | "crossing">;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
function smoothstep(min: number, max: number, value: number): number {
  const t = clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}

/** screenX is normalized across the viewport, from 0 on the left to 1 on the right. */
export function computeFoleyParams(telemetry: FoleyInput & { screenX?: number }, screenX = telemetry.screenX ?? 0.5) {
  const { speed, tineCount, tineWidth, tineDepth, changeRatio, crossing } = telemetry;
  const speedGain = smoothstep(4, 140, speed);
  return {
    gain: clamp(0.32 * Math.sqrt(Math.max(0, tineCount)) / 3 * speedGain
      * (0.55 + 0.45 * clamp(changeRatio, 0, 1)), 0, 1),
    bandpassHz: clamp(5200 / (0.6 + 0.5 * tineWidth) * (1 + 0.2 * clamp(speed, 0, 200) / 200), 400, 6000),
    bandpassQ: clamp(1.6 - 0.08 * tineCount, 0.6, 1.6),
    grainHz: clamp(speed / 2, 4, 90),
    grainDepth: 0.35 * (1 - smoothstep(60, 160, speed)) + 0.3 * clamp(crossing, 0, 1),
    weightGain: 0.028 * clamp(tineDepth - 1, 0, 2) * speedGain,
    pan: 1.2 * clamp(screenX, 0, 1) - 0.6,
  };
}

export class FoleyNode {
  private readonly noise: AudioBufferSourceNode;
  private readonly bandpass: BiquadFilterNode;
  private readonly grain: OscillatorNode;
  private readonly modulation: GainNode;
  private readonly grainGain: GainNode;
  private readonly scrape: GainNode;
  private readonly weight: OscillatorNode;
  private readonly weightGain: GainNode;
  private readonly pan: StereoPannerNode;
  private active = false;
  private hitStone = false;
  private lastTok = -Infinity;
  private gain = 0;

  constructor(private readonly output: AudioNode) {
    const context = output.context;
    this.noise = new AudioBufferSourceNode(context, { buffer: noiseBuffer(context), loop: true });
    this.bandpass = new BiquadFilterNode(context, { type: "bandpass", frequency: 3000, Q: 1 });
    this.grain = new OscillatorNode(context, { type: "square", frequency: 4 });
    this.modulation = new GainNode(context, { gain: 0 });
    this.grainGain = new GainNode(context);
    this.scrape = new GainNode(context, { gain: 0 });
    this.weight = new OscillatorNode(context, { type: "triangle", frequency: 70 });
    this.weightGain = new GainNode(context, { gain: 0 });
    this.pan = new StereoPannerNode(context);
    this.noise.connect(this.bandpass).connect(this.grainGain).connect(this.scrape).connect(this.pan);
    this.grain.connect(this.modulation).connect(this.grainGain.gain);
    this.weight.connect(this.weightGain).connect(this.pan).connect(output);
    this.noise.start();
    this.grain.start();
    this.weight.start();
  }

  update(telemetry: StrokeTelemetry | null, screenX: number): void {
    const at = this.output.context.currentTime;
    if (!telemetry?.active) {
      if (this.active) playLiftWhisper(this.pan, at);
      this.scrape.gain.setTargetAtTime(0, at, 0.12);
      this.weightGain.gain.setTargetAtTime(0, at, 0.12);
      this.active = this.hitStone = false;
      this.gain = 0;
      return;
    }
    const params = computeFoleyParams(telemetry, screenX);
    this.pan.pan.setTargetAtTime(params.pan, at, 0.03);
    if (!this.active) playWoodTick(this.pan, at);
    if (telemetry.hitStone && !this.hitStone && at - this.lastTok >= 0.12) {
      playStoneThud(this.pan, at);
      this.lastTok = at;
    }
    this.active = true;
    this.hitStone = telemetry.hitStone;
    const response = params.gain >= this.gain ? 0.03 : 0.12;
    this.gain = params.gain;
    this.scrape.gain.setTargetAtTime(params.gain, at, response);
    this.bandpass.frequency.setTargetAtTime(Math.min(params.bandpassHz, this.output.context.sampleRate / 2), at, 0.03);
    this.bandpass.Q.setTargetAtTime(params.bandpassQ, at, 0.03);
    this.grain.frequency.setTargetAtTime(params.grainHz, at, 0.03);
    this.modulation.gain.setTargetAtTime(params.grainDepth / 2, at, 0.03);
    this.grainGain.gain.setTargetAtTime(1 - params.grainDepth / 2, at, 0.03);
    this.weightGain.gain.setTargetAtTime(params.weightGain, at, response);
  }

  dispose(): void {
    const at = this.output.context.currentTime;
    stopSource(this.noise, at, this.bandpass, this.grainGain, this.scrape, this.pan);
    stopSource(this.grain, at, this.modulation);
    stopSource(this.weight, at, this.weightGain);
  }
}
