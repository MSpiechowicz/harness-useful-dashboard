// harness-useful-logo 0.1.0 — generated, do not edit

// src/engine/geometry.ts
function fmt(n) {
  const s = n.toFixed(3);
  return s === "-0.000" ? "0.000" : s;
}
var H_INTACT = "M18 20 H33 V50 H58 V20 H73 V94 H58 V64 H33 V94 H18 Z";
var H_BROKEN = "M18 20 H33 V50 H58 V20 H73 V64 H33 V94 H18 Z";
var LEG = "M58 64 H73 V94 H58 Z";
var PIVOT = { x: 33, y: 94 };
var LEG_PIVOT = { x: 73, y: 94 };
var LEG_FALL_ANGLE = 90;
function pathPoints(d) {
  const tokens = d.match(/[MHVZ]|-?\d*\.?\d+/g) ?? [];
  const points = [];
  let x = 0;
  let y = 0;
  for (let i = 0;i < tokens.length; i++) {
    const cmd = tokens[i];
    if (cmd === "M") {
      x = Number(tokens[++i]);
      y = Number(tokens[++i]);
    } else if (cmd === "H") {
      x = Number(tokens[++i]);
    } else if (cmd === "V") {
      y = Number(tokens[++i]);
    } else if (cmd === "Z") {
      continue;
    } else {
      throw new Error(`Unsupported path token "${cmd}" in "${d}"`);
    }
    points.push({ x, y });
  }
  return points;
}
var H_BROKEN_POINTS = pathPoints(H_BROKEN);
var LEG_POINTS = pathPoints(LEG);
function rotatePoint(p, deg, about) {
  const r = deg * Math.PI / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - about.x;
  const dy = p.y - about.y;
  return { x: about.x + dx * cos - dy * sin, y: about.y + dx * sin + dy * cos };
}
var FAMILY_GRADIENT = Object.freeze(["#2DD4A8", "#5EB3FF"]);
var HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
function isGradient(x) {
  return Array.isArray(x) && x.length === 2 && x.every((c) => typeof c === "string" && HEX_COLOR.test(c));
}
function checkGradient(g) {
  if (!isGradient(g)) {
    throw new TypeError(`gradient must be two #RRGGBB colors, got ${JSON.stringify(g)}`);
  }
  return Object.freeze([g[0].toUpperCase(), g[1].toUpperCase()]);
}
function gradientStops(g) {
  return [
    { offset: 0, color: g[0] },
    { offset: 1, color: g[1] }
  ];
}
var GRADIENT = {
  x1: 0,
  y1: 94,
  x2: 0,
  y2: 20,
  stops: gradientStops(FAMILY_GRADIENT)
};
var TILE = {
  size: 128,
  rx: 32,
  from: "#232327",
  to: "#101012",
  rim: { color: "#fff", opacity: 0.08, width: 4, inset: 2, rx: 30 }
};
var REST_ANGLE = (Math.asin(-15 / 50) + Math.atan2(30, 40)) * 180 / Math.PI;
var CONTACT_X = PIVOT.x + 40 * Math.cos(REST_ANGLE * Math.PI / 180) + 30 * Math.sin(REST_ANGLE * Math.PI / 180);
var POSES = { upright: 0, tipped: 7, resting: REST_ANGLE };
var DEFAULT_POSE = "tipped";
function isPoseId(x) {
  return typeof x === "string" && Object.hasOwn(POSES, x);
}
function markPoints(angle) {
  const h = H_BROKEN_POINTS.map((p) => rotatePoint(p, angle, PIVOT));
  const leg = LEG_POINTS.map((p) => rotatePoint(p, LEG_FALL_ANGLE, LEG_PIVOT));
  return [...h, ...leg];
}
function markBounds(angle) {
  const points = markPoints(angle);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
// src/engine/timeline.ts
var clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
var seg = (t, a, b) => clamp((t - a) / (b - a));
var ease = {
  in: (p) => p * p,
  out: (p) => 1 - (1 - p) * (1 - p),
  inOut: (p) => p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2,
  back: (p, c = 1.70158) => 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2)
};
function joltAt(t, t0, amp = 1.4) {
  const p = seg(t, t0, t0 + 0.16);
  return p > 0 && p < 1 ? Math.sin(p * Math.PI) * amp : 0;
}
var KEY_GAPS = [0.085, 0.06, 0.115, 0.07, 0.1, 0.055, 0.125, 0.075, 0.09];
var LAST_KEY_PAUSE = 0.18;
function fullSpec(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`Name length must be a whole number of letters, got ${n}`);
  }
  const typeAt = [];
  let at = 2.2;
  for (let i = 0;i < n; i++) {
    if (i > 0) {
      at += KEY_GAPS[i % KEY_GAPS.length] + (i === n - 1 ? LAST_KEY_PAUSE : 0);
    }
    typeAt.push(at);
  }
  const homeStart = at + 0.2;
  const homeEnd = homeStart + 0.2;
  const b1 = homeEnd + 0.16;
  const blinks = [[b1, b1 + 0.14], [b1 + 0.28, b1 + 0.42]];
  const dur = +(b1 + 0.5).toFixed(2);
  return {
    appear: [0, 0.42],
    wobble: [0.42, 0.82, 3],
    loosen: [0.82, 1.05],
    fall: [1.05, 1.45],
    tip: [1.52, 1.8],
    walkOut: [1.85, 2.15],
    typeAt,
    home: [homeStart, homeEnd],
    blinks,
    dur,
    beats: [
      ["Appear", 0, 0.42],
      ["Wobble", 0.42, 0.82],
      ["Loosen", 0.82, 1.05],
      ["Fall", 1.05, 1.45],
      ["Land", 1.45, 1.85],
      ["Type", 1.85, homeStart],
      ["Home", homeStart, homeEnd],
      ["Blink", homeEnd, dur]
    ]
  };
}
function shortSpec() {
  return {
    appear: [0, 0.3],
    wobble: [0.3, 0.5, 2],
    loosen: [0.5, 0.62],
    fall: [0.62, 0.95],
    tip: [0.99, 1.2],
    walkOut: null,
    typeAt: [],
    home: null,
    blinks: [[1.44, 1.56], [1.68, 1.8]],
    dur: 1.9,
    beats: [
      ["Appear", 0, 0.3],
      ["Wobble", 0.3, 0.5],
      ["Loosen", 0.5, 0.62],
      ["Fall", 0.62, 0.95],
      ["Land", 0.95, 1.4],
      ["Blink", 1.4, 1.9]
    ]
  };
}
function specFor(version, nameLength) {
  return version === "full" ? fullSpec(nameLength) : shortSpec();
}
// src/engine/dust.ts
var DUST_KINDS = ["land", "home", "rest"];
var PUFF_LIFE = 0.65;
var PUFF_OPACITY = 0.55;
var puff = (x, y, dx, dy, r, grow, delay) => ({ x, y, dx, dy, r, grow, delay });
var DUST = {
  land: [
    puff(75, 93, -16, -4, 4, 1.8, 0),
    puff(82, 94, -8, -7, 3.5, 1.7, 0.03),
    puff(89, 94, -1, -9, 4, 1.8, 0.05),
    puff(96, 94, 9, -6, 3.6, 1.7, 0.02),
    puff(103, 93, 18, -5, 4.4, 1.9, 0),
    puff(78, 93, -22, -12, 5, 2, 0.08),
    puff(101, 93, 24, -13, 5.2, 2.1, 0.07)
  ],
  home: [
    puff(74, 94, -10, -3, 2.6, 1.6, 0),
    puff(80, 94, -4, -5, 2.2, 1.5, 0.03),
    puff(101, 94, 7, -4, 2.2, 1.5, 0.02)
  ],
  rest: [
    puff(CONTACT_X - 3, 79, -7, -4, 2.2, 1.6, 0),
    puff(CONTACT_X + 3, 79, 7, -4, 2.2, 1.6, 0.02),
    puff(CONTACT_X, 78, 0, -7, 1.8, 1.5, 0.04)
  ]
};
function burstTimes(spec) {
  return { land: spec.fall[1], home: spec.home ? spec.home[1] : null, rest: spec.tip[1] };
}
// src/engine/frame.ts
var WOBBLE_ORIGIN = { x: 45.5, y: 94 };
var APPEAR_ORIGIN = { x: 45.5, y: 57 };
var round = (n) => Number(fmt(n));
function frame(spec, time, opts) {
  const S = spec;
  const t = clamp(time, 0, S.dur);
  const { angle: A, poseId, metrics: m, nameLength: n } = opts;
  if (m && m.sub.length < n + 1) {
    throw new RangeError(`Name metrics need ${n + 1} prefix widths, got ${m.sub.length}`);
  }
  const a = ease.back(seg(t, S.appear[0], S.appear[1]));
  const s = 0.82 + 0.18 * a;
  const w = seg(t, S.wobble[0], S.wobble[1]);
  const wob = w > 0 && w < 1 ? Math.sin(w * Math.PI * S.wobble[2]) * 3.2 * (1 - w) : 0;
  let tip = 0;
  if (A > 0) {
    tip = A * ease.in(seg(t, S.tip[0], S.tip[1]));
    const qq = seg(t, S.tip[1], S.tip[1] + 0.28);
    if (qq > 0 && qq < 1) {
      tip -= Math.min(2.2, A * 0.18) * Math.sin(Math.PI * qq) * (1 - qq);
    }
  }
  const hTransform = [
    `translate(0 ${fmt(joltAt(t, S.fall[1]))})`,
    `rotate(${fmt(tip)} ${PIVOT.x} ${PIVOT.y})`,
    `rotate(${fmt(wob)} ${WOBBLE_ORIGIN.x} ${WOBBLE_ORIGIN.y})`,
    `translate(${APPEAR_ORIGIN.x} ${APPEAR_ORIGIN.y}) scale(${fmt(s)}) translate(-${APPEAR_ORIGIN.x} -${APPEAR_ORIGIN.y})`
  ].join(" ");
  const loose = t >= S.loosen[0];
  let th;
  if (t < S.loosen[1]) {
    const p = seg(t, S.loosen[0], S.loosen[1]);
    th = 3 * ease.out(p) + 1.4 * Math.sin(p * Math.PI * 4) * (1 - p);
  } else {
    th = 3 + (LEG_FALL_ANGLE - 3) * ease.in(seg(t, S.fall[0], S.fall[1]));
  }
  const typed = S.typeAt.filter((x) => t >= x).length;
  let dx = 0;
  let dy = 0;
  if (S.walkOut && S.home && m) {
    if (t < S.walkOut[1]) {
      dx = (m.prodX - LEG_PIVOT.x) * ease.inOut(seg(t, S.walkOut[0], S.walkOut[1]));
    } else {
      dx = m.prodX + m.sub[typed] - LEG_PIVOT.x;
    }
    const h = seg(t, S.home[0], S.home[1]);
    if (h > 0) {
      dx = (m.prodX + m.sub[n] - LEG_PIVOT.x) * (1 - ease.in(h));
      dy = h < 1 ? -7 * Math.sin(Math.PI * h) : 0;
    }
    const sq = seg(t, S.home[1], S.home[1] + 0.14);
    if (sq > 0 && sq < 1) {
      dy -= 1.4 * Math.sin(Math.PI * sq);
    }
  }
  if (poseId === "resting") {
    dy += joltAt(t, S.tip[1], 0.9);
  }
  const legTransform = `translate(${fmt(dx)} ${fmt(dy)}) rotate(${fmt(th)} ${LEG_PIVOT.x} ${LEG_PIVOT.y})`;
  const blinking = S.blinks.some(([x, y]) => t >= x && t < y);
  return {
    hTransform,
    hOpacity: seg(t, 0, 0.2),
    familyOpacity: seg(t, 0.2, 0.6),
    shape: loose ? "broken" : "intact",
    legTransform,
    legOpacity: blinking ? 0 : 1,
    legVisible: loose,
    typed,
    puffs: puffsAt(S, t, poseId)
  };
}
function puffsAt(spec, t, poseId) {
  const bursts = burstTimes(spec);
  const puffs = [];
  for (const kind of DUST_KINDS) {
    const t0 = bursts[kind];
    const allowed = kind !== "rest" || poseId === "resting";
    for (const { x, y, dx, dy, r, grow, delay } of DUST[kind]) {
      const start = t0 === null ? 0 : t0 + delay;
      const end = Math.min(start + PUFF_LIFE, spec.dur);
      const p = t0 === null ? 0 : seg(t, start, end);
      const active = allowed && p > 0 && p < 1;
      const e = active ? ease.out(p) : 0;
      const rr = r * (1 + (grow - 1) * e);
      puffs.push({
        cx: round(x + dx * e),
        cy: round(y + dy * e),
        rx: round(rr * 1.35),
        ry: round(rr * 0.85),
        opacity: active ? PUFF_OPACITY * (1 - p) : 0
      });
    }
  }
  return puffs;
}
// src/engine/static.ts
var SVG_NS = "http://www.w3.org/2000/svg";
var GLYPH_SCALE = 76 / 86;
var MARK_MARGIN = 2;
var MAC_CANVAS = 1024;
var MAC_INSET = 100;
var ID_PREFIX = /^[A-Za-z][A-Za-z0-9_-]*$/;
function poseAngle(pose) {
  if (!isPoseId(pose)) {
    throw new TypeError(`Unknown pose "${String(pose)}"`);
  }
  return POSES[pose];
}
function checkPrefix(idPrefix) {
  if (!ID_PREFIX.test(idPrefix)) {
    throw new TypeError(`idPrefix must start with a letter and hold only letters, digits, - or _, got "${idPrefix}"`);
  }
  return idPrefix;
}
function markGradient(id, gradient) {
  const stops = gradientStops(gradient).map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join("");
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${GRADIENT.x1}" y1="${GRADIENT.y1}" x2="${GRADIENT.x2}" y2="${GRADIENT.y2}">${stops}</linearGradient>`;
}
function markPaths(angle, indent) {
  return [
    `${indent}<path d="${H_BROKEN}" transform="rotate(${fmt(angle)} ${PIVOT.x} ${PIVOT.y})"/>`,
    `${indent}<path d="${LEG}" transform="rotate(${LEG_FALL_ANGLE} ${LEG_PIVOT.x} ${LEG_PIVOT.y})"/>`
  ];
}
function markSvg({ pose, idPrefix = "hl", gradient = FAMILY_GRADIENT }) {
  const angle = poseAngle(pose);
  const colors = checkGradient(gradient);
  const gradientId = `${checkPrefix(idPrefix)}-mark`;
  const b = markBounds(angle);
  const x = b.x - MARK_MARGIN;
  const y = b.y - MARK_MARGIN;
  const width = b.width + 2 * MARK_MARGIN;
  const height = b.height + 2 * MARK_MARGIN;
  return [
    `<svg xmlns="${SVG_NS}" width="${fmt(width)}" height="${fmt(height)}" viewBox="${fmt(x)} ${fmt(y)} ${fmt(width)} ${fmt(height)}">`,
    "  <defs>",
    `    ${markGradient(gradientId, colors)}`,
    "  </defs>",
    `  <g fill="url(#${gradientId})">`,
    ...markPaths(angle, "    "),
    "  </g>",
    "</svg>"
  ].join(`
`);
}
function tileSvg({ pose, idPrefix = "hl", gradient = FAMILY_GRADIENT }) {
  const angle = poseAngle(pose);
  const colors = checkGradient(gradient);
  const prefix = checkPrefix(idPrefix);
  const gradientId = `${prefix}-mark`;
  const tileId = `${prefix}-tile`;
  const b = markBounds(angle);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const half = TILE.size / 2;
  const fit = `translate(${half} ${half}) scale(${fmt(GLYPH_SCALE)}) translate(${fmt(-cx)} ${fmt(-cy)})`;
  const { rim } = TILE;
  const rimSize = TILE.size - 2 * rim.inset;
  return [
    `<svg xmlns="${SVG_NS}" width="${TILE.size}" height="${TILE.size}" viewBox="0 0 ${TILE.size} ${TILE.size}">`,
    "  <defs>",
    `    ${markGradient(gradientId, colors)}`,
    `    <linearGradient id="${tileId}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${TILE.from}"/><stop offset="1" stop-color="${TILE.to}"/></linearGradient>`,
    "  </defs>",
    `  <rect width="${TILE.size}" height="${TILE.size}" rx="${TILE.rx}" fill="url(#${tileId})"/>`,
    `  <rect x="${rim.inset}" y="${rim.inset}" width="${rimSize}" height="${rimSize}" rx="${rim.rx}" fill="none" stroke="${rim.color}" stroke-opacity="${rim.opacity}" stroke-width="${rim.width}"/>`,
    `  <g transform="${fit}" fill="url(#${gradientId})">`,
    ...markPaths(angle, "    "),
    "  </g>",
    "</svg>"
  ].join(`
`);
}
function macSvg(tile) {
  const open = /^\s*<svg\b[^>]*>/;
  if (!open.test(tile)) {
    throw new TypeError("macSvg expects an SVG string from tileSvg()");
  }
  const size = MAC_CANVAS - 2 * MAC_INSET;
  const nested = tile.trim().replace(open, `<svg x="${MAC_INSET}" y="${MAC_INSET}" width="${size}" height="${size}" viewBox="0 0 ${TILE.size} ${TILE.size}">`).split(`
`).map((line) => `  ${line}`).join(`
`);
  return [
    `<svg xmlns="${SVG_NS}" width="${MAC_CANVAS}" height="${MAC_CANVAS}" viewBox="0 0 ${MAC_CANVAS} ${MAC_CANVAS}">`,
    nested,
    "</svg>"
  ].join(`
`);
}
// src/engine/sound.ts
var SAMPLE_IDS = [
  "impact",
  "knock0",
  "knock1",
  "knock2",
  "tick",
  "key0",
  "key1",
  "key2",
  "key3",
  "key4",
  "key5",
  "key6",
  "key7",
  "enter"
];
var SOUND_RATE = 48000;
var SAMPLE_PEAK_DB = -1;
var SOUND_MASTER_DB = 5;
var SOUND_LIMIT = 0.89;
var SAMPLE_FRAMES = Object.freeze({
  impact: 14400,
  knock0: 4320,
  knock1: 4320,
  knock2: 4320,
  tick: 2880,
  key0: 4800,
  key1: 4800,
  key2: 4800,
  key3: 4800,
  key4: 4800,
  key5: 4949,
  key6: 4661,
  key7: 4898,
  enter: 8000
});
var SPRITE_GAP_FRAMES = 960;
function spriteLayout() {
  const layout = {};
  let frame = 0;
  for (const id of SAMPLE_IDS) {
    layout[id] = { offset: frame / SOUND_RATE, duration: SAMPLE_FRAMES[id] / SOUND_RATE };
    frame += SAMPLE_FRAMES[id] + SPRITE_GAP_FRAMES;
  }
  return layout;
}
function cueGain(cue) {
  return Math.pow(10, (cue.gainDb - SAMPLE_PEAK_DB + SOUND_MASTER_DB) / 20);
}
var SHAKES = {
  2: {
    knocks: [{ sample: "knock0", gainDb: -21 }, { sample: "knock2", gainDb: -27 }],
    ticks: [{ sample: "tick", at: 0.25, gainDb: -31 }]
  },
  3: {
    knocks: [{ sample: "knock0", gainDb: -21 }, { sample: "knock1", gainDb: -25 }, { sample: "knock2", gainDb: -29 }],
    ticks: [{ sample: "tick", at: 0.174, gainDb: -30 }, { sample: "tick", at: 0.478, gainDb: -33 }]
  }
};
var KNOCKS = ["knock0", "knock1", "knock2"];
function fallbackKnocks(cycles) {
  const knocks = [];
  for (let k = 0;k < cycles; k++) {
    const fade = cycles > 1 ? k / (cycles - 1) : 0;
    knocks.push({ sample: KNOCKS[k % KNOCKS.length], gainDb: -21 - 8 * fade });
  }
  return knocks;
}
var IMPACT_LEAD = 0.01;
var IMPACT_DB = -10;
var ENTER_DB = -12;
function keyGainDb(index, count) {
  const last = index === count - 1 ? 1.5 : 0;
  return -15 - index % 2 * 1.5 + last;
}
function soundCues(spec) {
  const cues = [];
  const [wobbleStart, wobbleEnd, cycles] = spec.wobble;
  const table = SHAKES[cycles];
  const knocks = table?.knocks ?? fallbackKnocks(cycles);
  const ticks = table?.ticks ?? SHAKES[3].ticks;
  for (const [k, knock] of knocks.entries()) {
    const at = wobbleStart + (wobbleEnd - wobbleStart) * (k + 0.5) / cycles;
    cues.push({ sample: knock.sample, at, gainDb: knock.gainDb });
  }
  const [loosenStart, loosenEnd] = spec.loosen;
  for (const tick of ticks) {
    cues.push({ sample: tick.sample, at: loosenStart + (loosenEnd - loosenStart) * tick.at, gainDb: tick.gainDb });
  }
  cues.push({ sample: "impact", at: spec.fall[1] - IMPACT_LEAD, gainDb: IMPACT_DB });
  for (const [i, at] of spec.typeAt.entries()) {
    const sample = `key${i % 8}`;
    cues.push({ sample, at, gainDb: keyGainDb(i, spec.typeAt.length) });
  }
  if (spec.home !== null) {
    cues.push({ sample: "enter", at: spec.home[1], gainDb: ENTER_DB });
  }
  return cues.sort((a, b) => a.at - b.at);
}
// src/element/font.ts
var FONT_FAMILY = "Harness Inter";
var registered = new Map;
function escapeCssUrl(url) {
  return url.replace(/[\x00-\x1f\x7f"\\<>]/g, (c) => encodeURIComponent(c));
}
function cssUrl(url) {
  return `url("${escapeCssUrl(url)}")`;
}
function registerFont(url, family = FONT_FAMILY) {
  if (typeof document === "undefined" || typeof FontFace === "undefined") {
    return Promise.resolve();
  }
  const key = `${family}
${url}`;
  const known = registered.get(key);
  if (known) {
    return known;
  }
  const loading = (async () => {
    try {
      const face = new FontFace(family, cssUrl(url), { weight: "100 900" });
      document.fonts.add(face);
      await face.load();
    } catch {}
  })();
  registered.set(key, loading);
  return loading;
}

// src/element/layout.ts
var FAMILY_NAME = "harness";
var FAMILY_X = 128;
var TEXT_Y = 76;
var FONT_SIZE = 40;
var NAME_GAP = 12;
var SHORT_BOX = { x: 12, y: 8, width: 124, height: 100 };
var FULL_BOX_FALLBACK = { x: 8, y: 8, width: 560, height: 100 };
function fullBox(nameEnd) {
  return { x: 8, y: 8, width: Math.ceil(nameEnd + 40), height: 100 };
}
function boxAttr(b) {
  return `${b.x} ${b.y} ${b.width} ${b.height}`;
}

// src/element/lockup.ts
var SVG_NS2 = "http://www.w3.org/2000/svg";
var FALLBACK_STACK = `${FONT_FAMILY}, Inter, system-ui, sans-serif`;
var LOCKUP_COLORS = {
  dark: { fg: "#ECECF0", muted: "#8F8F99" },
  light: { fg: "#16161A", muted: "#6B6B75" }
};
function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function lockupSvg(opts) {
  const { theme, pose, name, metrics, box, fontUrl, idPrefix = "hl-lockup", gradient = FAMILY_GRADIENT } = opts;
  const colors = LOCKUP_COLORS[theme];
  if (!colors) {
    throw new TypeError(`Unknown theme "${String(theme)}"`);
  }
  const colorStops = gradientStops(checkGradient(gradient));
  const spec = fullSpec(name.length);
  const end = frame(spec, spec.dur, { angle: POSES[pose], poseId: pose, metrics, nameLength: name.length });
  const gradientId = `${idPrefix}-g`;
  const stops = colorStops.map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join("");
  const fontFace = fontUrl ? `<style>@font-face{font-family:"${FONT_FAMILY}";src:url("${escapeXml(escapeCssUrl(fontUrl))}") format("woff2");font-weight:100 900;}</style>` : "";
  const textAttrs = `y="${TEXT_Y}" font-family="${escapeXml(FALLBACK_STACK)}" font-size="${FONT_SIZE}"`;
  return [
    `<svg xmlns="${SVG_NS2}" width="${box.width}" height="${box.height}" viewBox="${boxAttr(box)}" role="img" aria-label="${escapeXml(`${FAMILY_NAME} ${name}`)}">`,
    "  <defs>",
    ...fontFace ? [`    ${fontFace}`] : [],
    `    <linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" x1="${GRADIENT.x1}" y1="${GRADIENT.y1}" x2="${GRADIENT.x2}" y2="${GRADIENT.y2}">${stops}</linearGradient>`,
    "  </defs>",
    `  <text x="${FAMILY_X}" ${textAttrs} font-weight="400" fill="${colors.muted}">${FAMILY_NAME}</text>`,
    `  <text x="${metrics.prodX}" ${textAttrs} font-weight="600" fill="${colors.fg}">${escapeXml(name)}</text>`,
    `  <g fill="url(#${gradientId})">`,
    `    <path d="${H_BROKEN}" transform="${end.hTransform}"/>`,
    `    <path d="${LEG}" transform="${end.legTransform}"/>`,
    "  </g>",
    "</svg>"
  ].join(`
`);
}

// src/element/sound.ts
var LATE_CUE_S = 0.005;
var GESTURES = ["pointerdown", "keydown", "touchend"];
var MAX_SPRITE_BYTES = 2 * 1024 * 1024;
var sprites = new Map;
var shared;
function audioContext() {
  if (shared !== undefined) {
    return shared;
  }
  try {
    shared = typeof AudioContext === "function" ? new AudioContext : null;
  } catch {
    shared = null;
  }
  return shared;
}
function spriteKey(url) {
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return url;
  }
}
async function loadSprite(url) {
  try {
    const context = audioContext();
    if (!context) {
      return null;
    }
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const declared = Number(response.headers.get("content-length"));
    if (declared > MAX_SPRITE_BYTES) {
      return null;
    }
    const data = await response.arrayBuffer();
    if (data.byteLength > MAX_SPRITE_BYTES) {
      return null;
    }
    return await context.decodeAudioData(data);
  } catch {
    return null;
  }
}
function preloadSprite(url) {
  const key = spriteKey(url);
  const known = sprites.get(key);
  if (known) {
    return known;
  }
  const loading = loadSprite(url).then((buffer) => {
    if (!buffer && sprites.get(key) === loading) {
      sprites.delete(key);
    }
    return buffer;
  });
  sprites.set(key, loading);
  return loading;
}
var SILENT = { stop() {}, end() {} };
function playCues(url, cues, startedAt) {
  const context = audioContext();
  if (!context) {
    return SILENT;
  }
  const sources = [];
  let buffer = null;
  let waiting = false;
  let done = false;
  const resume = () => {
    try {
      Promise.resolve(context.resume()).catch(() => {});
    } catch {}
  };
  const schedule = () => {
    done = true;
    disarm();
    const elapsed = (performance.now() - startedAt) / 1000;
    const layout = spriteLayout();
    for (const cue of cues) {
      if (cue.at <= elapsed + LATE_CUE_S) {
        continue;
      }
      try {
        const { offset, duration } = layout[cue.sample];
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffer;
        gain.gain.value = cueGain(cue);
        source.connect(gain);
        gain.connect(context.destination);
        source.addEventListener("ended", () => {
          const at = sources.indexOf(source);
          if (at !== -1) {
            sources.splice(at, 1);
          }
          source.disconnect();
          gain.disconnect();
        });
        source.start(context.currentTime + (cue.at - elapsed), offset, duration);
        sources.push(source);
      } catch {}
    }
  };
  const attempt = () => {
    if (done || !buffer) {
      return;
    }
    if (context.state === "running") {
      schedule();
    } else {
      wait();
    }
  };
  const onGesture = () => resume();
  const wait = () => {
    resume();
    if (waiting) {
      return;
    }
    waiting = true;
    context.addEventListener("statechange", attempt);
    for (const type of GESTURES) {
      window.addEventListener(type, onGesture, { capture: true, passive: true });
    }
  };
  const disarm = () => {
    if (!waiting) {
      return;
    }
    waiting = false;
    context.removeEventListener("statechange", attempt);
    for (const type of GESTURES) {
      window.removeEventListener(type, onGesture, { capture: true });
    }
  };
  const end = () => {
    done = true;
    disarm();
  };
  const stop = () => {
    end();
    for (const source of sources.splice(0)) {
      try {
        source.stop();
        source.disconnect();
      } catch {}
    }
  };
  if (context.state !== "running") {
    wait();
  }
  preloadSprite(url).then((decoded) => {
    buffer = decoded;
    if (decoded) {
      attempt();
    } else {
      end();
    }
  });
  return { stop, end };
}

// src/element/view.ts
var SVG_NS3 = "http://www.w3.org/2000/svg";
var BASE_STYLES = `
:host { display: inline-block; line-height: 0; }
:host([hidden]) { display: none; }
svg { display: block; width: 100%; height: auto; overflow: visible; }
svg.pending { visibility: hidden; }
text { font-family: var(--harness-logo-font, "Harness Inter", Inter, system-ui, sans-serif); font-size: ${FONT_SIZE}px; }
.fam { fill: var(--harness-logo-muted, #8F8F99); font-weight: 400; }
.prod { fill: var(--harness-logo-fg, #ECECF0); font-weight: 600; }
.dust { fill: var(--harness-logo-dust, #CFD6E4); opacity: 0; }
@media (prefers-color-scheme: light) {
  .fam { fill: var(--harness-logo-muted, #6B6B75); }
  .prod { fill: var(--harness-logo-fg, #16161A); }
  .dust { fill: var(--harness-logo-dust, #8A93A6); }
}
`;
function stylesFor(gradient) {
  const [from, to] = gradient;
  return `${BASE_STYLES}.from { stop-color: var(--harness-logo-from, ${from}); }
.to { stop-color: var(--harness-logo-to, ${to}); }
`;
}
function node(tag, attrs = {}, children = []) {
  const el = document.createElementNS(SVG_NS3, tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  el.append(...children);
  return el;
}
function textNode(cls, attrs, content = "") {
  const el = node("text", { class: cls, y: String(TEXT_Y), ...attrs });
  el.textContent = content;
  return el;
}
function gradient(id, colors) {
  const stops = gradientStops(colors).map((s) => node("stop", { class: s.offset === 0 ? "from" : "to", offset: String(s.offset), "stop-color": s.color }));
  return node("linearGradient", {
    id,
    gradientUnits: "userSpaceOnUse",
    x1: String(GRADIENT.x1),
    y1: String(GRADIENT.y1),
    x2: String(GRADIENT.x2),
    y2: String(GRADIENT.y2)
  }, stops);
}
function puffNodes() {
  return DUST_KINDS.flatMap((kind) => DUST[kind].map(() => node("ellipse", { class: "dust" })));
}
function buildView(id, withText, label, colors) {
  const gradientId = `${id}-g`;
  const blurId = `${id}-b`;
  const paint = `url(#${gradientId})`;
  const style = document.createElement("style");
  style.textContent = stylesFor(colors);
  const blur = node("filter", { id: blurId, x: "-50%", y: "-50%", width: "200%", height: "200%" }, [
    node("feGaussianBlur", { stdDeviation: "1.1" })
  ]);
  const text = withText ? {
    family: textNode("fam", { x: String(FAMILY_X) }, FAMILY_NAME),
    measure: textNode("prod", { opacity: "0", "aria-hidden": "true" }),
    out: textNode("prod", {})
  } : null;
  const intact = node("path", { d: H_INTACT });
  const broken = node("path", { d: H_BROKEN });
  const h = node("g", { fill: paint }, [intact, broken]);
  const leg = node("path", { d: LEG, fill: paint });
  const puffs = puffNodes();
  const fx = node("g", { filter: `url(#${blurId})` }, puffs);
  const svg = node("svg", { role: "img", "aria-label": label }, [
    node("defs", {}, [gradient(gradientId, colors), blur]),
    ...text ? [text.family, text.measure, text.out] : [],
    h,
    leg,
    fx
  ]);
  return { style, svg, h, intact, broken, leg, puffs, text, typed: -1 };
}
function measureName(view, name) {
  const { text } = view;
  if (!text) {
    return null;
  }
  try {
    const familyWidth = text.family.getComputedTextLength();
    if (!(familyWidth > 0)) {
      return null;
    }
    const prodX = FAMILY_X + familyWidth + NAME_GAP;
    text.measure.textContent = name;
    text.measure.setAttribute("x", String(prodX));
    text.out.setAttribute("x", String(prodX));
    const sub = [0];
    for (let i = 1;i <= name.length; i++) {
      sub.push(text.measure.getSubStringLength(0, i));
    }
    if (!(sub[name.length] > 0)) {
      return null;
    }
    return { prodX, sub, end: prodX + sub[name.length] };
  } catch {
    return null;
  }
}
function applyFrame(view, state, name) {
  view.h.setAttribute("transform", state.hTransform);
  view.h.style.opacity = String(state.hOpacity);
  view.intact.style.display = state.shape === "intact" ? "" : "none";
  view.broken.style.display = state.shape === "broken" ? "" : "none";
  view.leg.style.display = state.legVisible ? "" : "none";
  view.leg.setAttribute("transform", state.legTransform);
  view.leg.style.opacity = String(state.legOpacity);
  if (view.text) {
    view.text.family.style.opacity = String(state.familyOpacity);
    if (view.typed !== state.typed) {
      view.text.out.textContent = name.slice(0, state.typed);
      view.typed = state.typed;
    }
  }
  state.puffs.forEach((puff, i) => {
    const el = view.puffs[i];
    if (puff.opacity === 0) {
      el.style.opacity = "0";
      return;
    }
    el.setAttribute("cx", String(puff.cx));
    el.setAttribute("cy", String(puff.cy));
    el.setAttribute("rx", String(puff.rx));
    el.setAttribute("ry", String(puff.ry));
    el.style.opacity = String(puff.opacity);
  });
}

// src/element/harness-logo.ts
var TAG = "harness-logo";
var LOOP_HOLD_MS = 2200;
var FINISH_GRACE_MS = 150;
var FONT_WAIT_MS = 1500;
var OBSERVED = ["name", "version", "pose", "autoplay", "loop", "font-url", "sound", "sound-url"];
var instances = 0;
function defaultName() {
  if ("dashboard") {
    return "dashboard";
  }
  return "harness";
}
function defaultGradient() {
  const from = "#F59E0B";
  const to = "#F472B6";
  if (from !== undefined && to !== undefined && HEX_COLOR.test(from) && HEX_COLOR.test(to)) {
    return checkGradient([from, to]);
  }
  return FAMILY_GRADIENT;
}
function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}
async function loadFonts(fontUrl) {
  if (fontUrl) {
    await registerFont(fontUrl);
  }
  if (typeof document === "undefined" || !document.fonts) {
    return;
  }
  try {
    await Promise.all([
      document.fonts.load(`600 40px "${FONT_FAMILY}"`),
      document.fonts.load(`400 40px "${FONT_FAMILY}"`)
    ]);
  } catch {}
}
function createHarnessLogoClass() {
  return class HarnessLogoElement extends HTMLElement {
    static observedAttributes = OBSERVED;
    #id = `hl-${++instances}`;
    #gradient = defaultGradient();
    #view = null;
    #opts = {
      name: "harness",
      version: "short",
      pose: DEFAULT_POSE,
      autoplay: false,
      fontUrl: null,
      sound: false,
      soundUrl: null
    };
    #spec = specFor("short", 0);
    #metrics = null;
    #box = SHORT_BOX;
    #ready = Promise.resolve();
    #generation = 0;
    #run = 0;
    #t = 0;
    #started = false;
    #raf = 0;
    #finishTimer;
    #loopTimer;
    #resize = null;
    #sound = null;
    #wakeMeasure = null;
    #pendingInit = false;
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }
    get duration() {
      return this.#spec.dur;
    }
    get ready() {
      return this.#ready;
    }
    get viewBox() {
      return this.#box;
    }
    play() {
      if (!this.#started) {
        return;
      }
      this.#stop();
      const run = this.#run;
      this.#ready.then(() => {
        if (run === this.#run) {
          this.#begin(run);
        }
      });
    }
    skip() {
      this.#stop();
      this.#t = this.#spec.dur;
      this.#render();
      this.#emitFinish();
    }
    seek(t) {
      this.#stop();
      this.#t = clamp(t, 0, this.#spec.dur);
      this.#render();
    }
    lockupSvg(theme = "dark") {
      const { name, pose, fontUrl, version } = this.#opts;
      if (version !== "full" || !this.#metrics) {
        throw new Error("lockupSvg needs the full version, drawn and measured. Await ready first.");
      }
      return lockupSvg({
        theme,
        pose,
        name,
        metrics: this.#metrics,
        box: this.#box,
        fontUrl: fontUrl ?? undefined,
        idPrefix: `${this.#id}-lockup`,
        gradient: this.#currentGradient()
      });
    }
    #currentGradient() {
      const style = getComputedStyle(this);
      const pick = (property, baked) => {
        const value = style.getPropertyValue(property).trim();
        return HEX_COLOR.test(value) ? value : baked;
      };
      return [pick("--harness-logo-from", this.#gradient[0]), pick("--harness-logo-to", this.#gradient[1])];
    }
    connectedCallback() {
      this.#started = true;
      this.#init();
    }
    disconnectedCallback() {
      this.#started = false;
      this.#generation++;
      this.#stop();
      this.#stopWaitingForResize();
    }
    attributeChangedCallback(attribute) {
      if (!this.#started) {
        return;
      }
      if (attribute === "sound" || attribute === "sound-url") {
        this.#opts = { ...this.#opts, ...this.#readSound() };
        this.#preloadSound();
        return;
      }
      if (attribute === "loop" || this.#pendingInit) {
        return;
      }
      this.#pendingInit = true;
      queueMicrotask(() => {
        this.#pendingInit = false;
        if (this.#started) {
          this.#init();
        }
      });
    }
    #readOptions() {
      const version = this.getAttribute("version") === "full" ? "full" : "short";
      const pose = this.getAttribute("pose");
      return {
        name: this.getAttribute("name")?.trim() || defaultName(),
        version,
        pose: isPoseId(pose) ? pose : DEFAULT_POSE,
        autoplay: this.hasAttribute("autoplay"),
        fontUrl: this.getAttribute("font-url") || null,
        ...this.#readSound()
      };
    }
    #readSound() {
      return { sound: this.hasAttribute("sound"), soundUrl: this.getAttribute("sound-url") || null };
    }
    #preloadSound() {
      const { sound, soundUrl } = this.#opts;
      if (sound && soundUrl && !prefersReducedMotion()) {
        preloadSprite(soundUrl);
      }
    }
    #init() {
      this.#stop();
      this.#stopWaitingForResize();
      const generation = ++this.#generation;
      const opts = this.#readOptions();
      const full = opts.version === "full";
      this.#opts = opts;
      this.#spec = specFor(opts.version, opts.name.length);
      this.#metrics = null;
      this.#box = full ? FULL_BOX_FALLBACK : SHORT_BOX;
      const label = full ? `harness ${opts.name} logo` : "harness logo";
      const view = buildView(this.#id, full, label, this.#gradient);
      this.#view = view;
      this.#applyBox();
      view.svg.classList.toggle("pending", full);
      this.shadowRoot.replaceChildren(view.style, view.svg);
      this.#t = opts.autoplay && !prefersReducedMotion() ? 0 : this.#spec.dur;
      this.#render();
      this.#preloadSound();
      this.#ready = full ? this.#measure(generation) : Promise.resolve();
      if (opts.autoplay) {
        this.play();
      }
    }
    async#measure(generation) {
      const fonts = loadFonts(this.#opts.fontUrl);
      const loaded = await withTimeout(fonts.then(() => true), FONT_WAIT_MS);
      while (generation === this.#generation && this.#view) {
        const measured = measureName(this.#view, this.#opts.name);
        if (measured) {
          this.#applyMeasured(measured);
          this.#view.svg.classList.remove("pending");
          this.#render();
          if (!loaded) {
            fonts.then(() => this.#remeasure(generation));
          }
          return;
        }
        await this.#nextResize();
      }
    }
    #remeasure(generation) {
      if (generation !== this.#generation || !this.#view || !this.#metrics) {
        return;
      }
      const measured = measureName(this.#view, this.#opts.name);
      if (measured) {
        this.#applyMeasured(measured);
        this.#render();
      }
    }
    #applyMeasured(measured) {
      this.#metrics = { prodX: measured.prodX, sub: measured.sub };
      this.#box = fullBox(measured.end);
      this.#applyBox();
    }
    #nextResize() {
      return new Promise((resolve) => {
        this.#stopWaitingForResize();
        this.#wakeMeasure = resolve;
        if (typeof ResizeObserver === "undefined") {
          setTimeout(() => this.#stopWaitingForResize(), 100);
          return;
        }
        this.#resize = new ResizeObserver((entries) => {
          if (entries.some(({ contentRect }) => contentRect.width > 0 || contentRect.height > 0)) {
            this.#stopWaitingForResize();
          }
        });
        this.#resize.observe(this);
      });
    }
    #stopWaitingForResize() {
      this.#resize?.disconnect();
      this.#resize = null;
      const wake = this.#wakeMeasure;
      this.#wakeMeasure = null;
      wake?.();
    }
    #applyBox() {
      this.#view?.svg.setAttribute("viewBox", boxAttr(this.#box));
    }
    #stop() {
      this.#run++;
      cancelAnimationFrame(this.#raf);
      clearTimeout(this.#finishTimer);
      clearTimeout(this.#loopTimer);
      this.#sound?.stop();
      this.#sound = null;
    }
    #begin(run) {
      const { dur } = this.#spec;
      if (prefersReducedMotion()) {
        this.#t = dur;
        this.#render();
        queueMicrotask(() => this.#finish(run));
        return;
      }
      const start = performance.now();
      this.#t = 0;
      this.#render();
      this.#playSound(start);
      const tick = (now) => {
        if (run !== this.#run) {
          return;
        }
        this.#t = clamp((now - start) / 1000, 0, dur);
        this.#render();
        if (this.#t >= dur) {
          this.#finish(run);
        } else {
          this.#raf = requestAnimationFrame(tick);
        }
      };
      this.#raf = requestAnimationFrame(tick);
      this.#finishTimer = setTimeout(() => this.#finish(run), dur * 1000 + FINISH_GRACE_MS);
    }
    #playSound(startedAt) {
      const { sound, soundUrl } = this.#opts;
      if (sound && soundUrl) {
        this.#sound = playCues(soundUrl, soundCues(this.#spec), startedAt);
      }
    }
    #finish(run) {
      if (run !== this.#run) {
        return;
      }
      this.#sound?.end();
      this.#sound = null;
      this.#stop();
      this.#t = this.#spec.dur;
      this.#render();
      this.#emitFinish();
      if (this.hasAttribute("loop") && !prefersReducedMotion()) {
        this.#loopTimer = setTimeout(() => this.#restartIfLooping(), LOOP_HOLD_MS);
      }
    }
    #restartIfLooping() {
      if (this.hasAttribute("loop")) {
        this.play();
      }
    }
    #emitFinish() {
      this.dispatchEvent(new CustomEvent("finish", { bubbles: true, composed: true }));
    }
    #render() {
      if (!this.#view) {
        return;
      }
      const { name, pose } = this.#opts;
      const state = frame(this.#spec, this.#t, {
        angle: POSES[pose],
        poseId: pose,
        metrics: this.#metrics ?? undefined,
        nameLength: name.length
      });
      applyFrame(this.#view, state, name);
    }
  };
}
function defineHarnessLogo() {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") {
    return;
  }
  if (!customElements.get(TAG)) {
    customElements.define(TAG, createHarnessLogoClass());
  }
}

// src/browser.ts
defineHarnessLogo();
export {
  CONTACT_X,
  DEFAULT_POSE,
  DUST,
  DUST_KINDS,
  FAMILY_GRADIENT,
  GLYPH_SCALE,
  GRADIENT,
  HEX_COLOR,
  H_BROKEN,
  H_BROKEN_POINTS,
  H_INTACT,
  KEY_GAPS,
  LAST_KEY_PAUSE,
  LEG,
  LEG_FALL_ANGLE,
  LEG_PIVOT,
  LEG_POINTS,
  MAC_CANVAS,
  MAC_INSET,
  MARK_MARGIN,
  PIVOT,
  POSES,
  PUFF_LIFE,
  PUFF_OPACITY,
  REST_ANGLE,
  SAMPLE_FRAMES,
  SAMPLE_IDS,
  SAMPLE_PEAK_DB,
  SOUND_LIMIT,
  SOUND_MASTER_DB,
  SOUND_RATE,
  TILE,
  burstTimes,
  checkGradient,
  clamp,
  cueGain,
  defineHarnessLogo,
  ease,
  fmt,
  frame,
  fullSpec,
  gradientStops,
  isGradient,
  isPoseId,
  joltAt,
  lockupSvg,
  macSvg,
  markBounds,
  markPoints,
  markSvg,
  pathPoints,
  registerFont,
  rotatePoint,
  seg,
  shortSpec,
  soundCues,
  specFor,
  spriteLayout,
  tileSvg
};
