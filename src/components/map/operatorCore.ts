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

// --- the sphere ------------------------------------------------------------
//
// ## Why this is generated rather than modelled
//
// The owner asked for "a 3d model for the core or heart... something new and
// reshaped", and suggested Blender. Blender is the wrong tool for THIS object,
// and the reason is worth writing down so it does not get revisited by
// accident.
//
// A modelled mesh is baked geometry. Loading one means three.js and a GLTF
// loader — a frontend dependency of a few hundred kilobytes, against a stack
// rule that lists six packages and says "nothing else". And the core's entire
// job is to be ALIVE: it swells with the room's volume, turns violet when
// Operator talks, spins faster per concurrent turn. A mesh cannot do any of
// that without something driving it, and the something is what would actually
// be doing the work.
//
// So the geometry is computed. Real 3D — perspective, depth, rotation, points
// on the far side genuinely behind the ones in front — in the canvas 2D context
// already here, with no package added and every point free to move.
//
// Blender remains the right answer the day this wants a MODEL: something with
// a shape nobody would derive from a formula. A sphere of light is not that.

/** Unit-sphere points, evenly spread. Cached per count — the maths never changes. */
const shellCache = new Map<number, Float32Array>();

/**
 * A Fibonacci lattice: the standard way to scatter points on a sphere so that
 * none of them clump.
 *
 * Latitude/longitude would be the obvious construction and is visibly wrong —
 * it crowds both poles and thins the equator, so a rotating sphere appears to
 * have two bright spots welded to its axis.
 */
function shell(count: number): Float32Array {
  const cached = shellCache.get(count);
  if (cached) return cached;

  const points = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    points[i * 3] = Math.cos(theta) * ring;
    points[i * 3 + 1] = y;
    points[i * 3 + 2] = Math.sin(theta) * ring;
  }
  shellCache.set(count, points);
  return points;
}

/**
 * How much the camera exaggerates depth.
 *
 * Small numbers give a fisheye that makes the near face balloon; large ones
 * flatten it back to the disc this replaced. 3.2 keeps the far side clearly
 * behind without the front bulging.
 */
const FOV = 3.2;

/**
 * How many points the shell is made of.
 *
 * Chosen by rendering it and looking. 260 read as scattered dots with gaps you
 * could see through at desk size; the surface closes up somewhere past four
 * hundred, and past eight hundred it stops improving and starts costing. Every one is rotated,
 * projected and sorted each frame, and the phone draws the same core at a much
 * larger radius — so this is the number both budgets have to live with.
 */
function pointsFor(radius: number): number {
  /*
    Density has to follow SIZE, or the phone gets a different object.

    One implementation drawn at two sizes is the whole point of this file — but
    a fixed count means the same points spread over a much larger sphere, and
    rendered on the mobile surface at ~3x the wall display's radius it read as
    a loose scatter where the desk read as a surface. Strictly, constant density
    wants the count to follow area; that reaches four figures fast and costs
    more than it looks. Linear is the compromise, and it closes the gap that was
    actually visible.
  */
  return Math.min(820, Math.round(240 + radius * 2.6));
}

/** One rotated, projected point: screen position, scale, and 0–1 nearness. */
interface Projected {
  x: number;
  y: number;
  scale: number;
  depth: number;
}

function project(
  x: number,
  y: number,
  z: number,
  yaw: number,
  tilt: number,
  radius: number,
): Projected {
  // Yaw first, then tilt. The other order makes the axis wobble rather than
  // lean, which reads as the whole object being unstable.
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = x * cy - z * sy;
  const z1 = x * sy + z * cy;

  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const y1 = y * ct - z1 * st;
  const z2 = y * st + z1 * ct;

  // z2 is -1 (far) to 1 (near). Perspective divide, then normalise depth into
  // 0–1 so brightness and size can both read from it.
  const perspective = FOV / (FOV - z2);
  return {
    x: x1 * radius * perspective,
    y: y1 * radius * perspective,
    scale: perspective,
    depth: (z2 + 1) / 2,
  };
}

/**
 * A great circle through the sphere, drawn segment by segment.
 *
 * Segments rather than one path because each needs its own alpha: a ring drawn
 * at a single opacity looks painted ON the sphere instead of passing through
 * it, and the far half is exactly what tells the eye this has volume.
 */
function greatCircle(
  ctx: CanvasRenderingContext2D,
  colour: Rgb,
  alpha: number,
  radius: number,
  yaw: number,
  tilt: number,
  bank: number,
  segments = 64,
) {
  const cb = Math.cos(bank);
  const sb = Math.sin(bank);
  let previous: Projected | null = null;

  for (let i = 0; i <= segments; i += 1) {
    const t = (i / segments) * Math.PI * 2;
    // A unit circle in the XZ plane, banked over so the rings cross rather
    // than sitting parallel like contour lines.
    const cx = Math.cos(t);
    const cz = Math.sin(t);
    const point = project(cx, cz * sb, cz * cb, yaw, tilt, radius);

    if (previous) {
      const near = (previous.depth + point.depth) / 2;
      ctx.strokeStyle = rgba(colour, alpha * (0.12 + near * near * 0.88));
      ctx.lineWidth = 0.7 + near * 1.6;
      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    previous = point;
  }
}

export interface CoreState {
  /** Frames since mount. Drives rotation and the heartbeat. */
  tick: number;
  /** 0–1. How loud the room is, already normalised against the clap threshold. */
  lift: number;
  /** Operator is talking. */
  speaking: boolean;
  /** A turn is running. */
  busy: boolean;
  /**
   * How many, capped by the caller. 0 when idle.
   *
   * `busy` alone was honest while one turn ran at a time; with concurrency it
   * flattens "thinking" and "thinking about three things" into one picture,
   * and this display exists to say what Operator is doing. Optional so the
   * phone surface, which does not poll job counts, keeps working unchanged.
   */
  load?: number;
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

  /*
    A busier core, literally. Each concurrent turn adds to the floor, so three
    at once is visibly harder work than one — the difference a boolean threw
    away.
  */
  const work = busy ? Math.min(1, 0.45 + Math.max(0, (state.load ?? 1) - 1) * 0.2) : 0;
  const excitement = Math.max(lift, work);
  const colour: Rgb = speaking ? VIOLET : busy && lift === 0 ? THINKING : GOLD;
  // Rings spin faster per concurrent turn, which is the clearest signal of
  // load at a glance and costs nothing to read from across a room.
  const spin = tick * (0.004 + excitement * 0.02) + (busy ? tick * 0.012 * Math.min(2, state.load ?? 1) : 0);
  const pulse = 1 + thump * 0.06 + excitement * 0.16;

  ctx.globalCompositeOperation = "lighter";

  // Outer aura
  /*
    Tighter and dimmer than it was.

    At 3.1 radii it was a dull brown disc a third of the way across the map,
    and against the near-black background that reads as a smudge on the screen
    rather than as light. The sphere now provides the volume the aura was
    standing in for, so the aura only has to say "this is emitting".
  */
  const auraR = R * 2.2 * pulse;
  const aura = ctx.createRadialGradient(0, 0, R * 0.3, 0, 0, auraR);
  aura.addColorStop(0, rgba(colour, 0.13 + excitement * 0.16));
  aura.addColorStop(0.4, rgba(colour, 0.03 + excitement * 0.05));
  aura.addColorStop(1, rgba(colour, 0));
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(0, 0, auraR, 0, Math.PI * 2);
  ctx.fill();

  /*
    The shell: a rotating sphere of points, in real perspective.

    This replaced three flat arc rings. Those relied on GAPS to make rotation
    legible, because a complete circle spinning looks identical to one standing
    still — a workaround for having no depth to show. With depth the problem
    disappears: the far side is genuinely dimmer and smaller, so the rotation
    reads without any trick, and the object has a shape rather than an outline.

    Drawn back to front. Additive blending means overlapping points brighten
    each other, which is the whole reason this is on canvas rather than SVG —
    and near-over-far only looks right if far goes down first.
  */
  const yaw = spin;
  // A slow lean rather than a fixed tilt, so the axis is never quite where you
  // last looked. Small: a sphere that visibly tumbles reads as broken.
  const tilt = 0.42 + Math.sin(tick * 0.0032) * 0.16;
  const shellR = R * 1.62 * pulse;

  const count = pointsFor(R);
  const points = shell(count);
  const projected: Projected[] = [];
  for (let i = 0; i < count; i += 1) {
    /*
      The surface breathes outward with the room.

      Per-point rather than by scaling the whole sphere, and phase-shifted
      around it, so loud speech makes the surface RIPPLE instead of the object
      simply getting bigger. Scaling alone reads as a zoom.
    */
    const wobble =
      1 + excitement * 0.13 * Math.sin(tick * 0.06 + i * 0.7) + thump * 0.02;
    projected.push(
      project(
        points[i * 3] * wobble,
        points[i * 3 + 1] * wobble,
        points[i * 3 + 2] * wobble,
        yaw,
        tilt,
        shellR,
      ),
    );
  }
  projected.sort((a, b) => a.depth - b.depth);

  for (const point of projected) {
    const near = point.depth;
    // Squared, not linear. Linear fading leaves the back of the sphere as a
    // grey haze that fills the middle; the eye wants the far side to fall away
    // faster than that.
    const alpha = (0.06 + near * near * 0.72) * (0.6 + excitement * 0.4);
    /*
      Small. The first version used points nearly twice this size and the
      result read as confetti — individually legible dots rather than a
      surface. Density does the work; size only has to keep the near face from
      disappearing.
    */
    const size = (0.45 + near * 1.15) * point.scale;
    ctx.fillStyle = rgba(colour, alpha);
    ctx.beginPath();
    ctx.arc(point.x, point.y, size, 0, Math.PI * 2);
    ctx.fill();
  }

  /*
    Three great circles, banked so they cross.

    Parallel rings would read as contour lines drawn on the surface. Crossing
    ones read as a frame the points are suspended in, which is the difference
    between a decorated disc and something with an inside.
  */
  /*
    Bright enough to be seen, which the first attempt was not.

    Rendered and looked at: at 0.34 the rings were a suggestion behind the
    points and the object read as a cloud. They are what makes it a FRAME with
    points suspended in it, so they have to hold their own against the shell.
  */
  const strand = 0.62 + excitement * 0.3;
  greatCircle(ctx, colour, strand, shellR, yaw, tilt, 0);
  greatCircle(ctx, colour, strand * 0.8, shellR, yaw * 1.15, tilt, Math.PI / 2.6);
  greatCircle(ctx, colour, strand * 0.65, shellR, yaw * 0.82, tilt, -Math.PI / 3.4);

  /*
    The nucleus, deliberately smaller than it was.

    It used to be 0.82 of the base radius with a white centre, which was right
    when it WAS the core — there was nothing else to look at. Now the shell is
    the object and a nucleus that size drowns it: rendered side by side, the
    sphere read as a halo around a lamp rather than as the thing itself.

    It stays because a hollow shell has no heart, and the heartbeat has to come
    from somewhere the eye reads as the middle.
  */
  const nucleusR = R * 0.58 * pulse;
  const nucleus = ctx.createRadialGradient(0, 0, 0, 0, 0, nucleusR);
  nucleus.addColorStop(0, rgba([255, 255, 255], 0.42 + excitement * 0.4));
  nucleus.addColorStop(0.35, rgba(colour, 0.5 + excitement * 0.3));
  nucleus.addColorStop(1, rgba(colour, 0));
  ctx.fillStyle = nucleus;
  ctx.beginPath();
  ctx.arc(0, 0, nucleusR, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, R * 0.34 * pulse, 0, Math.PI * 2);
  ctx.strokeStyle = rgba(colour, 0.7);
  ctx.lineWidth = 1.2;
  ctx.stroke();
}
