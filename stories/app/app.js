// Open Adaptive Stories - story maker web app.
// Builds and reads the same .oastory files as the iOS app.
//
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Open Adaptive Stories contributors
"use strict";

// ---------------------------------------------------------------------------
// Small utilities (pure; the node test harness exercises these directly)
// ---------------------------------------------------------------------------

function uuid() {
  // iOS writes uppercase UUIDs; match it so files look the same either way.
  return crypto.randomUUID().toUpperCase();
}

function isoNow() {
  // Swift's .iso8601 has no fractional seconds.
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

function round4(v) { return Math.round(v * 10000) / 10000; }

// JSON with sorted keys and indentation, like the iOS app writes.
function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortValue(v[k]);
    return o;
  }
  return v;
}
function stableJson(v) { return JSON.stringify(sortValue(v), null, 2); }

function textDecode(bytes) { return new TextDecoder().decode(bytes); }
function textEncode(s) { return new TextEncoder().encode(s); }

// ---------------------------------------------------------------------------
// ZIP reading and writing. Plain JS: CRC32 by table, deflate through
// CompressionStream. The reader handles stored and deflate entries, since
// the iOS app deflates; the writer stores JPEG and M4A (already compressed)
// and deflates JSON.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function deflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function inflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// files: [{ name, data: Uint8Array, deflate: bool }] -> Blob (a valid zip).
async function zipCreate(files) {
  const now = dosDateTime(new Date());
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameB = textEncode(f.name);
    const crc = crc32(f.data);
    let method = 0;
    let out = f.data;
    if (f.deflate) {
      const c = await deflateRaw(f.data);
      if (c.length < f.data.length) { method = 8; out = c; }
    }
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);          // version needed
    lh.setUint16(6, 0, true);           // flags
    lh.setUint16(8, method, true);
    lh.setUint16(10, now.time, true);
    lh.setUint16(12, now.date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, out.length, true);
    lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, nameB.length, true);
    lh.setUint16(28, 0, true);          // extra length
    chunks.push(new Uint8Array(lh.buffer), nameB, out);
    central.push({ nameB, crc, method, csize: out.length, usize: f.data.length, offset });
    offset += 30 + nameB.length + out.length;
  }
  const cdStart = offset;
  for (const e of central) {
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);          // version made by
    cd.setUint16(6, 20, true);          // version needed
    cd.setUint16(8, 0, true);           // flags
    cd.setUint16(10, e.method, true);
    cd.setUint16(12, now.time, true);
    cd.setUint16(14, now.date, true);
    cd.setUint32(16, e.crc, true);
    cd.setUint32(20, e.csize, true);
    cd.setUint32(24, e.usize, true);
    cd.setUint16(28, e.nameB.length, true);
    // extra, comment, disk, internal and external attributes stay zero
    cd.setUint32(42, e.offset, true);
    chunks.push(new Uint8Array(cd.buffer), e.nameB);
    offset += 46 + e.nameB.length;
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, offset - cdStart, true);
  eocd.setUint32(16, cdStart, true);
  chunks.push(new Uint8Array(eocd.buffer));
  return new Blob(chunks, { type: "application/zip" });
}

// Walk the central directory of a zip in an ArrayBuffer.
// Returns { name: { method, data } } with data still compressed.
function zipEntries(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  const floor = Math.max(0, buf.byteLength - 22 - 65535);
  for (let i = buf.byteLength - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("that file isn't a zip archive");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error("the zip directory is damaged");
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = textDecode(u8.subarray(off + 46, off + 46 + nameLen));
    // The local header's name and extra lengths can differ from the central
    // directory's; trust the local ones for the data offset.
    const dataStart = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    if (!name.endsWith("/")) {
      entries[name] = { method, data: u8.subarray(dataStart, dataStart + csize) };
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

async function zipExtract(entry) {
  if (entry.method === 0) return entry.data;
  if (entry.method === 8) return inflateRaw(entry.data);
  throw new Error("this story uses a compression this browser can't unpack");
}

// ---------------------------------------------------------------------------
// Story model. The .oastory format is fixed - the iOS app reads and writes
// exactly this - so these helpers mirror the app's geometry.
// ---------------------------------------------------------------------------

const LAYOUTS = ["single", "twoAcross", "twoStack", "three", "four"];
const ASPECT_MIN = 0.55, ASPECT_MAX = 1.9;
const GUTTER = 0.012;

function layoutFitting(count) {
  if (count <= 1) return "single";
  if (count === 2) return "twoAcross";
  if (count === 3) return "three";
  return "four";
}

// Cell frames in canvas units [x, y, w, h].
function cellFrames(layout, count) {
  const g = GUTTER, half = (1 - g) / 2;
  let f;
  switch (layout) {
    case "twoAcross":
      f = [[0, 0, half, 1], [half + g, 0, half, 1]]; break;
    case "twoStack":
      f = [[0, 0, 1, half], [0, half + g, 1, half]]; break;
    case "three": {
      const lw = 0.62, rw = 1 - lw - g;
      f = [[0, 0, lw, 1], [lw + g, 0, rw, half], [lw + g, half + g, rw, half]];
      break;
    }
    case "four":
      f = [[0, 0, half, half], [half + g, 0, half, half],
           [0, half + g, half, half], [half + g, half + g, half, half]];
      break;
    default:
      f = [[0, 0, 1, 1]];
  }
  return f.slice(0, Math.max(count, 0));
}

function validShape(s) {
  if (!s || typeof s !== "object") return false;
  if (s.type === "box" || s.type === "ellipse") {
    return Array.isArray(s.rect) && s.rect.length === 4 && s.rect.every(n => typeof n === "number");
  }
  if (s.type === "outline") {
    return Array.isArray(s.points) && s.points.length >= 6 && s.points.length % 2 === 0
      && s.points.every(n => typeof n === "number");
  }
  return false;
}

function shapeBBox(s) {
  if (s.type === "outline") {
    let minX = s.points[0], maxX = s.points[0], minY = s.points[1], maxY = s.points[1];
    for (let i = 0; i < s.points.length; i += 2) {
      minX = Math.min(minX, s.points[i]); maxX = Math.max(maxX, s.points[i]);
      minY = Math.min(minY, s.points[i + 1]); maxY = Math.max(maxY, s.points[i + 1]);
    }
    return [minX, minY, maxX - minX, maxY - minY];
  }
  return s.rect.slice();
}

// Translate in canvas units, keeping the whole shape on the canvas.
function translateShape(s, dx, dy) {
  const [bx, by, bw, bh] = shapeBBox(s);
  dx = clamp(dx, -bx, 1 - (bx + bw));
  dy = clamp(dy, -by, 1 - (by + bh));
  if (s.type === "outline") {
    const pts = s.points.map((v, i) => round4(v + (i % 2 === 0 ? dx : dy)));
    return { type: "outline", points: pts };
  }
  const r = s.rect;
  return { type: s.type, rect: [round4(r[0] + dx), round4(r[1] + dy), r[2], r[3]] };
}

// Ramer-Douglas-Peucker, iterative so a long stroke can't recurse deep.
// points: [{x, y}], tolerance in the same units as the points.
function simplifyPoints(points, tolerance) {
  if (points.length <= 2) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  const segDist = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;
    let maxD = 0, maxI = first;
    for (let i = first + 1; i < last; i++) {
      const d = segDist(points[i], points[first], points[last]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tolerance) {
      keep[maxI] = true;
      stack.push([first, maxI], [maxI, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const COLOR_PRESETS = {
  blue: "#0A84FF", green: "#30D158", orange: "#FF9F0A",
  pink: "#FF375F", yellow: "#FFD60A",
};

function resolveSpotColor(h, fallback) {
  const c = h.colorName;
  if (!c) return fallback;
  if (COLOR_PRESETS[c]) return COLOR_PRESETS[c];
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  return fallback;
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Fill in anything a hand-edited or older file left out, without touching
// fields we don't know about - unknown keys ride along and are written back.
function normalizeStory(s, folderId) {
  if (!s || typeof s !== "object") throw new Error("story.json is not an object");
  if (folderId) s.id = folderId;
  if (!s.id) s.id = uuid();
  if (typeof s.title !== "string") s.title = "Untitled story";
  if (typeof s.createdAt !== "string") s.createdAt = isoNow();
  if (!Array.isArray(s.pages)) s.pages = [];
  for (const p of s.pages) {
    if (!p.id) p.id = uuid();
    if (!Array.isArray(p.cells)) p.cells = [];
    if (!Array.isArray(p.hotspots)) p.hotspots = [];
    if (typeof p.aspect !== "number" || !(p.aspect > 0)) p.aspect = 4 / 3;
    if (!LAYOUTS.includes(p.layout)) p.layout = layoutFitting(p.cells.length || 1);
    for (const c of p.cells) if (!c.id) c.id = uuid();
    p.hotspots = p.hotspots.filter(h => h && validShape(h.shape));
    for (const h of p.hotspots) {
      if (!h.id) h.id = uuid();
      if (typeof h.rotation !== "number") h.rotation = 0;
      if (typeof h.label !== "string") h.label = "";
      if (typeof h.speechText !== "string") h.speechText = "";
      if (typeof h.useAudio !== "boolean") h.useAudio = false;
      if (typeof h.isText !== "boolean") h.isText = false;
      if (typeof h.showLabel !== "boolean") h.showLabel = true;
      if (h.showPreview !== true && h.showPreview !== false) h.showPreview = null;
    }
  }
  return s;
}

function newHotspot(shape) {
  return {
    id: uuid(), shape, rotation: 0, label: "", speechText: "",
    useAudio: false, isText: false, showLabel: true, showPreview: null,
  };
}

// ---------------------------------------------------------------------------
// .oastory in and out. buildOastoryFiles and parseOastoryBuffer work on
// plain bytes so the node test can run them outside a browser.
// ---------------------------------------------------------------------------

// stories: array of story objects.
// assets: Map storyId -> { images: Map name -> {blob}, audio: Map name -> {blob} }
async function buildOastoryFiles(stories, assets) {
  const files = [];
  const manifest = { format: "open-adaptive-stories", version: 1, stories: stories.map(s => s.id) };
  files.push({ name: "manifest.json", data: textEncode(stableJson(manifest)), deflate: true });
  for (const s of stories) {
    const st = assets.get(s.id) || { images: new Map(), audio: new Map() };
    // Keep a cover the iOS app chose if its image is still here; only fall
    // back to the first photo when there's no valid cover set.
    if (!s.coverAsset || !st.images.has(s.coverAsset)) {
      const first = s.pages[0] && s.pages[0].cells[0] && s.pages[0].cells[0].imageAsset;
      if (first) s.coverAsset = first; else delete s.coverAsset;
    }
    files.push({ name: `stories/${s.id}/story.json`, data: textEncode(stableJson(s)), deflate: true });
    for (const [name, rec] of st.images) {
      files.push({ name: `stories/${s.id}/images/${name}`,
                   data: new Uint8Array(await rec.blob.arrayBuffer()), deflate: false });
    }
    for (const [name, rec] of st.audio) {
      files.push({ name: `stories/${s.id}/audio/${name}`,
                   data: new Uint8Array(await rec.blob.arrayBuffer()), deflate: false });
    }
  }
  return zipCreate(files);
}

// buf: ArrayBuffer -> { stories, rawAssets: Map id -> {images: Map name->bytes,
// audio: Map name->bytes} }. Throws with a plain-language message.
async function parseOastoryBuffer(buf) {
  const entries = zipEntries(buf);
  const manifestEntry = entries["manifest.json"];
  if (!manifestEntry) throw new Error("that file doesn't look like a story - no manifest inside");
  const manifest = JSON.parse(textDecode(await zipExtract(manifestEntry)));
  // Files made before the app was renamed carry the old value.
  if (manifest.format !== "open-adaptive-stories" && manifest.format !== "open-adaptive-reading") {
    throw new Error("that file is not an Open Adaptive Stories story");
  }
  const stories = [];
  const rawAssets = new Map();
  const names = Object.keys(entries);
  for (const id of manifest.stories || []) {
    const se = entries[`stories/${id}/story.json`];
    if (!se) continue;
    const story = normalizeStory(JSON.parse(textDecode(await zipExtract(se))), id);
    const images = new Map(), audio = new Map();
    const ipre = `stories/${id}/images/`, apre = `stories/${id}/audio/`;
    for (const name of names) {
      if (name.startsWith(ipre) && name.length > ipre.length) {
        images.set(name.slice(ipre.length), await zipExtract(entries[name]));
      } else if (name.startsWith(apre) && name.length > apre.length) {
        audio.set(name.slice(apre.length), await zipExtract(entries[name]));
      }
    }
    stories.push(story);
    rawAssets.set(story.id, { images, audio });
  }
  if (!stories.length) throw new Error("no stories inside that file");
  return { stories, rawAssets };
}

// ---------------------------------------------------------------------------
// Everything below needs a browser.
// ---------------------------------------------------------------------------

function boot() {
  const $ = id => document.getElementById(id);

  if (typeof CompressionStream === "undefined" || typeof DecompressionStream === "undefined"
      || !crypto.randomUUID) {
    $("too-old").classList.remove("hidden");
    $("app").classList.add("hidden");
    return;
  }

  // ---- document state ----------------------------------------------------

  // doc.assets: Map storyId -> { images: Map name -> {blob,url,el,w,h},
  //                              audio:  Map name -> {blob,url} }
  let doc = null;
  let dirty = false;
  const state = { si: 0, pi: 0, hi: -1, tool: "move" };

  function markDirty() { dirty = true; }

  function freshStore() { return { images: new Map(), audio: new Map() }; }

  function freshDoc() {
    const story = { id: uuid(), title: "New story", createdAt: isoNow(), pages: [] };
    const assets = new Map([[story.id, freshStore()]]);
    return { stories: [story], assets };
  }

  function revokeDoc(d) {
    if (!d) return;
    for (const st of d.assets.values()) {
      for (const rec of st.images.values()) if (rec.url) URL.revokeObjectURL(rec.url);
      for (const rec of st.audio.values()) if (rec.url) URL.revokeObjectURL(rec.url);
    }
  }

  const st = () => doc.stories[state.si];
  const store = () => doc.assets.get(st().id);
  const page = () => st().pages[state.pi] || null;
  const spot = () => (page() && page().hotspots[state.hi]) || null;

  function imageRec(blob, w, h) {
    return { blob, url: URL.createObjectURL(blob), el: null, w: w || 0, h: h || 0 };
  }

  function ensureImage(rec) {
    if (!rec) return Promise.resolve(null);
    if (rec.el) return Promise.resolve(rec.el);
    if (!rec.loading) {
      rec.loading = new Promise(resolve => {
        const im = new Image();
        im.onload = () => { rec.el = im; rec.w = im.naturalWidth; rec.h = im.naturalHeight; resolve(im); };
        im.onerror = () => resolve(null);
        im.src = rec.url;
      });
    }
    return rec.loading;
  }

  function ensurePageImages(p) {
    return Promise.all(p.cells.map(c => ensureImage(store().images.get(c.imageAsset))));
  }

  // Drop an asset when nothing in any story references it any more.
  function collectRefs() {
    const refs = new Set();
    for (const s of doc.stories) {
      // A hand-picked cover keeps its photo alive even if it's not on a page.
      if (s.coverAsset) refs.add(s.id + "/i/" + s.coverAsset);
      for (const p of s.pages) {
        for (const c of p.cells) if (c.imageAsset) refs.add(s.id + "/i/" + c.imageAsset);
        for (const h of p.hotspots) if (h.audioAsset) refs.add(s.id + "/a/" + h.audioAsset);
      }
    }
    return refs;
  }

  function garbageCollectAssets() {
    const refs = collectRefs();
    for (const s of doc.stories) {
      const a = doc.assets.get(s.id);
      if (!a) continue;
      for (const [name, rec] of [...a.images]) {
        if (!refs.has(s.id + "/i/" + name)) {
          if (rec.url) URL.revokeObjectURL(rec.url);
          a.images.delete(name);
        }
      }
      for (const [name, rec] of [...a.audio]) {
        if (!refs.has(s.id + "/a/" + name)) {
          if (rec.url) URL.revokeObjectURL(rec.url);
          a.audio.delete(name);
        }
      }
    }
  }

  // ---- speech and sound --------------------------------------------------

  let audioEl = null;

  function stopSound() {
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (audioEl) { audioEl.pause(); audioEl = null; }
  }

  function speak(text) {
    stopSound();
    if (!text || !window.speechSynthesis) return;
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  function playAudioBlob(rec, onFail) {
    stopSound();
    if (!rec.url) rec.url = URL.createObjectURL(rec.blob);
    audioEl = new Audio(rec.url);
    audioEl.onerror = () => { audioEl = null; if (onFail) onFail(); };
    audioEl.play().catch(() => { audioEl = null; if (onFail) onFail(); });
  }

  function isSpeaking() {
    return (window.speechSynthesis && speechSynthesis.speaking)
      || (audioEl && !audioEl.paused && !audioEl.ended);
  }

  // ---- drawing a page ----------------------------------------------------

  function drawPage(ctx, p, W, H, assets) {
    ctx.fillStyle = "#26282b";
    ctx.fillRect(0, 0, W, H);
    const frames = cellFrames(p.layout, p.cells.length);
    p.cells.forEach((cell, i) => {
      const f = frames[i];
      if (!f) return;
      const r = { x: f[0] * W, y: f[1] * H, w: f[2] * W, h: f[3] * H };
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      const rec = assets.images.get(cell.imageAsset);
      if (rec && rec.el && rec.w && rec.h) {
        // Aspect-fill: cover the cell, centered, overflow clipped.
        const s = Math.max(r.w / rec.w, r.h / rec.h);
        const dw = rec.w * s, dh = rec.h * s;
        ctx.drawImage(rec.el, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
      } else {
        ctx.fillStyle = "#44474b";
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      ctx.restore();
    });
  }

  // Shared by editor and player: an SVG group for one hotspot, positioned in
  // a reference space of 1000*aspect by 1000 so stroke widths mean the same
  // thing on every page. Rotation turns about the bounding-box center.
  const SVG_NS = "http://www.w3.org/2000/svg";

  function shapeNode(shape, refW, refH) {
    let el;
    if (shape.type === "box") {
      const [x, y, w, h] = shape.rect;
      el = document.createElementNS(SVG_NS, "rect");
      el.setAttribute("x", x * refW); el.setAttribute("y", y * refH);
      el.setAttribute("width", w * refW); el.setAttribute("height", h * refH);
      el.setAttribute("rx", Math.min(w * refW, h * refH) * 0.12);
    } else if (shape.type === "ellipse") {
      const [x, y, w, h] = shape.rect;
      el = document.createElementNS(SVG_NS, "ellipse");
      el.setAttribute("cx", (x + w / 2) * refW); el.setAttribute("cy", (y + h / 2) * refH);
      el.setAttribute("rx", (w / 2) * refW); el.setAttribute("ry", (h / 2) * refH);
    } else {
      el = document.createElementNS(SVG_NS, "polygon");
      const pts = [];
      for (let i = 0; i < shape.points.length; i += 2) {
        pts.push((shape.points[i] * refW) + "," + (shape.points[i + 1] * refH));
      }
      el.setAttribute("points", pts.join(" "));
    }
    return el;
  }

  function spotGroup(h, refW, refH) {
    const g = document.createElementNS(SVG_NS, "g");
    const el = shapeNode(h.shape, refW, refH);
    if (h.rotation) {
      const [bx, by, bw, bh] = shapeBBox(h.shape);
      const cx = (bx + bw / 2) * refW, cy = (by + bh / 2) * refH;
      g.setAttribute("transform", `rotate(${h.rotation * 180 / Math.PI} ${cx} ${cy})`);
    }
    g.appendChild(el);
    return g;
  }

  // ---- editor: pages -----------------------------------------------------

  async function encodeJpegFromBlob(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const im = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("couldn't read one of those photos"));
        i.src = url;
      });
      const w = im.naturalWidth, h = im.naturalHeight;
      if (!w || !h) throw new Error("couldn't read one of those photos");
      const s = Math.min(1, 2200 / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
      const c = document.createElement("canvas");
      c.width = cw; c.height = ch;
      c.getContext("2d").drawImage(im, 0, 0, cw, ch);
      const out = await new Promise((res, rej) =>
        c.toBlob(b => b ? res(b) : rej(new Error("couldn't convert that photo")), "image/jpeg", 0.85));
      return { blob: out, w: cw, h: ch };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function addImageAsset(fileOrBlob) {
    const { blob, w, h } = await encodeJpegFromBlob(fileOrBlob);
    const name = uuid() + ".jpg";
    store().images.set(name, imageRec(blob, w, h));
    return { name, w, h };
  }

  function singlePage(asset) {
    return {
      id: uuid(), layout: "single",
      aspect: round4(clamp(asset.w / asset.h, ASPECT_MIN, ASPECT_MAX)),
      cells: [{ id: uuid(), imageAsset: asset.name }],
      hotspots: [],
    };
  }

  async function addPagesFromFiles(files) {
    setStatus("file-status", "Preparing photos...", "");
    try {
      let collage = false;
      if (files.length >= 2 && files.length <= 4) {
        collage = confirm(`Put these ${files.length} photos together on one collage page?\n\n`
          + `OK makes one collage page. Cancel makes ${files.length} separate pages.`);
      }
      if (collage) {
        const assets = [];
        for (const f of files) assets.push(await addImageAsset(f));
        const portrait = assets.filter(a => a.h > a.w).length;
        const p = {
          id: uuid(), layout: layoutFitting(assets.length),
          aspect: portrait > assets.length / 2 ? 0.75 : round4(4 / 3),
          cells: assets.map(a => ({ id: uuid(), imageAsset: a.name })),
          hotspots: [],
        };
        st().pages.push(p);
        state.pi = st().pages.length - 1;
      } else {
        for (const f of files) {
          st().pages.push(singlePage(await addImageAsset(f)));
        }
        state.pi = st().pages.length - 1;
      }
      state.hi = -1;
      markDirty();
      setStatus("file-status", "", "");
      renderAll();
    } catch (e) {
      garbageCollectAssets();   // drop any photo that never made it onto a page
      setStatus("file-status", e.message, "warn");
    }
  }

  function deletePage() {
    const p = page();
    if (!p) return;
    if (!confirm("Delete this page and its spots?")) return;
    st().pages.splice(state.pi, 1);
    state.pi = Math.min(state.pi, st().pages.length - 1);
    state.hi = -1;
    garbageCollectAssets();
    markDirty();
    renderAll();
  }

  function movePage(dir) {
    const pages = st().pages;
    const to = state.pi + dir;
    if (!page() || to < 0 || to >= pages.length) return;
    const [p] = pages.splice(state.pi, 1);
    pages.splice(to, 0, p);
    state.pi = to;
    markDirty();
    renderAll();
  }

  // ---- editor: rendering -------------------------------------------------

  function setStatus(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.className = "sub " + (cls || "");
  }

  function renderStoryControls() {
    $("story-title").value = st().title;
    const row = $("story-picker-row");
    if (doc.stories.length > 1) {
      row.classList.remove("hidden");
      const sel = $("story-picker");
      sel.innerHTML = "";
      doc.stories.forEach((s, i) => {
        const o = document.createElement("option");
        o.value = i;
        o.textContent = (s.title || "Untitled") + ` (${s.pages.length} pages)`;
        sel.appendChild(o);
      });
      sel.value = state.si;
    } else {
      row.classList.add("hidden");
    }
  }

  function renderPageStrip() {
    const strip = $("page-strip");
    strip.innerHTML = "";
    st().pages.forEach((p, i) => {
      const b = document.createElement("button");
      b.className = "thumb" + (i === state.pi ? " sel" : "");
      b.title = "Page " + (i + 1);
      const c = document.createElement("canvas");
      let w = 110, h = Math.round(110 / p.aspect);
      if (h > 160) { h = 160; w = Math.round(160 * p.aspect); }
      c.width = w; c.height = h;
      c.style.width = w + "px"; c.style.height = h + "px";
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = i + 1;
      b.appendChild(c);
      b.appendChild(n);
      b.addEventListener("click", () => {
        state.pi = i; state.hi = -1;
        renderAll();
      });
      strip.appendChild(b);
      const assets = store();   // capture: the active story can change while images load
      Promise.all(p.cells.map(cl => ensureImage(assets.images.get(cl.imageAsset))))
        .then(() => drawPage(c.getContext("2d"), p, w, h, assets));
    });
  }

  function renderPageControls() {
    const p = page();
    $("btn-page-left").disabled = !p || state.pi === 0;
    $("btn-page-right").disabled = !p || state.pi >= st().pages.length - 1;
    $("btn-page-delete").disabled = !p;
    const sel = $("page-layout");
    if (p && p.cells.length === 2) {
      sel.classList.remove("hidden");
      sel.value = p.layout === "twoStack" ? "twoStack" : "twoAcross";
    } else {
      sel.classList.add("hidden");
    }
  }

  let drawToken = 0;

  async function renderCanvas() {
    const p = page();
    const section = $("canvas-section");
    const spotsSection = $("spots-section");
    if (!p) {
      section.classList.add("hidden");
      spotsSection.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");
    spotsSection.classList.remove("hidden");
    const wrap = $("canvas-wrap");
    wrap.style.aspectRatio = String(p.aspect);
    const token = ++drawToken;
    await ensurePageImages(p);
    if (token !== drawToken || page() !== p) return;
    const c = $("page-canvas");
    const cssW = wrap.clientWidth || 640;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssW / p.aspect * dpr);
    drawPage(c.getContext("2d"), p, c.width, c.height, store());
    renderOverlay();
  }

  function renderOverlay() {
    const p = page();
    if (!p) return;
    const svg = $("page-overlay");
    const refW = 1000 * p.aspect, refH = 1000;
    svg.setAttribute("viewBox", `0 0 ${refW} ${refH}`);
    svg.innerHTML = "";
    p.hotspots.forEach((h, i) => {
      const g = spotGroup(h, refW, refH);
      g.classList.add("spot");
      g.dataset.i = i;
      const el = g.firstChild;
      const color = resolveSpotColor(h, COLOR_PRESETS.yellow);
      el.setAttribute("fill", i === state.hi ? hexToRgba(color, 0.16) : "rgba(0,0,0,0)");
      el.setAttribute("stroke", color);
      el.setAttribute("stroke-width", i === state.hi ? 11 : 6);
      if (i !== state.hi) el.setAttribute("stroke-dasharray", "14 8");
      svg.appendChild(g);
      // Reading-order badge at the top-left of the bounding box.
      const [bx, by] = shapeBBox(h.shape);
      const cx = clamp(bx * refW + 4, 30, refW - 30);
      const cy = clamp(by * refH - 6, 30, refH - 30);
      const badge = document.createElementNS(SVG_NS, "g");
      badge.setAttribute("pointer-events", "none");
      const circ = document.createElementNS(SVG_NS, "circle");
      circ.setAttribute("cx", cx); circ.setAttribute("cy", cy); circ.setAttribute("r", 26);
      circ.setAttribute("fill", "rgba(0,0,0,0.65)");
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("x", cx); t.setAttribute("y", cy);
      t.setAttribute("fill", "#fff"); t.setAttribute("font-size", 34);
      t.setAttribute("text-anchor", "middle"); t.setAttribute("dy", "0.36em");
      t.textContent = i + 1;
      badge.appendChild(circ); badge.appendChild(t);
      svg.appendChild(badge);
    });
  }

  function spotDisplayName(h, i) {
    if (h.label) return h.label;
    if (h.isText && h.speechText) return h.speechText;
    const kind = h.shape.type === "box" ? "Box" : h.shape.type === "ellipse" ? "Circle" : "Outline";
    return kind + " " + (i + 1);
  }

  function renderSpotList() {
    const p = page();
    const list = $("spot-list");
    list.innerHTML = "";
    if (!p) return;
    if (!p.hotspots.length) {
      const d = document.createElement("p");
      d.className = "sub";
      d.textContent = "No spots on this page yet. Drag on the photo above to make one.";
      list.appendChild(d);
    }
    p.hotspots.forEach((h, i) => {
      const row = document.createElement("div");
      row.className = "spot-row" + (i === state.hi ? " sel" : "");
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = resolveSpotColor(h, COLOR_PRESETS.yellow);
      const name = document.createElement("button");
      name.className = "name";
      name.textContent = (i + 1) + ". " + spotDisplayName(h, i);
      name.addEventListener("click", () => { state.hi = i; renderSpots(); renderOverlay(); });
      const up = document.createElement("button");
      up.className = "mini"; up.textContent = "↑"; up.title = "Earlier in the reading order";
      up.disabled = i === 0;
      up.addEventListener("click", () => {
        [p.hotspots[i - 1], p.hotspots[i]] = [p.hotspots[i], p.hotspots[i - 1]];
        if (state.hi === i) state.hi = i - 1; else if (state.hi === i - 1) state.hi = i;
        markDirty(); renderSpots(); renderOverlay();
      });
      const down = document.createElement("button");
      down.className = "mini"; down.textContent = "↓"; down.title = "Later in the reading order";
      down.disabled = i === p.hotspots.length - 1;
      down.addEventListener("click", () => {
        [p.hotspots[i], p.hotspots[i + 1]] = [p.hotspots[i + 1], p.hotspots[i]];
        if (state.hi === i) state.hi = i + 1; else if (state.hi === i + 1) state.hi = i;
        markDirty(); renderSpots(); renderOverlay();
      });
      const del = document.createElement("button");
      del.className = "mini danger"; del.textContent = "✕"; del.title = "Delete spot";
      del.addEventListener("click", () => deleteSpot(i));
      row.appendChild(sw); row.appendChild(name); row.appendChild(up); row.appendChild(down); row.appendChild(del);
      list.appendChild(row);
    });
  }

  const CAN_RECORD = typeof MediaRecorder !== "undefined"
    && typeof MediaRecorder.isTypeSupported === "function"
    && MediaRecorder.isTypeSupported("audio/mp4");

  function renderSpotPanel() {
    const h = spot();
    const panel = $("spot-panel");
    if (!h) { panel.classList.add("hidden"); return; }
    panel.classList.remove("hidden");
    $("spot-label").value = h.label;
    $("spot-speech").value = h.speechText;
    $("spot-showlabel").checked = h.showLabel;
    $("spot-istext").checked = h.isText;
    $("spot-preview").value = h.showPreview === true ? "show" : h.showPreview === false ? "hide" : "follow";
    const c = h.colorName;
    if (!c) {
      $("spot-color").value = "default";
      $("spot-color-custom").classList.add("hidden");
    } else if (COLOR_PRESETS[c]) {
      $("spot-color").value = c;
      $("spot-color-custom").classList.add("hidden");
    } else {
      $("spot-color").value = "custom";
      $("spot-color-custom").classList.remove("hidden");
      if (/^#[0-9a-fA-F]{6}$/.test(c)) $("spot-color-custom").value = c.toLowerCase();
    }
    const deg = Math.round(h.rotation * 180 / Math.PI);
    $("spot-rotate").value = deg;
    $("spot-rotate-val").textContent = deg + "°";
    if (CAN_RECORD) {
      $("audio-block").classList.remove("hidden");
      $("audio-note").classList.add("hidden");
      const has = !!(h.audioAsset && store().audio.get(h.audioAsset));
      $("btn-play-audio").disabled = !has;
      $("btn-del-audio").disabled = !has;
      $("spot-useaudio").disabled = !has;
      $("spot-useaudio").checked = h.useAudio && has;
    } else {
      $("audio-block").classList.add("hidden");
      $("audio-note").classList.remove("hidden");
    }
  }

  function renderSpots() { renderSpotList(); renderSpotPanel(); }

  function renderAll() {
    renderStoryControls();
    renderPageStrip();
    renderPageControls();
    renderCanvas();
    renderSpots();
  }

  function deleteSpot(i) {
    const p = page();
    if (!p || !p.hotspots[i]) return;
    p.hotspots.splice(i, 1);
    if (state.hi === i) state.hi = -1;
    else if (state.hi > i) state.hi--;
    garbageCollectAssets();
    markDirty();
    renderSpots();
    renderOverlay();
  }

  // ---- editor: pointer tools on the canvas -------------------------------

  function overlayUnitPoint(ev) {
    const r = $("page-overlay").getBoundingClientRect();
    return {
      x: clamp((ev.clientX - r.left) / r.width, 0, 1),
      y: clamp((ev.clientY - r.top) / r.height, 0, 1),
    };
  }

  let gesture = null; // {kind, start, points, orig, spotIndex, temp}

  function tempShapeNode(shape) {
    const p = page();
    const refW = 1000 * p.aspect;
    const el = shapeNode(shape, refW, 1000);
    el.setAttribute("fill", "rgba(255,255,255,0.12)");
    el.setAttribute("stroke", "#fff");
    el.setAttribute("stroke-width", 7);
    el.setAttribute("pointer-events", "none");
    return el;
  }

  function rectFrom(a, b) {
    return [round4(Math.min(a.x, b.x)), round4(Math.min(a.y, b.y)),
            round4(Math.abs(b.x - a.x)), round4(Math.abs(b.y - a.y))];
  }

  function onPointerDown(ev) {
    const p = page();
    if (!p || gesture) return;
    const svg = $("page-overlay");
    svg.setPointerCapture(ev.pointerId);
    const pt = overlayUnitPoint(ev);
    if (state.tool === "move") {
      const g = ev.target.closest && ev.target.closest("g.spot");
      if (g) {
        const i = Number(g.dataset.i);
        state.hi = i;
        renderSpots();
        renderOverlay();
        gesture = { kind: "drag", start: pt, orig: JSON.parse(JSON.stringify(p.hotspots[i].shape)), spotIndex: i };
      } else {
        state.hi = -1;
        renderSpots();
        renderOverlay();
      }
      return;
    }
    if (state.tool === "box" || state.tool === "ellipse") {
      gesture = { kind: state.tool, start: pt, temp: null };
    } else if (state.tool === "outline") {
      gesture = { kind: "outline", points: [pt], temp: null };
    }
    ev.preventDefault();
  }

  function onPointerMove(ev) {
    if (!gesture) return;
    const p = page();
    const pt = overlayUnitPoint(ev);
    const svg = $("page-overlay");
    if (gesture.kind === "drag") {
      const dx = pt.x - gesture.start.x, dy = pt.y - gesture.start.y;
      p.hotspots[gesture.spotIndex].shape = translateShape(gesture.orig, dx, dy);
      renderOverlay();
      return;
    }
    if (gesture.kind === "box" || gesture.kind === "ellipse") {
      const shape = { type: gesture.kind, rect: rectFrom(gesture.start, pt) };
      if (gesture.temp) gesture.temp.remove();
      gesture.temp = tempShapeNode(shape);
      svg.appendChild(gesture.temp);
      return;
    }
    if (gesture.kind === "outline") {
      gesture.points.push(pt);
      const flat = [];
      for (const q of gesture.points) flat.push(q.x, q.y);
      const shape = { type: "outline", points: flat };
      if (gesture.temp) gesture.temp.remove();
      gesture.temp = tempShapeNode(shape);
      svg.appendChild(gesture.temp);
    }
  }

  function onPointerUp(ev) {
    if (!gesture) return;
    const p = page();
    const g = gesture;
    gesture = null;
    if (g.temp) g.temp.remove();
    if (g.kind === "drag") {
      markDirty();
      renderOverlay();
      return;
    }
    const pt = overlayUnitPoint(ev);
    if (g.kind === "box" || g.kind === "ellipse") {
      const rect = rectFrom(g.start, pt);
      if (rect[2] < 0.02 || rect[3] < 0.02) return;   // a slip, not a spot
      p.hotspots.push(newHotspot({ type: g.kind, rect }));
    } else if (g.kind === "outline") {
      // Simplify in reference space so tolerance is even in both axes.
      const refW = 1000 * p.aspect;
      const ref = g.points.map(q => ({ x: q.x * refW, y: q.y * 1000 }));
      const simple = simplifyPoints(ref, 6);
      if (simple.length < 3) return;
      const flat = [];
      for (const q of simple) flat.push(round4(q.x / refW), round4(q.y / 1000));
      const shape = { type: "outline", points: flat };
      const [, , bw, bh] = shapeBBox(shape);
      if (bw < 0.02 && bh < 0.02) return;
      p.hotspots.push(newHotspot(shape));
    }
    state.hi = p.hotspots.length - 1;
    markDirty();
    renderSpots();
    renderOverlay();
  }

  // ---- editor: audio recording -------------------------------------------

  let recorder = null;

  async function toggleRecording() {
    const h = spot();
    if (!h) return;
    if (recorder) {
      recorder.stop();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert("Couldn't use the microphone: " + e.message);
      return;
    }
    // Capture the target spot and its store now; the recording belongs to
    // this spot even if the selection changes before Stop is pressed.
    const target = h;
    const targetStore = store();
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: "audio/mp4" });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      recorder = null;
      $("btn-record").textContent = "Record";
      // Nothing recorded, or the spot was deleted while recording.
      const stillExists = doc.stories.some(s => s.pages.some(p => p.hotspots.includes(target)));
      if (!chunks.length || !stillExists) { renderSpotPanel(); return; }
      // Replace any earlier recording for this spot.
      if (target.audioAsset) {
        const old = targetStore.audio.get(target.audioAsset);
        if (old && old.url) URL.revokeObjectURL(old.url);
        targetStore.audio.delete(target.audioAsset);
      }
      const name = uuid() + ".m4a";
      targetStore.audio.set(name, { blob: new Blob(chunks, { type: "audio/mp4" }), url: null });
      target.audioAsset = name;
      target.useAudio = true;
      markDirty();
      renderSpotPanel();
    };
    recorder.start();
    $("btn-record").textContent = "Stop";
  }

  // ---- Monarch Reader (formerly Tar Heel Reader) import ------------------

  const MR_CMS = "https://cms.monarchreader.com";
  const MR_CDN = "https://cdn.monarchreader.com";
  const MR_FLICKR = "https://live.staticflickr.com";
  const MR_DOWN = "Couldn't reach Monarch Reader. It may be offline, or the "
    + "library may have changed since this page was written. Stories you "
    + "build from your own photos are not affected.";

  function resolveMonarchImage(u) {
    if (u.startsWith("monarchCache:")) return MR_CDN + u.slice("monarchCache:".length);
    if (u.includes("monarch_user_uploads")) return new URL(u, MR_CDN).toString();
    if (/^https?:/.test(u)) return u;
    return new URL(u, MR_FLICKR).toString();
  }

  async function thrSearch() {
    const q = $("thr-query").value.trim();
    setStatus("thr-status", "Searching...", "");
    $("thr-results").innerHTML = "";
    const url = MR_CMS + "/items/monarch_books?limit=24"
      + "&fields=book_id,title,coverUrl,file,length,language"
      + "&filter[public][_eq]=true&filter[status][_eq]=published&filter[premium][_eq]=false"
      + (q ? "&search=" + encodeURIComponent(q) : "");
    let books;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("the library answered " + r.status);
      books = (await r.json()).data || [];
    } catch (e) {
      setStatus("thr-status", MR_DOWN, "warn");
      return;
    }
    if (!books.length) {
      setStatus("thr-status", "No books found for that search.", "");
      return;
    }
    setStatus("thr-status", books.length + " books. Pick one to turn it into a story.", "");
    const grid = $("thr-results");
    for (const b of books) {
      if (!b.file) continue;
      const card = document.createElement("button");
      card.className = "book";
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "";
      try { img.src = resolveMonarchImage(b.coverUrl || ""); } catch (_) {}
      img.addEventListener("error", () => { img.style.visibility = "hidden"; });
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = b.title || "Untitled";
      const m = document.createElement("div");
      m.className = "m";
      m.textContent = (b.length ? b.length + " pages" : "") + (b.language ? " · " + b.language : "");
      card.appendChild(img); card.appendChild(t); card.appendChild(m);
      card.addEventListener("click", () => importBook(b));
      grid.appendChild(card);
    }
  }

  async function importBook(b) {
    setStatus("thr-status", `Fetching "${b.title}"...`, "");
    let bookPages;
    try {
      const r = await fetch(MR_CMS + "/assets/" + b.file);
      if (!r.ok) throw new Error("the library answered " + r.status);
      bookPages = ((await r.json()).pages || []).filter(p => p && p._imageUuid);
    } catch (e) {
      setStatus("thr-status", MR_DOWN, "warn");
      return;
    }
    if (!bookPages.length) {
      setStatus("thr-status", "That book has no picture pages, so there is nothing to import.", "warn");
      return;
    }
    bookPages = bookPages.slice(0, 24);

    // An untouched story takes the book; otherwise the book becomes a new
    // story alongside the current one.
    let target = st();
    let addedStory = false;
    if (target.pages.length) {
      target = { id: uuid(), title: b.title || "Imported book", createdAt: isoNow(), pages: [] };
      doc.stories.push(target);
      doc.assets.set(target.id, freshStore());
      state.si = doc.stories.length - 1;
      addedStory = true;
    } else {
      target.title = b.title || target.title;
    }

    let added = 0;
    for (let i = 0; i < bookPages.length; i++) {
      setStatus("thr-status", `Page ${i + 1} of ${bookPages.length}...`, "");
      try {
        const iu = resolveMonarchImage(bookPages[i]._imageUuid);
        const r = await fetch(iu);
        if (!r.ok) continue;
        const { blob, w, h } = await encodeJpegFromBlob(await r.blob());
        const name = uuid() + ".jpg";
        doc.assets.get(target.id).images.set(name, imageRec(blob, w, h));
        const p = singlePage({ name, w, h });
        const cap = (bookPages[i]._text || "").trim();
        if (cap) {
          const capSpot = newHotspot({ type: "box", rect: [0.05, 0.82, 0.9, 0.14] });
          capSpot.isText = true;
          capSpot.label = cap;
          capSpot.speechText = cap;
          p.hotspots.push(capSpot);
        }
        target.pages.push(p);
        added++;
      } catch (e) {
        // One broken image shouldn't sink the book; skip the page.
      }
    }
    garbageCollectAssets();   // a page that failed half-way can leave a stray photo
    if (!added) {
      if (addedStory) {        // don't leave an empty story behind
        doc.stories.pop();
        doc.assets.delete(target.id);
        state.si = Math.min(state.si, doc.stories.length - 1);
      }
      renderAll();
      setStatus("thr-status", MR_DOWN, "warn");
      return;
    }
    state.pi = 0;
    state.hi = -1;
    markDirty();
    renderAll();
    setStatus("thr-status", `Added ${added} pages from "${b.title}". Each caption is a spot that reads itself aloud.`, "ok");
  }

  // ---- files: open and save ----------------------------------------------

  async function wrapDocFromBuffer(buf) {
    const { stories, rawAssets } = await parseOastoryBuffer(buf);
    const assets = new Map();
    for (const [id, raw] of rawAssets) {
      const images = new Map(), audio = new Map();
      for (const [name, bytes] of raw.images) {
        images.set(name, imageRec(new Blob([bytes], { type: "image/jpeg" })));
      }
      for (const [name, bytes] of raw.audio) {
        audio.set(name, { blob: new Blob([bytes], { type: "audio/mp4" }), url: null });
      }
      assets.set(id, { images, audio });
    }
    return { stories, assets };
  }

  async function openStoryFile(file) {
    try {
      const next = await wrapDocFromBuffer(await file.arrayBuffer());
      revokeDoc(doc);
      doc = next;
      state.si = 0; state.pi = 0; state.hi = -1;
      dirty = false;
      const pages = doc.stories.reduce((n, s) => n + s.pages.length, 0);
      setStatus("file-status", `Opened ${file.name}: `
        + (doc.stories.length === 1 ? "" : doc.stories.length + " stories, ")
        + pages + (pages === 1 ? " page." : " pages."), "ok");
      renderAll();
    } catch (e) {
      setStatus("file-status", "Couldn't open that file: " + e.message, "warn");
    }
  }

  async function saveStoryFile() {
    const btn = $("btn-save");
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const blob = await buildOastoryFiles(doc.stories, doc.assets);
      const name = (st().title.trim() || "story").replace(/[\\/:*?"<>|]+/g, "-") + ".oastory";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      dirty = false;
      setStatus("file-status", "Saved " + name + ". Open it in the iPad app, or here with \"Open a story file\".", "ok");
    } catch (e) {
      setStatus("file-status", "Couldn't save: " + e.message, "warn");
    } finally {
      btn.disabled = false;
    }
  }

  // ---- player ------------------------------------------------------------

  const settings = Object.assign({
    mode: "auto", dwell: 2, color: "yellow", customHex: "#ffd60a", previews: true,
  }, (() => {
    try { return JSON.parse(localStorage.getItem("oar-reader-settings")) || {}; }
    catch (_) { return {}; }
  })());

  function saveSettings() {
    try { localStorage.setItem("oar-reader-settings", JSON.stringify(settings)); } catch (_) {}
  }

  function globalScanColor() {
    if (settings.color === "custom") return settings.customHex.toUpperCase();
    return COLOR_PRESETS[settings.color] || COLOR_PRESETS.yellow;
  }

  let pv = null; // { stories, assets, si, pi, targets, ti, timer, acc, captionAt }

  function pvStory() { return pv.stories[pv.si]; }
  function pvPage() { return pvStory().pages[pv.pi]; }
  function pvStore() { return pv.assets.get(pvStory().id) || freshStore(); }

  function openPlayer(stories, assets, si, ownedDoc) {
    const story = stories[si];
    if (!story || !story.pages.length) {
      alert("This story has no pages yet. Add a photo first.");
      if (ownedDoc) revokeDoc(ownedDoc);
      return;
    }
    pv = { stories, assets, si, pi: 0, targets: [], ti: 0, timer: null, acc: 0, captionAt: 0, ownedDoc };
    $("player").classList.remove("hidden");
    document.body.style.overflow = "hidden";
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    pvSetPage(0);
    pv.timer = setInterval(pvTick, 100);
  }

  function closePlayer() {
    if (!pv) return;
    clearInterval(pv.timer);
    stopSound();
    // A story opened straight from a file owns its blobs; free them.
    if (pv.ownedDoc) revokeDoc(pv.ownedDoc);
    pv = null;
    $("player").classList.add("hidden");
    $("pv-caption").classList.add("hidden");
    document.body.style.overflow = "";
  }

  function pvSetPage(i) {
    pv.pi = i;
    pv.ti = 0;
    pv.acc = 0;
    const p = pvPage();
    pv.targets = p.hotspots.map((h, j) => ({ type: "spot", i: j }))
      .concat([{ type: "next" }, { type: "prev" }, { type: "close" }]);
    $("pv-caption").classList.add("hidden");
    pvRender();
  }

  let pvDrawToken = 0;

  async function pvRender() {
    if (!pv) return;
    const p = pvPage();
    const stage = $("pv-stage");
    stage.style.aspectRatio = String(p.aspect);
    stage.style.width = `min(100vw - 9.5rem, calc((100vh - 7rem) * ${p.aspect}))`;
    const token = ++pvDrawToken;
    await Promise.all(p.cells.map(c => ensureImage(pvStore().images.get(c.imageAsset))));
    if (!pv || token !== pvDrawToken) return;
    const c = $("pv-canvas");
    const dpr = window.devicePixelRatio || 1;
    const cssW = stage.clientWidth || 800;
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssW / p.aspect * dpr);
    drawPage(c.getContext("2d"), p, c.width, c.height, pvStore());
    pvRenderOverlay();
  }

  function pvPreviewVisible(h) {
    if (h.showPreview === true) return true;
    if (h.showPreview === false) return false;
    return settings.previews;
  }

  function pvRenderOverlay() {
    const p = pvPage();
    const svg = $("pv-overlay");
    const refW = 1000 * p.aspect, refH = 1000;
    svg.setAttribute("viewBox", `0 0 ${refW} ${refH}`);
    svg.innerHTML = "";
    const current = pv.targets[pv.ti];
    p.hotspots.forEach((h, i) => {
      const g = spotGroup(h, refW, refH);
      g.classList.add("spot");
      const el = g.firstChild;
      const highlighted = current && current.type === "spot" && current.i === i;
      if (highlighted) {
        const color = resolveSpotColor(h, globalScanColor());
        el.setAttribute("stroke", color);
        el.setAttribute("stroke-width", 14);
        el.setAttribute("fill", hexToRgba(color, 0.15));
      } else if (pvPreviewVisible(h)) {
        el.setAttribute("stroke", "rgba(255,255,255,0.55)");
        el.setAttribute("stroke-width", 5);
        el.setAttribute("stroke-dasharray", "16 10");
        el.setAttribute("fill", "rgba(0,0,0,0)");
      } else {
        el.setAttribute("stroke", "none");
        el.setAttribute("fill", "rgba(0,0,0,0)");
      }
      g.addEventListener("click", () => {
        const ti = pv.targets.findIndex(t => t.type === "spot" && t.i === i);
        if (ti >= 0) { pv.ti = ti; pv.acc = 0; pvRenderOverlay(); pvPick(); }
      });
      svg.appendChild(g);
    });
    const hlColor = globalScanColor();
    for (const [id, type] of [["pv-next", "next"], ["pv-prev", "prev"], ["pv-close", "close"]]) {
      const on = current && current.type === type;
      const btn = $(id);
      btn.classList.toggle("hl", on);
      btn.style.boxShadow = on ? `0 0 0 6px ${hlColor}` : "";
    }
  }

  function pvAdvance(dir) {
    if (!pv || !pv.targets.length) return;
    pv.ti = (pv.ti + dir + pv.targets.length) % pv.targets.length;
    pv.acc = 0;
    pvRenderOverlay();
  }

  function pvPick() {
    if (!pv) return;
    const t = pv.targets[pv.ti];
    if (!t) return;
    if (t.type === "next") { stopSound(); pvSetPage((pv.pi + 1) % pvStory().pages.length); return; }
    if (t.type === "prev") { stopSound(); pvSetPage((pv.pi - 1 + pvStory().pages.length) % pvStory().pages.length); return; }
    if (t.type === "close") { closePlayer(); return; }
    const h = pvPage().hotspots[t.i];
    if (!h) return;
    const captionText = h.isText ? (h.speechText || h.label) : h.label;
    const cap = $("pv-caption");
    if (h.showLabel !== false && captionText) {
      cap.textContent = captionText;
      cap.classList.remove("hidden");
      pv.captionAt = Date.now();
    } else {
      cap.classList.add("hidden");
    }
    const rec = h.useAudio && h.audioAsset && pvStore().audio.get(h.audioAsset);
    // Fall back to speech if the recording can't play (a browser without
    // AAC), so a picked spot is never silent.
    if (rec) playAudioBlob(rec, () => speak(h.speechText || h.label));
    else speak(h.speechText || h.label);
    pv.acc = 0;
  }

  function pvTick() {
    if (!pv) return;
    const cap = $("pv-caption");
    if (!cap.classList.contains("hidden")
        && Date.now() - pv.captionAt > 2600 && !isSpeaking()) {
      cap.classList.add("hidden");
    }
    if (settings.mode !== "auto") return;
    if (isSpeaking()) return;   // the dwell timer waits for speech to finish
    pv.acc += 100;
    if (pv.acc >= settings.dwell * 1000) pvAdvance(1);
  }

  function onKeyDown(ev) {
    if (!pv) return;
    // A held-down switch or key auto-repeats keydown; ignore the repeats so
    // one press is one action.
    if (ev.repeat) return;
    const c = ev.code;
    if (!["F13", "F14", "F15", "Space", "Enter"].includes(c)) return;
    ev.preventDefault();
    if (settings.mode === "auto") { pvPick(); return; }
    if (c === "F13" || c === "Space") pvAdvance(1);
    else if (c === "F14" || c === "Enter") pvPick();
    else if (c === "F15") pvAdvance(-1);
  }

  // ---- wire-up -----------------------------------------------------------

  $("btn-new").addEventListener("click", () => {
    if (dirty && !confirm("Throw away unsaved changes and start a new story?")) return;
    revokeDoc(doc);
    doc = freshDoc();
    state.si = 0; state.pi = 0; state.hi = -1;
    dirty = false;
    setStatus("file-status", "", "");
    renderAll();
  });

  $("btn-open").addEventListener("click", () => {
    if (dirty && !confirm("Throw away unsaved changes and open a different story?")) return;
    $("file-open").value = "";
    $("file-open").click();
  });
  $("file-open").addEventListener("change", () => {
    const f = $("file-open").files[0];
    if (f) openStoryFile(f);
  });

  $("btn-save").addEventListener("click", saveStoryFile);

  $("story-title").addEventListener("input", e => {
    st().title = e.target.value;
    markDirty();
  });

  $("story-picker").addEventListener("change", e => {
    state.si = Number(e.target.value) || 0;
    state.pi = 0; state.hi = -1;
    renderAll();
  });

  $("btn-add-photos").addEventListener("click", () => {
    $("file-photos").value = "";
    $("file-photos").click();
  });
  $("file-photos").addEventListener("change", () => {
    const files = [...$("file-photos").files].filter(f =>
      ["image/jpeg", "image/png", "image/webp"].includes(f.type));
    if (files.length) addPagesFromFiles(files);
  });

  $("btn-page-left").addEventListener("click", () => movePage(-1));
  $("btn-page-right").addEventListener("click", () => movePage(1));
  $("btn-page-delete").addEventListener("click", deletePage);
  $("page-layout").addEventListener("change", e => {
    const p = page();
    if (!p) return;
    p.layout = e.target.value;
    markDirty();
    renderPageStrip();
    renderCanvas();
  });

  for (const b of document.querySelectorAll(".toolbtn")) {
    b.addEventListener("click", () => {
      state.tool = b.dataset.tool;
      document.querySelectorAll(".toolbtn").forEach(x => x.classList.toggle("active", x === b));
    });
  }

  {
    const svg = $("page-overlay");
    svg.addEventListener("pointerdown", onPointerDown);
    svg.addEventListener("pointermove", onPointerMove);
    svg.addEventListener("pointerup", onPointerUp);
    svg.addEventListener("pointercancel", () => {
      if (gesture && gesture.temp) gesture.temp.remove();
      gesture = null;
      renderOverlay();
    });
  }

  const bindSpot = (id, event, apply) => {
    $(id).addEventListener(event, e => {
      const h = spot();
      if (!h) return;
      apply(h, e.target);
      markDirty();
    });
  };

  bindSpot("spot-label", "input", (h, el) => { h.label = el.value; renderSpotList(); });
  bindSpot("spot-speech", "input", (h, el) => { h.speechText = el.value; });
  bindSpot("spot-showlabel", "change", (h, el) => { h.showLabel = el.checked; });
  bindSpot("spot-istext", "change", (h, el) => { h.isText = el.checked; renderSpotList(); });
  bindSpot("spot-preview", "change", (h, el) => {
    h.showPreview = el.value === "show" ? true : el.value === "hide" ? false : null;
  });
  bindSpot("spot-color", "change", (h, el) => {
    if (el.value === "default") {
      delete h.colorName;
      $("spot-color-custom").classList.add("hidden");
    } else if (el.value === "custom") {
      $("spot-color-custom").classList.remove("hidden");
      h.colorName = $("spot-color-custom").value.toUpperCase();
    } else {
      h.colorName = el.value;
      $("spot-color-custom").classList.add("hidden");
    }
    renderSpotList();
    renderOverlay();
  });
  bindSpot("spot-color-custom", "input", (h, el) => {
    h.colorName = el.value.toUpperCase();
    renderSpotList();
    renderOverlay();
  });
  bindSpot("spot-rotate", "input", (h, el) => {
    h.rotation = Number(el.value) * Math.PI / 180;
    $("spot-rotate-val").textContent = el.value + "°";
    renderOverlay();
  });
  bindSpot("spot-useaudio", "change", (h, el) => { h.useAudio = el.checked; });

  $("btn-hear").addEventListener("click", () => {
    const h = spot();
    if (h) speak(h.speechText || h.label);
  });
  $("btn-record").addEventListener("click", toggleRecording);
  $("btn-play-audio").addEventListener("click", () => {
    const h = spot();
    const rec = h && h.audioAsset && store().audio.get(h.audioAsset);
    if (rec) playAudioBlob(rec);
  });
  $("btn-del-audio").addEventListener("click", () => {
    const h = spot();
    if (!h || !h.audioAsset) return;
    delete h.audioAsset;
    h.useAudio = false;
    garbageCollectAssets();
    markDirty();
    renderSpotPanel();
  });
  $("btn-del-spot").addEventListener("click", () => {
    if (state.hi >= 0) deleteSpot(state.hi);
  });

  $("btn-thr-search").addEventListener("click", thrSearch);
  $("thr-query").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); thrSearch(); }
  });

  // Reader settings.
  $("scan-mode").value = settings.mode;
  $("scan-dwell").value = settings.dwell;
  $("scan-dwell-val").textContent = settings.dwell;
  $("scan-color").value = (COLOR_PRESETS[settings.color] || settings.color === "custom") ? settings.color : "yellow";
  $("scan-color-custom").value = settings.customHex;
  $("scan-color-custom").classList.toggle("hidden", settings.color !== "custom");
  $("scan-previews").checked = settings.previews;

  $("scan-mode").addEventListener("change", e => { settings.mode = e.target.value; saveSettings(); });
  $("scan-dwell").addEventListener("input", e => {
    settings.dwell = Number(e.target.value) || 2;
    $("scan-dwell-val").textContent = settings.dwell;
    saveSettings();
  });
  $("scan-color").addEventListener("change", e => {
    settings.color = e.target.value;
    $("scan-color-custom").classList.toggle("hidden", settings.color !== "custom");
    saveSettings();
  });
  $("scan-color-custom").addEventListener("input", e => {
    settings.customHex = e.target.value;
    saveSettings();
  });
  $("scan-previews").addEventListener("change", e => { settings.previews = e.target.checked; saveSettings(); });

  $("btn-read").addEventListener("click", () => openPlayer(doc.stories, doc.assets, state.si));
  $("btn-read-file").addEventListener("click", () => {
    $("file-read").value = "";
    $("file-read").click();
  });
  $("file-read").addEventListener("change", async () => {
    const f = $("file-read").files[0];
    if (!f) return;
    try {
      const d = await wrapDocFromBuffer(await f.arrayBuffer());
      let si = d.stories.findIndex(s => s.pages.length);
      if (si < 0) { revokeDoc(d); throw new Error("no pages in that story"); }
      openPlayer(d.stories, d.assets, si, d);
    } catch (e) {
      alert("Couldn't read that file: " + e.message);
    }
  });

  $("pv-next").addEventListener("click", () => {
    if (!pv) return;
    pv.ti = pv.targets.findIndex(t => t.type === "next");
    pvPick();
  });
  $("pv-prev").addEventListener("click", () => {
    if (!pv) return;
    pv.ti = pv.targets.findIndex(t => t.type === "prev");
    pvPick();
  });
  $("pv-close").addEventListener("click", closePlayer);

  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", () => {
    renderCanvas();
    if (pv) pvRender();
  });
  window.addEventListener("beforeunload", e => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });

  // Off we go.
  doc = freshDoc();
  renderAll();
}

if (typeof document !== "undefined") boot();
