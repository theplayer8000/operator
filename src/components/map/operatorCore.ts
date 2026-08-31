/**
 * Operator's core — the thing at the centre of the map, and the whole of the
 * mobile surface.
 *
 * Extracted from `MissionMap` when the owner decided what he wanted on a
 * phone: *"just the core on its own for voice interactivty"*. No graph, no
 * nodes — the map is a big-screen view and he has said so twice. What survives
 * onto a phone is the part that tells you Operator is alive and listening.
 *
 * One implementation, drawn at two sizes, so the heartbeat cannot drift
 * between the wall display and the thing in his pocket.
 *
 * ## The four states, and why they are drawn rather than written
 *
 *   idle      slow gold heartbeat — alive, nothing happening
 *   hearing   swells and brightens with the voice
 *   speaking  violet, a steadier and more deliberate rhythm
 *   thinking  a turn is running: the rings accelerate, shifted cool blue
 *
 * The point is reading it from across a room, or from the corner of your eye
 * while you say something. A label would need looking at.
 *
 * Thinking draws on top of the voice states rather than instead of them —
 * Operator can perfectly well be listening while it works, and hiding one
 * behind the other would make the display lie.
 */

export type Rgb = [number, number, number];

export const GOLD: Rgb = [232, 176, 77];
export const VIOLET: Rgb = [141, 127, 224];
/** Thinking: cool blue, only when nothing louder is happening. */
export const THINKING: Rgb = [120, 200, 232];

export const rgba = (c: Rgb, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export interface CoreState {
  /** Frames since mount. Drives rotation and the heartbeat. */
  tick: number;
  /** 0–1. How loud the room is, already normalised against the clap threshold. */
  lift: number;
  /** Operator is talking. */
  speaking: boolean;
  /** A turn is running. */
  busy: boolean;
  /** Base radius. ~62 on the wall display, much larger on a phone. */
  radius: number;
}

/**
 * Draw the core at the current canvas origin.
 *
 * The caller is responsible for translating to where it wants the centre, and
 * for restoring the composite operation afterwards — this leaves it on
 * "lighter", because everything drawn around it wants that too.
 */
export function drawCore(ctx: CanvasRenderingContext2D, state: CoreState) {
  const { tick, lift, speaking, busy, radius: R } = state;

  /*
    A resting heartbeat: two beats close together, then a pause.

    A plain sine wave reads as breathing, which is a different living thing.
    Two offset gaussians is the shape of a pulse, and at rest that is what this
    should look like — something ticking over, not something inhaling.
  */
  const beat = (tick % 150) / 150;
  const thump =
    Math.exp(-Math.pow((beat - 0.08) * 14, 2)) +
    0.55 * Math.exp(-Math.pow((beat - 0.24) * 14, 2));

  const excitement = Math.max(lift, busy ? 0.45 : 0);
  const colour: Rgb = speaking ? VIOLET : busy && lift === 0 ? THINKING : GOLD;
  const spin = tick * (0.004 + excitement * 0.02) + (busy ? tick * 0.012 : 0);
  const pulse = 1 + thump * 0.06 + excitement * 0.16;

  ctx.globalCompositeOperation = "lighter";

  // Outer aura
  const aura = ctx.createRadialGradient(0, 0, R * 0.3, 0, 0, R * 3.1 * pulse);
  aura.addColorStop(0, rgba(colour, 0.16 + excitement * 0.2));
  aura.addColorStop(0.45, rgba(colour, 0.05 + excitement * 0.07));
  aura.addColorStop(1, rgba(colour, 0));
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(0, 0, R * 3.1 * pulse, 0, Math.PI * 2);
  ctx.fill();

  /*
    Counter-rotating arc rings. The GAPS are what make rotation legible — a
    complete circle spinning looks identical to one standing still.
  */
  for (let ring = 0; ring < 3; ring++) {
    const rr = R * (1.35 + ring * 0.42) * pulse;
    const dir = ring % 2 === 0 ? 1 : -1;
    const arcs = 3 + ring;
    ctx.lineWidth = ring === 0 ? 2.2 : 1.3;
    ctx.strokeStyle = rgba(colour, (0.5 - ring * 0.11) * (0.55 + excitement * 0.45));
    for (let k = 0; k < arcs; k++) {
      const from = spin * dir + (k / arcs) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(0, 0, rr, from, from + (Math.PI * 2) / arcs - 0.55);
      ctx.stroke();
    }
  }

  // Nucleus
  const nucleus = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.82 * pulse);
  nucleus.addColorStop(0, rgba([255, 255, 255], 0.5 + excitement * 0.4));
  nucleus.addColorStop(0.35, rgba(colour, 0.62 + excitement * 0.3));
  nucleus.addColorStop(1, rgba(colour, 0));
  ctx.fillStyle = nucleus;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.82 * pulse, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, R * 0.5 * pulse, 0, Math.PI * 2);
  ctx.strokeStyle = rgba(colour, 0.75);
  ctx.lineWidth = 1.4;
  ctx.stroke();
}
