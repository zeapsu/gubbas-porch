import { deflect, includeRect, stamp } from "../sand/index.ts";
import type { SandFootprint, SandGrid, SandRect, SandVec2, StampResult } from "../sand/index.ts";
import type { RakeSpec, StrokePatch, StrokeStartContext, StrokeTelemetry } from "./types.ts";

type Pointer = "mouse" | "touch" | "pen";
type StartContext = StrokeStartContext & { heading?: number };

export interface StrokeEngine {
  begin(p: SandVec2, rake: RakeSpec, pointer: Pointer, ctx: StartContext): void;
  /** The telemetry is reused on the next call. */
  extend(points: readonly SandVec2[], dtMs: number): StrokeTelemetry;
  /** Flushes the endpoint. The returned bounds include any final grid writes. */
  end(): StrokePatch;
}

const NO_STONES: readonly SandFootprint[] = [];
const emptyRect = (): SandRect => ({ x: 0, y: 0, w: 0, h: 0 });

export function createStrokeEngine(grid: SandGrid): StrokeEngine {
  const beforeHeight = new Int8Array(grid.height.length);
  const beforeDir = new Uint8Array(grid.dir.length);
  const press = { x: 0, y: 0 };
  const pointerLast = { x: 0, y: 0 };
  const pathLast = { x: 0, y: 0 };
  const projected = { x: 0, y: 0 };
  const sample = { x: 0, y: 0 };
  const head = { x: 0, y: 0 };
  const tail = { x: 0, y: 0 };
  const pending: SandVec2[] = [];
  const batchRect = emptyRect();
  const strokeRect = emptyRect();
  const stampRect = emptyRect();
  const outputRect = emptyRect();
  const telemetry: StrokeTelemetry = {
    active: false,
    speed: 0,
    tineCount: 0,
    tineWidth: 0,
    tineDepth: 0,
    changeRatio: 0,
    crossing: 0,
    head: { x: 0, y: 0 },
    tail: { x: 0, y: 0 },
    heading: 0,
    hitStone: false,
    dirtyRect: null,
  };
  const stats: StampResult = { dirtyRect: null, touched: 0, changed: 0, crossingSum: 0 };
  let rake: RakeSpec | undefined;
  let ctx: StartContext = { stones: NO_STONES, flow: false };
  let waitingForTouch = false;
  let started = false;
  let orbit: SandFootprint | undefined;
  let orbitRadius = 0;
  let orbitAngle = 0;
  let orbitTurn = 1;
  let heading = 0;
  let speed = 0;
  let ds = 0.5;
  let carry = 0;
  let arc = 0;
  let touched = 0;
  let changed = 0;
  let crossingSum = 0;
  let hitStone = false;
  let touchingStone = false;

  function project(p: SandVec2, out: SandVec2): void {
    deflect(p, ctx.stones, out);
    const contact = p.x !== out.x || p.y !== out.y;
    if (contact && !touchingStone) hitStone = true;
    touchingStone = contact;
  }

  function carve(x: number, y: number, tangent?: number): void {
    const tool = rake!;
    head.x = x;
    head.y = y;
    if (tangent !== undefined) {
      heading = tangent;
    } else if (x !== tail.x || y !== tail.y) {
      heading = Math.atan2(y - tail.y, x - tail.x);
    }
    tail.x = x - tool.handle * Math.cos(heading);
    tail.y = y - tool.handle * Math.sin(heading);

    const wave = tool.wave ? tool.wave.amp * Math.sin(2 * Math.PI * arc / tool.wave.len) : 0;
    stamp(grid, x, y, heading, tool, wave, ctx.stones, ctx.flow && !orbit, stats, stampRect);
    touched += stats.touched;
    changed += stats.changed;
    crossingSum += stats.crossingSum;
    if (stats.dirtyRect) {
      const { x, y, w, h } = stats.dirtyRect;
      includeRect(batchRect, x, y, w, h);
      includeRect(strokeRect, x, y, w, h);
    }
  }

  function start(initialHeading: number): void {
    started = true;
    heading = initialHeading;
    if (orbit) {
      orbitAngle = Math.atan2(pathLast.y - orbit.y, pathLast.x - orbit.x);
      orbitTurn = Math.sin(initialHeading - orbitAngle) < 0 ? -1 : 1;
      heading = orbitAngle + orbitTurn * Math.PI / 2;
    }
    tail.x = pathLast.x - rake!.handle * Math.cos(heading);
    tail.y = pathLast.y - rake!.handle * Math.sin(heading);
    carve(pathLast.x, pathLast.y, heading);
    arc = ds;
  }

  function walkTo(x: number, y: number): void {
    const dx = x - pathLast.x;
    const dy = y - pathLast.y;
    const distance = Math.hypot(dx, dy);
    if (!distance) return;
    let offset = carry;
    for (; offset <= distance; offset += ds) {
      sample.x = pathLast.x + dx * (offset / distance);
      sample.y = pathLast.y + dy * (offset / distance);
      // A chord connecting two points on a footprint can dip inside it.
      deflect(sample, ctx.stones, head);
      carve(head.x, head.y);
      arc += ds;
    }
    carry = offset - distance;
    pathLast.x = x;
    pathLast.y = y;
  }

  function follow(p: SandVec2, from: SandVec2, distance: number): void {
    if (orbit) {
      if (p.x === orbit.x && p.y === orbit.y) return;
      const targetAngle = Math.atan2(p.y - orbit.y, p.x - orbit.x);
      const delta = Math.atan2(Math.sin(targetAngle - orbitAngle), Math.cos(targetAngle - orbitAngle));
      const length = Math.abs(delta) * orbitRadius;
      if (!length) return;
      orbitTurn = Math.sign(delta);
      let offset = carry;
      for (; offset <= length; offset += ds) {
        const angle = orbitAngle + orbitTurn * offset / orbitRadius;
        sample.x = orbit.x + orbitRadius * Math.cos(angle);
        sample.y = orbit.y + orbitRadius * Math.sin(angle);
        project(sample, head);
        carve(head.x, head.y, angle + orbitTurn * Math.PI / 2);
        arc += ds;
      }
      carry = offset - length;
      orbitAngle = targetAngle;
      return;
    }

    if (!ctx.stones.length) {
      walkTo(p.x, p.y);
      return;
    }

    // Check the intervening pointer path even when both ends of a long jump
    // are clear of stones. The projected path gets its own fixed-step sampler.
    const count = Math.ceil(distance / ds);
    for (let i = 1; i <= count; i++) {
      const fraction = i / count;
      sample.x = from.x + (p.x - from.x) * fraction;
      sample.y = from.y + (p.y - from.y) * fraction;
      project(sample, projected);
      walkTo(projected.x, projected.y);
    }
  }

  return {
    begin(p, tool, pointer, context) {
      rake = tool.action ? undefined : tool;
      ctx = context;
      press.x = pointerLast.x = p.x;
      press.y = pointerLast.y = p.y;
      pending.length = 0;
      waitingForTouch = pointer === "touch";
      started = false;
      batchRect.w = strokeRect.w = 0;
      orbit = undefined;
      arc = speed = 0;
      touchingStone = hitStone = false;
      if (!rake) return;
      beforeHeight.set(grid.height);
      beforeDir.set(grid.dir);

      project(p, pathLast);
      if (tool.orbit) {
        let nearest = 40;
        for (const stone of ctx.stones) {
          const distance = Math.hypot(p.x - stone.x, p.y - stone.y);
          if (distance <= nearest) {
            orbit = stone;
            nearest = distance;
          }
        }
        if (orbit) orbitRadius = Math.hypot(pathLast.x - orbit.x, pathLast.y - orbit.y);
      }
      ds = Math.min(0.5, 1 / (1 + tool.headWidth / 2 / tool.handle));
      carry = ds;
      heading = context.heading ?? 0;
      head.x = pathLast.x;
      head.y = pathLast.y;
      tail.x = head.x - tool.handle * Math.cos(heading);
      tail.y = head.y - tool.handle * Math.sin(heading);
    },

    extend(points, dtMs) {
      batchRect.w = 0;
      touched = changed = crossingSum = 0;
      let distance = 0;

      if (rake) {
        if (!started && !waitingForTouch && ctx.heading !== undefined) start(ctx.heading);
        for (const p of points) {
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
          const segment = Math.hypot(p.x - pointerLast.x, p.y - pointerLast.y);
          if (!segment || !Number.isFinite(segment)) continue;
          distance += segment;
          if (!started) {
            const fromPress = Math.hypot(p.x - press.x, p.y - press.y);
            if (waitingForTouch && fromPress < 3) {
              pending.push({ x: p.x, y: p.y });
            } else {
              start(Math.atan2(p.y - press.y, p.x - press.x));
              let previous = press;
              for (const point of pending) {
                follow(point, previous, Math.hypot(point.x - previous.x, point.y - previous.y));
                previous = point;
              }
              pending.length = 0;
              follow(p, previous, Math.hypot(p.x - previous.x, p.y - previous.y));
            }
          } else {
            follow(p, pointerLast, segment);
          }
          pointerLast.x = p.x;
          pointerLast.y = p.y;
        }
        if (dtMs > 0) speed += (distance * 1000 / dtMs - speed) * -Math.expm1(-dtMs / 50);
      }

      telemetry.active = started;
      telemetry.speed = speed;
      telemetry.tineCount = rake?.tineCount ?? 0;
      telemetry.tineWidth = rake?.tineWidth ?? 0;
      telemetry.tineDepth = rake?.tineDepth ?? 0;
      telemetry.changeRatio = touched ? changed / touched : 0;
      telemetry.crossing = touched ? crossingSum / touched : 0;
      telemetry.head.x = head.x;
      telemetry.head.y = head.y;
      telemetry.tail.x = tail.x;
      telemetry.tail.y = tail.y;
      telemetry.heading = heading;
      telemetry.hitStone = started && hitStone;
      telemetry.dirtyRect = batchRect.w ? Object.assign(outputRect, batchRect) : null;
      if (started) hitStone = false;
      return telemetry;
    },

    end() {
      if (rake && !started && !waitingForTouch) start(heading);
      // Close the last fractional step only on release, so frame boundaries
      // cannot affect which cells a stroke writes.
      if (rake && started && carry < ds - 1e-9) {
        arc -= carry;
        if (orbit) {
          sample.x = orbit.x + orbitRadius * Math.cos(orbitAngle);
          sample.y = orbit.y + orbitRadius * Math.sin(orbitAngle);
          deflect(sample, ctx.stones, head);
          carve(head.x, head.y, orbitAngle + orbitTurn * Math.PI / 2);
        } else {
          carve(pathLast.x, pathLast.y);
        }
      }
      rake = undefined;
      speed = 0;
      hitStone = false;
      started = false;
      const rect = strokeRect.w ? { ...strokeRect } : emptyRect();
      strokeRect.w = 0;
      const length = rect.w * rect.h;
      const patch: StrokePatch = {
        rect,
        beforeHeight: new Int8Array(length),
        beforeDir: new Uint8Array(length),
        afterHeight: new Int8Array(length),
        afterDir: new Uint8Array(length),
      };
      for (let row = 0; row < rect.h; row++) {
        const index = (rect.y + row) * grid.w + rect.x;
        const offset = row * rect.w;
        patch.beforeHeight.set(beforeHeight.subarray(index, index + rect.w), offset);
        patch.beforeDir.set(beforeDir.subarray(index, index + rect.w), offset);
        patch.afterHeight.set(grid.height.subarray(index, index + rect.w), offset);
        patch.afterDir.set(grid.dir.subarray(index, index + rect.w), offset);
      }
      return patch;
    },
  };
}
