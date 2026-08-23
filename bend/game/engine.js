// The game's engine. No three.js, no DOM — pure geometry, so the browser and
// the headless verifier run the identical code. Nothing here is scripted: the
// pipe is walked through real arcs at the true bend radius, and every
// consequence falls out of that.
//
// This is a port of conduit_core.primitives.pipe_centerline. It is checked
// against the Python original point for point by packages/game/test_game.py —
// if the two ever disagree the build fails.

import { CONSTANTS } from '../core/constants.js';

export const ARC_STEP = 3.0; // degrees per polyline segment; matches core
const RAD = Math.PI / 180;

// The 3/4" specialisations of core's tables, not second copies of them — and
// named so, because a bare RADIUS in a consumer reads like a second copy.
export const SIZE = CONSTANTS.DEFAULT_SIZE;
export const BEND_RADIUS = CONSTANTS.RADIUS[SIZE];
export const PIPE_OD = CONSTANTS.OD[SIZE];
// Named PIPE_SIZES and not SIZES: SIZES is a name core owns outright, and
// redeclaring one of those is drift by definition even when the value is read
// straight back off core. The list itself still comes from core.
export const PIPE_SIZES = CONSTANTS.SIZES;
// Low voltage, so the game offers 1/2" and 3/4" and nothing else. The engine
// still does all four — core has the figures and there is no reason to lose
// them — but the picker and the build gate read this one list, so a size
// nobody can select is never a size the build has to prove. Filtered off core
// rather than typed out, so a size that vanished upstream vanishes here.
export const PLAYABLE_SIZES = CONSTANTS.SIZES.filter(
  (s) => s === '1/2' || s === '3/4',
);
// Named CONDUIT because STICK, BUNDLE and COUPLING are core's names now, and
// redeclaring one of those in a consumer is drift by definition. The values
// still come straight off core.
export const CONDUIT = {
  connectorInset: CONSTANTS.CONNECTOR_INSET,
  stick: CONSTANTS.STICK,
  bundle: CONSTANTS.BUNDLE,
  coupling: CONSTANTS.COUPLING,
};
export const radiusOf = (size) => CONSTANTS.RADIUS[size];
export const odOf = (size) => CONSTANTS.OD[size];

// A bigger pipe rests higher, and whatever the level put at resting height
// moves up with it. One place does that shift so the page and the verifier
// cannot disagree about where the deck is. Shifting by the difference rather
// than snapping to rest keeps a deliberately elevated target where it was.
export function levelAtSize(level, size) {
  const lift = odOf(size) / 2 - PIPE_OD / 2;
  return {
    ...level,
    start: [level.start[0], level.start[1] + lift],
    target: { ...level.target, at: [level.target.at[0], level.target.at[1] + lift] },
    obstructions: level.obstructions.map((o) => ({ ...o })),
  };
}
export const SCALE = CONSTANTS.BENDER.scale;
const S3_OUTER = CONSTANTS.SADDLE3_OUTER_ANGLE;
const S3_CENTRE = CONSTANTS.SADDLE3_CENTER_ANGLE;

// ------------------------------------------------------------------ geometry

// Walk a stick of `cutLength` through `bends`, each {at, angle}. `at` is the
// distance along the raw uncut stick to where that bend's arc begins; a
// positive angle bends up. Shrink and take-up are not applied here — they are
// what this walk produces.
export function centerline(bends, cutLength, start = [0, 0], radius = BEND_RADIUS) {
  const pts = [[start[0], start[1]]];
  let x = start[0];
  let y = start[1];
  let heading = 0;
  let consumed = 0;

  const ordered = [...bends].sort((a, b) => a.at - b.at);
  for (const { at, angle } of ordered) {
    const run = at - consumed;
    if (run < -1e-9) {
      return {
        points: pts,
        ok: false,
        message: `The bend at ${at.toFixed(2)}" starts inside the arc of the `
          + `bend before it. Move it back at least ${(-run).toFixed(2)}", or `
          + 'use a smaller angle.',
      };
    }
    x += run * Math.cos(heading);
    y += run * Math.sin(heading);
    pts.push([x, y]);

    const sweep = angle * RAD;
    const steps = Math.max(2, Math.floor(Math.abs(angle) / ARC_STEP) + 1);
    const sgn = angle >= 0 ? 1 : -1;
    const cx = x - sgn * radius * Math.sin(heading);
    const cy = y + sgn * radius * Math.cos(heading);
    for (let k = 1; k <= steps; k += 1) {
      const a = heading + (sweep * k) / steps;
      x = cx + sgn * radius * Math.sin(a);
      y = cy - sgn * radius * Math.cos(a);
      pts.push([x, y]);
    }
    heading += sweep;
    consumed = at + radius * Math.abs(sweep);
  }

  const tail = cutLength - consumed;
  if (tail < -1e-9) {
    return {
      points: pts,
      ok: false,
      message: `The stick runs out ${(-tail).toFixed(2)}" before the last bend `
        + `finishes. Cut at least ${consumed.toFixed(2)}".`,
    };
  }
  x += tail * Math.cos(heading);
  y += tail * Math.sin(heading);
  pts.push([x, y]);
  return { points: pts, ok: true, message: '' };
}

export function headingAfter(bends) {
  return bends.reduce((sum, b) => sum + b.angle, 0);
}

// Straight-line distance from start to finish, versus how much pipe it took.
// The gap is shrink, and it is the thing that decides whether you land in the
// box — which is why the player cuts the stick rather than being handed one.
export function shrinkOf(result, cutLength) {
  const pts = result.points;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const straight = Math.hypot(b[0] - a[0], b[1] - a[1]);
  // Shrink is how much shorter the run gets than the pipe you used, and it
  // only means that while the run still points the way it started. Turn a
  // corner and the straight line between the ends is the hypotenuse of an L,
  // which is not shrink and is not a number anybody can act on — corner-rise
  // was reporting "cut over by 12.14"" and meaning nothing by it.
  const dir = (p, q) => Math.atan2(q[1] - p[1], q[0] - p[0]);
  const turned = Math.abs(dir(a, pts[1]) - dir(pts[pts.length - 2], b));
  const parallel = Math.min(turned, Math.abs(2 * Math.PI - turned)) < 1 * RAD;
  return {
    straight, cut: cutLength, over: cutLength - straight, parallel,
  };
}

function distanceToBox(p, box) {
  const dx = Math.max(box.x0 - p[0], 0, p[0] - box.x1);
  const dy = Math.max(box.y0 - p[1], 0, p[1] - box.y1);
  return Math.hypot(dx, dy);
}

function pointToSegment(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0
    : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

function segmentsCross(a, b, c, d) {
  const side = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1])
    - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

// Distance from a length of pipe to a box. Has to be the segment, not its
// endpoints: a straight run is two points, so checking vertices lets a stick
// pass clean through a housekeeping pad and call it a fit.
function segmentToBox(a, b, box) {
  const corners = [[box.x0, box.y0], [box.x1, box.y0],
    [box.x1, box.y1], [box.x0, box.y1]];
  for (let i = 0; i < 4; i += 1) {
    if (segmentsCross(a, b, corners[i], corners[(i + 1) % 4])) return 0;
  }
  let best = Math.min(distanceToBox(a, box), distanceToBox(b, box));
  for (const c of corners) best = Math.min(best, pointToSegment(c, a, b));
  return best;
}

// The same length of pipe against a round obstruction — another pipe crossing
// your path. Distance to a circle is distance to its centre less its radius.
// The box's width is the diameter and its top edge is the top of the pipe, so
// the two shapes read off the same two numbers. Clamped at 0 exactly as the
// box case reports a crossing, so "goes through" still comes out right.
function segmentToRound(a, b, o) {
  const r = (o.x1 - o.x0) / 2;
  const centre = [(o.x0 + o.x1) / 2, o.y1 - r];
  return Math.max(0, pointToSegment(centre, a, b) - r);
}

const clearanceTo = (a, b, o) => (o.shape === 'pipe'
  ? segmentToRound(a, b, o)
  : segmentToBox(a, b, o));

// ---------------------------------------------------------------- the bender

// A port of primitives.bender_primitives, both levels of it.
// detail='schematic' is one shoe arc, a centreline pipe and a stub hook — what
// the terminal draws. detail='detailed' appends the casting: tapered rim, the
// two lightening windows, the sight scale, the handle socket, heel and pedal,
// and the curl on the hook lip. Appends, strictly, so the schematic head is
// still in there untouched. test_game.py compares both against the Python
// original prim for prim, and core's own test freezes the schematic one
// against the v0.2-bender-schematic tag.
//
// Origin is the arrow at the start of the bend, +X along the long run, +Y up.
// The head rotates about the shoe centre by the bend angle — that is the real
// motion, and it is why the arrow finishes at the pipe exit.

// Body angle of the sight-scale mark for `value` degrees — placed so that
// when the bend reaches `value`, that mark comes to rest on the long run.
function scaleBody(value, r, size) {
  const rs = r + CONSTANTS.OD[size] / 2 + CONSTANTS.HEAD.scale_out;
  return -(Math.acos(r / rs) * 180) / Math.PI - value;
}

function on(bodyDeg, r, rot, cx, cy) {
  const t = ((bodyDeg + rot) * Math.PI) / 180;
  return [cx + r * Math.sin(t), cy - r * Math.cos(t)];
}

function arcPrims(lo, hi, r, rot, cx, cy, kind, step = ARC_STEP) {
  const steps = Math.max(2, Math.trunc(Math.abs(hi - lo) / step) + 1);
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    pts.push(on(lo + ((hi - lo) * i) / steps, r, rot, cx, cy));
  }
  const out = [];
  for (let i = 0; i < steps; i += 1) {
    out.push({ tag: 'seg', a: pts[i], b: pts[i + 1], kind });
  }
  return out;
}

function taperPrims(lo, hi, rOf, rot, cx, cy, kind) {
  const steps = Math.max(2, Math.trunc(Math.abs(hi - lo) / ARC_STEP) + 1);
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const b = lo + ((hi - lo) * i) / steps;
    pts.push(on(b, rOf(b), rot, cx, cy));
  }
  const out = [];
  for (let i = 0; i < steps; i += 1) {
    out.push({ tag: 'seg', a: pts[i], b: pts[i + 1], kind });
  }
  return out;
}

// The 841A casting, appended to the schematic head exactly as Python appends
// it. Decoration in the strict sense: none of it moves the pipe or the marks.
function detailPrims(angle, r, od, cx, cy, rg, size) {
  const H = CONSTANTS.HEAD;
  const [lo, hi] = H.shoe_body;
  const rimR = (b) => rg + H.rim_deep
    + ((H.rim - H.rim_deep) * (b - lo)) / (hi - lo);
  let out = taperPrims(lo, hi, rimR, angle, cx, cy, 'shoe');
  for (const b of [lo, hi]) {
    out.push({ tag: 'seg', a: on(b, rg, angle, cx, cy), b: on(b, rimR(b), angle, cx, cy), kind: 'shoe' });
  }

  const inset = H.window_inset;
  for (const [a, b] of H.windows) {
    out = out.concat(arcPrims(a, b, rg + inset, angle, cx, cy, 'window'));
    out = out.concat(taperPrims(a, b, (x) => rimR(x) - inset, angle, cx, cy, 'window'));
    for (const edge of [a, b]) {
      out.push({
        tag: 'seg',
        a: on(edge, rg + inset, angle, cx, cy),
        b: on(edge, rimR(edge) - inset, angle, cx, cy),
        kind: 'window',
      });
    }
  }

  for (const v of CONSTANTS.BENDER.scale) {
    const b = scaleBody(v, r, size);
    out.push({
      tag: 'seg', a: on(b, rg, angle, cx, cy), b: on(b, rg + H.tick, angle, cx, cy), kind: 'scale_tick',
    });
  }
  const sb = H.star_body;
  const mid = rg + H.tick / 2;
  out.push({ tag: 'seg', a: on(sb - 3, mid, angle, cx, cy), b: on(sb + 3, mid, angle, cx, cy), kind: 'scale_tick' });
  out.push({ tag: 'seg', a: on(sb, rg, angle, cx, cy), b: on(sb, rg + H.tick, angle, cx, cy), kind: 'scale_tick' });

  out = out.concat(arcPrims(0.0, 360.0, H.socket_r, angle, cx, cy, 'socket', 15.0));

  const pb = H.pedal_body;
  const pr = rg + H.rim;
  const base = on(pb, pr, angle, cx, cy);
  const heel = on(pb, pr + H.heel_len, angle, cx, cy);
  out.push({ tag: 'seg', a: base, b: heel, kind: 'heel' });
  const tan = ((pb + angle) * Math.PI) / 180;
  const along = [Math.cos(tan), Math.sin(tan)];
  const far = [heel[0] + H.pedal_len * along[0], heel[1] + H.pedal_len * along[1]];
  const wide = [(-along[1] * H.pedal_wide) / 2, (along[0] * H.pedal_wide) / 2];
  const corners = [
    [heel[0] + wide[0], heel[1] + wide[1]],
    [far[0] + wide[0], far[1] + wide[1]],
    [far[0] - wide[0], far[1] - wide[1]],
    [heel[0] - wide[0], heel[1] - wide[1]],
  ];
  for (let i = 0; i < 4; i += 1) {
    out.push({ tag: 'seg', a: corners[i], b: corners[(i + 1) % 4], kind: 'pedal' });
  }

  out = out.concat(arcPrims(H.hook_body, H.hook_body - H.hook_curl,
                            rg + H.hook_len, angle, cx, cy, 'hook'));
  return out;
}

const mirror = (p) => (p === null ? null : [-p[0], p[1]]);

export function benderPrimitives(angle, opts = {}) {
  const {
    facing = 'right', glyph = 'arrow', size = SIZE,
    backRun = 14.0, freeRun = 10.0, handleLen = null, detail = 'schematic',
  } = opts;
  const radius = opts.radius === undefined ? null : opts.radius;
  // The scale reads to 90 and the casting has nowhere to put a bend past it.
  if (!(angle >= 0 && angle <= 90)) {
    throw new Error(`${angle}° is not a bend this bender makes. The scale `
      + `reads ${CONSTANTS.BENDER.scale.join('/')}, and direction is which way `
      + 'it faces, not a negative angle.');
  }
  const r = radius === null ? CONSTANTS.RADIUS[size] : radius;
  const od = CONSTANTS.OD[size];
  const cx = 0.0;
  const cy = r;
  const rg = r + od / 2; // shoe groove face
  const H = CONSTANTS.HEAD;
  let out = [];

  // Pipe: long run behind the arrow, the bend itself, the free end.
  const t = (angle * Math.PI) / 180;
  out.push({ tag: 'seg', a: [-backRun, 0.0], b: [0.0, 0.0], kind: 'pipe' });
  out = out.concat(arcPrims(0.0, angle, r, 0.0, cx, cy, 'pipe'));
  const e = on(angle, r, 0.0, cx, cy);
  out.push({
    tag: 'seg',
    a: e,
    b: [e[0] + freeRun * Math.cos(t), e[1] + freeRun * Math.sin(t)],
    kind: 'pipe',
  });

  const [lo, hi] = H.shoe_body;
  out = out.concat(arcPrims(lo, hi, rg, angle, cx, cy, 'shoe'));

  const hb = H.hook_body;
  out.push({
    tag: 'seg',
    a: on(hb, rg, angle, cx, cy),
    b: on(hb, rg + H.hook_len, angle, cx, cy),
    kind: 'hook',
  });
  out.push({ tag: 'pt', a: on(hb, rg + H.hook_len, angle, cx, cy), b: null, kind: 'hook' });

  const hl = handleLen === null ? H.handle_len : handleLen;
  out.push({
    tag: 'seg',
    a: [cx, cy],
    b: on(H.handle_body, hl, angle, cx, cy),
    kind: 'handle',
  });
  out.push({ tag: 'pt', a: [cx, cy], b: null, kind: 'hub' });

  const marks = { arrow: 0.0, star: H.star_body, notch: H.notch_body };
  if (glyph in marks) {
    const rr = rg + (glyph === 'notch' ? od : od / 2);
    out.push({ tag: 'pt', a: on(marks[glyph], rr, angle, cx, cy), b: null, kind: glyph });
  }

  if (detail === 'detailed') {
    out = out.concat(detailPrims(angle, r, od, cx, cy, rg, size));
  } else if (detail !== 'schematic') {
    throw new Error(`detail is 'schematic' or 'detailed', not '${detail}'.`);
  }

  if (facing === 'left') {
    out = out.map((p) => ({ tag: p.tag, a: mirror(p.a), b: mirror(p.b), kind: p.kind }));
  } else if (facing !== 'right') {
    throw new Error(`facing is 'left' or 'right', not '${facing}'.`);
  }
  return out;
}

// End-on view of the stick: the circle, plus the tab you sight the roll by.
// Up means the stick is how you marked it; down means you have rolled it.
export function rollView(rolled, facing = 'right') {
  const tab = rolled ? 30.0 : 150.0;
  let prims = arcPrims(0.0, 360.0, 1.0, 0.0, 0.0, 0.0, 'pipe');
  prims.push({
    tag: 'seg', a: on(tab, 1.0, 0.0, 0.0, 0.0), b: on(tab, 1.7, 0.0, 0.0, 0.0), kind: 'arrow',
  });
  prims.push({ tag: 'pt', a: [0.0, 0.0], b: null, kind: 'hub' });
  if (facing === 'left') {
    prims = prims.map((p) => ({ tag: p.tag, a: mirror(p.a), b: mirror(p.b), kind: p.kind }));
  }
  return prims;
}

export function boundsOf(prims) {
  const xs = [];
  const ys = [];
  for (const p of prims) {
    for (const q of [p.a, p.b]) {
      if (q) { xs.push(q[0]); ys.push(q[1]); }
    }
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// A port of sequences.deltas: per bending step, 'first', 'same' or 'reversed'
// against the one before. The confusion is never which way is left, it is
// whether that changed since the last bend — which is exactly what the row
// strip has to answer. In the game a bend's direction is the sign of its
// angle, so that is what facing comes from here.
export const facingOf = (angle) => (angle < 0 ? 'left' : 'right');

export function deltas(bends) {
  const out = [];
  let prev = null;
  for (const b of bends) {
    const facing = facingOf(b.angle);
    out.push(prev === null ? 'first' : (facing === prev ? 'same' : 'reversed'));
    prev = facing;
  }
  return out;
}

// ------------------------------------------------------------------ the tape

// A port of conduit_core.calc.frac, and the second copy of a formatting rule
// this repo would otherwise have no guard on. test_game.py runs both over one
// shared fixture list and compares the strings, so they cannot drift.
//
// Display and input only. Nothing above this line rounds to a sixteenth — the
// geometry keeps full precision and the tape is what you read off it.

// Python's round() goes to even on an exact half and JavaScript's does not.
// 0.5 -> 0 there, 1 here, which is a divergence on every exact thirty-second.
function roundHalfEven(v) {
  const down = Math.floor(v);
  const rest = v - down;
  if (rest > 0.5) return down + 1;
  if (rest < 0.5) return down;
  return down % 2 === 0 ? down : down + 1;
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

export function frac(x, denom = 16) {
  const sign = x < 0 ? '-' : '';
  const n = roundHalfEven(Math.abs(x) * denom);
  const whole = Math.floor(n / denom);
  const rem = n % denom;
  let body;
  if (rem) {
    const g = gcd(rem, denom);
    body = whole ? `${whole}-${rem / g}/${denom / g}` : `${rem / g}/${denom / g}`;
  } else {
    body = String(whole);
  }
  return `${sign}${body}"`;
}

// What a tech actually writes on a stick. All four of these are the same
// number and all four are typed in the field, so all four go in.
export const INCHES_HELP = 'Write it as 14-1/2, 14 1/2, 14.5 or 29/2.';

export function inches(text) {
  const s = String(text).trim().replace(/"$/, '').trim();
  if (!s) return null;
  const whole = s.match(/^(-?)(\d+)[-\s]+(\d+)\/(\d+)$/);
  if (whole) {
    const d = Number(whole[4]);
    if (!d) return null;
    const v = Number(whole[2]) + Number(whole[3]) / d;
    return whole[1] ? -v : v;
  }
  const only = s.match(/^(-?)(\d+)\/(\d+)$/);
  if (only) {
    const d = Number(only[3]);
    if (!d) return null;
    const v = Number(only[2]) / d;
    return only[1] ? -v : v;
  }
  if (/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return Number(s);
  return null;
}

// -------------------------------------------------------------------- fitting

// Does this stick land the job? Every failure says which test it was and by
// how much, because "does not fit" is not something you can act on.
export function fit(level, solution) {
  const { bends = [], cut, size = SIZE } = solution;
  const cl = centerline(bends, cut, level.start, radiusOf(size));
  const failures = [];
  if (!cl.ok) {
    return { pass: false, centerline: cl, failures: [{ test: 'geometry', by: 0, message: cl.message }] };
  }

  const pts = cl.points;
  const end = pts[pts.length - 1];
  const wall = odOf(size) / 2;

  // The level says what stick you have. Without this the engine happily
  // accepts a 40-foot cut and only complains that it missed the box, which
  // sends the player looking in the wrong place.
  if (cut < level.stick.min || cut > level.stick.max) {
    failures.push({
      test: 'a stick you actually have',
      by: cut < level.stick.min ? level.stick.min - cut : cut - level.stick.max,
      message: `You cut ${cut.toFixed(2)}" and this one gives you `
        + `${level.stick.min}" to ${level.stick.max}".`,
    });
  }

  // A connector threads into the knockout and the pipe slides into its body,
  // so the pipe stops short of the box wall and the fitting spans the gap.
  // The target is the box; what the pipe has to reach is an inch before it,
  // measured back along the heading it arrives on. A target that is not a box
  // — a rail, a concrete penetration — says so and gets no inset.
  const inset = level.target.connector === false
    ? 0 : CONSTANTS.CONNECTOR_INSET;
  const aimAngle = level.target.heading * RAD;
  const aim = [
    level.target.at[0] - inset * Math.cos(aimAngle),
    level.target.at[1] - inset * Math.sin(aimAngle),
  ];
  const off = Math.hypot(end[0] - aim[0], end[1] - aim[1]);
  if (off > level.target.tolerance) {
    failures.push({
      test: 'lands in the box',
      by: off - level.target.tolerance,
      message: `The end is ${off.toFixed(2)}" from where it needs to stop and `
        + `the tolerance is ${level.target.tolerance.toFixed(2)}". `
        + (inset
          ? `The pipe finishes ${frac(inset)} short of the box wall — the `
            + 'connector spans that. Adjust the cut.'
          : 'Adjust the cut.'),
    });
  }

  const heading = headingAfter(bends);
  const skew = Math.abs(heading - level.target.heading);
  if (skew > level.target.angleTolerance) {
    failures.push({
      test: 'goes in straight',
      by: skew - level.target.angleTolerance,
      message: `The run arrives ${skew.toFixed(1)}° off the box and the `
        + `tolerance is ${level.target.angleTolerance.toFixed(1)}°. Your bends `
        + 'do not add up to the angle you need.',
    });
  }

  for (const box of level.obstructions) {
    let worst = Infinity;
    for (let i = 0; i < pts.length - 1; i += 1) {
      worst = Math.min(worst, clearanceTo(pts[i], pts[i + 1], box) - wall);
    }
    if (worst < box.clearance) {
      failures.push({
        test: `clears the ${box.label}`,
        by: box.clearance - worst,
        message: worst < 0
          ? `The pipe goes through the ${box.label}.`
          : `Only ${worst.toFixed(2)}" from the ${box.label}, and it needs `
            + `${box.clearance.toFixed(2)}".`,
      });
    }
  }

  // Couplings. A run longer than a stick is ordinary; where the joint lands
  // is the part that is not free. Each arc eats radius x angle of stick, and
  // a coupling is 2" of fitting that cannot bend, so it needs straight pipe
  // 1" either side of where the two cut ends butt.
  const joints = [...(solution.couplings || [])].sort((a, b) => a - b);
  const engage = CONSTANTS.COUPLING.engage;
  const arcs = bends.map((b) => [b.at, b.at + radiusOf(size) * Math.abs(b.angle) * RAD]);
  const pieces = [0, ...joints, cut];
  for (let i = 0; i < pieces.length - 1; i += 1) {
    const len = pieces[i + 1] - pieces[i];
    if (len > CONSTANTS.STICK + 1e-9) {
      failures.push({
        test: 'pieces off a ten-foot stick',
        by: len - CONSTANTS.STICK,
        message: `Piece ${i + 1} is ${len.toFixed(2)}" and a stick is `
          + `${CONSTANTS.STICK}". Cut it and join it with a coupling.`,
      });
    }
  }
  if (pieces.length - 1 > CONSTANTS.BUNDLE) {
    failures.push({
      test: 'a bundle you can carry',
      by: (pieces.length - 1) - CONSTANTS.BUNDLE,
      message: `That is ${pieces.length - 1} pieces and a bundle is `
        + `${CONSTANTS.BUNDLE}.`,
    });
  }
  for (const j of joints) {
    if (j - engage < -1e-9 || j + engage > cut + 1e-9) {
      failures.push({
        test: 'couplings on the pipe',
        by: Math.max(engage - j, j + engage - cut),
        message: `A coupling at ${j.toFixed(2)}" hangs off the end of the run. `
          + `It needs ${engage.toFixed(0)}" of pipe each side of the joint.`,
      });
      continue;
    }
    const hit = arcs.find(([s, e]) => j + engage > s + 1e-9 && j - engage < e - 1e-9);
    if (hit) {
      failures.push({
        test: 'couplings on straight pipe',
        by: Math.min(j + engage - hit[0], hit[1] - (j - engage)),
        message: `A coupling at ${j.toFixed(2)}" lands on the bend that runs `
          + `${hit[0].toFixed(2)}" to ${hit[1].toFixed(2)}". You cannot bend a `
          + 'fitting — move the joint clear of the arc.',
      });
    }
  }
  for (let i = 0; i < joints.length - 1; i += 1) {
    const gap = joints[i + 1] - joints[i];
    if (gap < CONSTANTS.COUPLING.length - 1e-9) {
      failures.push({
        test: 'couplings clear of each other',
        by: CONSTANTS.COUPLING.length - gap,
        message: `Two couplings ${gap.toFixed(2)}" apart overlap. A coupling is `
          + `${CONSTANTS.COUPLING.length}" long.`,
      });
    }
  }

  let lowest = Infinity;
  for (const p of pts) lowest = Math.min(lowest, p[1] - wall);
  if (lowest < level.deck - 1e-6) {
    failures.push({
      test: 'stays off the deck',
      by: level.deck - lowest,
      message: `The pipe drops ${(level.deck - lowest).toFixed(2)}" below the `
        + 'deck. Nothing goes under the surface it runs on.',
    });
  }

  return { pass: failures.length === 0, centerline: cl, failures };
}

// The smallest rise anything can have: two 90s with their arcs touching.
// Falls out of the radius, so a level asking for less is impossible.
// Find an answer at a given size. Size changes the bend radius and the radius
// moves the marks, not just the cut — feed-line's third mark is an arc length
// worked out at 5-1/8", and that arc is shorter on 1/2". So walk the marks as
// well, with the cut re-solved inside each trial.
//
// One implementation, called by both the page's "show me one that works" and
// verify.mjs's build gate. A second copy of this search is the drift problem
// again, in the one file that already carries a second copy of the geometry.
export function solveFit(level, solution, size = SIZE) {
  const at = levelAtSize(level, size);
  const angles = solution.bends.map((b) => b.angle);

  // The shipped answer first. At the size it was worked out for it is the
  // proof, and re-deriving it would only wobble the cut for no reason.
  if (solution.cut !== undefined) {
    const asShipped = fit(at, { bends: solution.bends, cut: solution.cut, size });
    if (asShipped.pass) {
      return { pass: true, bends: solution.bends, cut: solution.cut };
    }
  }

  const score = (marks) => {
    for (let i = 1; i < marks.length; i += 1) {
      if (marks[i] <= marks[i - 1]) return { bad: Infinity, pass: false };
    }
    const bends = marks.map((m, i) => ({ at: m, angle: angles[i] }));
    const found = solveCut(at, bends, size);
    if (found === null) return { bad: Infinity, pass: false };
    const r = fit(at, { bends, cut: found.cut, size });
    return {
      bad: r.pass ? 0 : r.failures.reduce((s, f) => s + f.by, 0),
      pass: r.pass,
      bends,
      cut: found.cut,
    };
  };

  let marks = solution.bends.map((b) => b.at);
  let best = score(marks);
  for (let step = 4; step >= 0.02 && !best.pass; step /= 2) {
    let moved = true;
    while (moved && !best.pass) {
      moved = false;
      for (let i = 0; i < marks.length; i += 1) {
        for (const d of [-step, step]) {
          const trial = marks.slice();
          trial[i] += d;
          if (trial[i] < 0) continue;
          const s = score(trial);
          if (s.bad < best.bad - 1e-9) {
            best = s;
            marks = trial;
            moved = true;
          }
        }
      }
    }
  }
  return best;
}

// Where a coupling is allowed to sit: the straight pipe, less 1" either side
// of every arc and every end. This is the "can I join it here?" question in
// one place, so the page can answer it instead of making you guess and be
// told no.
export function couplingWindows(bends, cut, size = SIZE) {
  const engage = CONSTANTS.COUPLING.engage;
  const blocked = bends
    .map((b) => [b.at - engage, b.at + radiusOf(size) * Math.abs(b.angle) * RAD + engage])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  let at = engage;
  for (const [s, e] of blocked) {
    if (s > at) out.push([at, Math.min(s, cut - engage)]);
    at = Math.max(at, e);
  }
  if (at < cut - engage) out.push([at, cut - engage]);
  return out.filter(([lo, hi]) => hi - lo > 1e-9);
}

// A joint every stick at most, put as late as the windows allow so each piece
// runs as long as it can. Returns null when the run cannot be jointed legally.
export function suggestCouplings(bends, cut, size = SIZE) {
  const windows = couplingWindows(bends, cut, size);
  const out = [];
  let start = 0;
  while (cut - start > CONSTANTS.STICK + 1e-9) {
    const limit = start + CONSTANTS.STICK;
    // The last legal spot at or before the limit, and clear of the one before.
    let best = null;
    for (const [lo, hi] of windows) {
      const spot = Math.min(hi, limit);
      if (spot >= lo - 1e-9 && spot > start + 1e-9
          && (out.length === 0 || spot - out[out.length - 1] >= CONSTANTS.COUPLING.length)) {
        if (best === null || spot > best) best = spot;
      }
    }
    if (best === null) return null;
    out.push(best);
    start = best;
  }
  return out;
}

export function minimumRise() {
  return 2 * BEND_RADIUS;
}

// ------------------------------------------------------------------- levels

// `solution` is not a hint for the player, it is the proof that the level has
// an answer. packages/game/verify.mjs runs every one of them through fit()
// and the build fails if any level cannot be solved.
// A stick lying on the deck has its centreline one radius up, not on the
// surface. Getting this wrong buries half the pipe and every level fails the
// deck test by exactly PIPE_OD/2.
const REST = PIPE_OD / 2;
// A 22.5 bend eats this much stick. The three-point saddle needs it because a
// 45 eats twice as much, so evenly spaced marks do not balance and the run
// never comes back to the height it started at.
const ARC22 = BEND_RADIUS * (S3_OUTER * Math.PI / 180);

export const LEVELS = [
  {
    id: 'feed-line',
    title: 'Cross a feed line',
    brief: 'A feed line runs across your path. Get over it and back down to the '
      + 'deck, and land in the box on the far side.',
    start: [0, REST],
    deck: 0,
    obstructions: [
      { label: 'feed line', x0: 26, x1: 30, y0: 0, y1: 2.5, clearance: 0.5 },
    ],
    target: { at: [56, REST], heading: 0, tolerance: 0.5, angleTolerance: 1 },
    stick: { min: 40, max: 80 },
    teaches: 'A three-point saddle. Note where the third mark goes: a 45 eats '
      + 'twice the stick a 22.5 does, so evenly spaced marks would leave the '
      + 'run sitting high.',
    solution: {
      bends: [
        { at: 14, angle: S3_OUTER },
        { at: 28, angle: -S3_CENTRE },
        { at: 42 + ARC22, angle: S3_OUTER },
      ],
      cut: 57.03,
    },
  },
  {
    id: 'housekeeping-pad',
    title: 'Clear a housekeeping pad',
    brief: 'A concrete pad, 4" proud and nearly two feet wide. A three-point '
      + 'will not sit on that — run two offsets back to back.',
    start: [0, REST],
    deck: 0,
    obstructions: [
      { label: 'pad', x0: 24, x1: 46, y0: 0, y1: 4, clearance: 0.5 },
    ],
    target: { at: [71, REST], heading: 0, tolerance: 0.5, angleTolerance: 1 },
    stick: { min: 60, max: 100 },
    // Deliberately does not state the sequence. Whether you roll between the
    // pairs or turn the bender around is an open question in this repo,
    // pinned by test_four_point_sequence_PROVISIONAL_two_rolls and waiting on
    // a real stick. This one is public, so it says what is known and stops.
    teaches: 'A four-point saddle: two offsets back to back. Both the same '
      + 'angle, or the run does not come back level. How you get from the '
      + 'first pair to the second — roll the stick, or turn the bender around '
      + '— is not settled here. Pull one and see.',
    solution: {
      bends: [
        { at: 10, angle: 30 },
        { at: 22, angle: -30 },
        { at: 48, angle: -30 },
        { at: 60, angle: 30 },
      ],
      cut: 72.98,
    },
  },
  {
    id: 'corner-rise',
    title: 'Make a corner rise',
    brief: 'Run along the deck, step over a duct, then turn up the wall into a '
      + 'box. The last bend is a 90 and it has to arrive square.',
    start: [0, REST],
    deck: 0,
    obstructions: [
      { label: 'duct', x0: 18, x1: 26, y0: 0, y1: 3, clearance: 0.75 },
    ],
    target: { at: [44, 26], heading: 90, tolerance: 0.6, angleTolerance: 1 },
    stick: { min: 50, max: 100 },
    teaches: 'An offset to clear the duct, then a 90 to the box. Once the 90 is '
      + 'placed the x is fixed — only the cut decides how high you finish.',
    solution: {
      bends: [
        { at: 8, angle: 30 },
        { at: 18, angle: -30 },
        { at: 40, angle: 90 },
      ],
      cut: 62.43,
    },
  },
  {
    id: 'junction-box',
    title: 'Offset into a junction box',
    brief: 'The box sits off the deck on the wall ahead. Run to it, offset up, '
      + 'and arrive square in the box.',
    teaches: 'Two equal bends the opposite way, and the bender never turns '
      + 'around — you roll the stick between them. The marks sit apart by the '
      + 'rise times the multiplier cast into the arm, and the stick finishes '
      + 'longer than the straight line by the shrink, which is why the cut is '
      + 'not the run.',
    deck: 0,
    start: [0, REST],
    obstructions: [],
    target: { at: [48, REST + 6], heading: 0, tolerance: 0.5, angleTolerance: 1 },
    stick: { min: 40, max: 75 },
    // Marks 12" apart for 6" of rise at 30°: that spacing is the multiplier
    // cast into the lower arm, and it is typed in nowhere. It falls out of the
    // arcs, which is the point — verify.mjs proves the cut, at both sizes.
    solution: {
      bends: [
        { at: 12, angle: 30 },
        { at: 24, angle: -30 },
      ],
      cut: 48.49,
    },
  },
  {
    id: 'rail-to-rail',
    title: 'Rail to rail, around the high-voltage box',
    brief: 'Leave the first rail, get up and over the high-voltage junction '
      + 'box, and land square on the second rail past it.',
    teaches: 'Two offsets, not a saddle: up to a level run over the box, then '
      + 'down onto the rail beyond. Each pair is equal and opposite and the '
      + 'bender never turns around. The clearance here is this level\'s '
      + 'number and not a code determination — near live gear the AHJ decides.',
    deck: 0,
    start: [0, REST],
    obstructions: [
      {
        label: 'high-voltage box',
        x0: 24, x1: 40, y0: 0, y1: 8, clearance: 1.5,
      },
    ],
    // A rail, not a box knockout — the pipe lands on it, so no connector.
    target: {
      at: [64, REST + 4], heading: 0, tolerance: 0.5, angleTolerance: 1,
      connector: false,
    },
    stick: { min: 60, max: 115 },
    solution: {
      bends: [
        { at: 2, angle: 30 },
        { at: 21, angle: -30 },
        { at: 44, angle: -30 },
        { at: 55, angle: 30 },
      ],
      cut: 67.78,
    },
  },
  {
    id: 'slab-to-wall',
    title: 'Over the slab, into the concrete wall',
    brief: 'The slab is in the way and the penetration is up the wall past '
      + 'it. Clear the slab and arrive square at the wall.',
    teaches: 'One offset does both jobs: it clears the slab on the way up and '
      + 'sets the height the penetration wants. Get the rise right and the '
      + 'slab looks after itself — the pipe is already above it before the '
      + 'second mark comes round.',
    deck: 0,
    start: [0, REST],
    obstructions: [
      { label: 'slab', x0: 20, x1: 44, y0: 0, y1: 6, clearance: 0.5 },
    ],
    // A penetration through concrete, not a box knockout: no connector body
    // to slide into, so the pipe runs all the way to the wall face.
    target: {
      at: [70, REST + 12], heading: 0, tolerance: 0.5, angleTolerance: 1,
      connector: false,
    },
    stick: { min: 60, max: 110 },
    solution: {
      bends: [
        { at: 2, angle: 30 },
        { at: 26, angle: -30 },
      ],
      cut: 73.10,
    },
  },
];

export function levelById(id) {
  return LEVELS.find((l) => l.id === id);
}

// What the player is actually solving for: the cut that lands the end in the
// box. Bisection here is the same trial-and-error they do with the slider, and
// it is how the shipped solutions were found.
export function solveCut(level, bends, size = SIZE, lo = null, hi = null) {
  let a = lo === null ? level.stick.min : lo;
  let b = hi === null ? level.stick.max : hi;
  // Aim where fit aims: an inch short of the box, along the arrival heading.
  const inset = level.target.connector === false
    ? 0 : CONSTANTS.CONNECTOR_INSET;
  const aimAngle = level.target.heading * RAD;
  const aim = [
    level.target.at[0] - inset * Math.cos(aimAngle),
    level.target.at[1] - inset * Math.sin(aimAngle),
  ];
  const miss = (cut) => {
    const cl = centerline(bends, cut, level.start, radiusOf(size));
    if (!cl.ok) return null;
    const end = cl.points[cl.points.length - 1];
    return Math.hypot(end[0] - aim[0], end[1] - aim[1]);
  };
  let best = null;
  let bestMiss = Infinity;
  for (let i = 0; i < 200; i += 1) {
    const cut = a + ((b - a) * i) / 199;
    const m = miss(cut);
    if (m !== null && m < bestMiss) {
      bestMiss = m;
      best = cut;
    }
  }
  if (best === null) return null;
  let step = (b - a) / 199;
  for (let i = 0; i < 60; i += 1) {
    step /= 2;
    for (const cut of [best - step, best + step]) {
      const m = miss(cut);
      if (m !== null && m < bestMiss) {
        bestMiss = m;
        best = cut;
      }
    }
  }
  return { cut: best, miss: bestMiss };
}
