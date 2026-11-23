#!/usr/bin/env node
// Generates every brand mark of the house from TWO source graphics.
//
// TILE (tools/icon/source.png) — the app icon: desktop, dock, home screen, and thus also the image iOS shows on EVERY notification
// (there is no second choice there).
//   client/build/icon.png + icon.icns + Assets.car       (Electron client, macOS)
//   mobile/…/AppIcon.appiconset/AppIcon.png (iOS, 1024, no alpha, full bleed)
//   web/src/app/apple-icon.png              (web, home screen of iPhone/iPad: apple-touch-icon, 180, no alpha, full bleed)
//
//   web/src/app/icon.png                    (browser tab, favicon: the tile, 512, no alpha)
//
// LENS (tools/icon/lens.png) — the mark INSIDE the app, without the tile. The source is drawn for a DARK ground (light letter, blue
// square); on a light ground that letter would vanish. So every lens comes twice:
//   web/public/cbase-lens.png                 (dark ground: the source as it is)
//   web/public/cbase-lens-ink.png             (light ground: the letter in the tile colour, the square stays)
//   mobile/…/CbaseLens.imageset/lens.png      (dark appearance)   + lens-ink.png (any/light appearance)
//   client/connect.html                       (both inline as data URIs, 128 px; the page's prefers-color-scheme picks)
// Web picks by `data-theme` (`.cb-lens-on-dark` / `.cb-lens-on-light`, component `CbaseLens`), iOS by the asset catalog's luminosity
// appearance. The watermark uses cbase-lens.png only as a CSS mask, so only its alpha counts there.
//
// The tab is the TILE: the lens brings no ground of its own, and a light letter on a light tab strip is invisible. The mark is a
// simple, bold shape, so the tile still reads at 16 px.
//
// Both crops find the content via the ALPHA CHANNEL, not via fixed numbers — a new source with a different margin runs through without
// adjustment.
//
// macOS: Apple grid — 1024 canvas, tile 824 px centred, corners as the Apple rounding (185.4 px), a soft shadow below. Tahoe masks to
// its squircle anyway; on macOS 11–15 the rounding keeps the tile from looking more angular than its neighbours. iOS gets the tile full
// bleed — the system masks there.
//
//   node tools/icon/build-icons.mjs [source.png] [lens.png]

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const require = createRequire(path.join(REPO, "server", "backend", "package.json"));
const sharp = require("sharp");

const SOURCE = path.resolve(process.argv[2] || path.join(HERE, "source.png"));
const LENS = path.resolve(process.argv[3] || path.join(HERE, "lens.png"));
const TARGETS = {
  macPng: [path.join(REPO, "client/build/icon.png")],
  macIcns: [path.join(REPO, "client/build/icon.icns")],
  ios: path.join(REPO, "mobile/CbaseMobile/Assets.xcassets/AppIcon.appiconset/AppIcon.png"),
  car: [path.join(REPO, "client/build/Assets.car")],
  lens: [
    path.join(REPO, "web/public/cbase-lens.png"),
    path.join(REPO, "mobile/CbaseMobile/Assets.xcassets/CbaseLens.imageset/lens.png"),
  ],
  lensInk: [
    path.join(REPO, "web/public/cbase-lens-ink.png"),
    path.join(REPO, "mobile/CbaseMobile/Assets.xcassets/CbaseLens.imageset/lens-ink.png"),
  ],
  connect: path.join(REPO, "client/connect.html"),
  tab: path.join(REPO, "web/src/app/icon.png"),
  touch: path.join(REPO, "web/src/app/apple-icon.png"),
};

const CANVAS = 1024;
const TILE = 824;            // Apple's icon grid
// Apple's template: 185.4 px corner radius on 824 px. Measured in fresh probe bundles (NSWorkspace rendering under macOS 26): with an
// opaque tile edge-to-edge at 150, 170, 185.4 and 190 — and at 180, of all values, the grey frame, reproducible, with and without a
// shadow. Geometrically this cannot be explained; what matters is the opacity (see below).
// Whoever changes the value checks it in a bundle with a NEW identifier — the icon service caches.
const RADIUS = 185.4;
const MARGIN = (CANVAS - TILE) / 2;
const ICON_NAME = "cbase";    // name of the icon in the asset catalog (= CFBundleIconName)

async function tileFromSource() {
  const { data, info } = await sharp(SOURCE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  // The tile must be FULLY opaque. The source is 253/255 transparent inside (render artefact) — and on exactly that macOS 26 decides
  // whether an old .icns is shown edge-to-edge or shrunk into a grey frame. Tile with alpha 253 => grey frame, the same tile with 255
  // => edge-to-edge. From 240 on a pixel therefore counts as surface; below that the edge stays soft.
  let p99 = 0;
  { const vals = []; for (let i = 3; i < data.length; i += c * 13) vals.push(data[i]); vals.sort((a, b) => a - b); p99 = vals[Math.floor(vals.length * 0.99)] || 255; }
  const OPAQUE_FROM = 240;
  let l = w, r = -1, t = h, b = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * c;
    const raw = data[i + 3];
    const a = raw >= OPAQUE_FROM ? 255 : Math.round((raw * 255) / OPAQUE_FROM);
    data[i + 3] = a;
    if (a > 200) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
  }
  // Base colour of the tile at the edge (for the opaque derivations): mean of the opaque pixels in the outer band
  let sr = 0, sg = 0, sb = 0, n = 0;
  const band = Math.round((r - l) * 0.03);
  for (let y = t; y <= b; y++) for (let x = l; x <= r; x++) {
    if (x > l + band && x < r - band && y > t + band && y < b - band) continue;
    const i = (y * w + x) * c; if (data[i + 3] < 250) continue;
    sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++;
  }
  const reason = { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n) };
  const crop = await sharp(data, { raw: { width: w, height: h, channels: c } })
    .extract({ left: l, top: t, width: r - l + 1, height: b - t + 1 }).png().toBuffer();
  return { crop, reason, bbox: { l, t, r, b, w: r - l + 1, h: b - t + 1 }, p99 };
}

function rundeck(size, radius, fill) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${fill}"/></svg>`);
}

async function macCanvas(crop) {
  const tile = await sharp(crop).resize(TILE, TILE, { fit: "fill", kernel: "lanczos3" })
    .composite([{ input: rundeck(TILE, RADIUS, "#fff"), blend: "dest-in" }]).png().toBuffer();
  const shadow = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}">
    <defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="12"/></filter></defs>
    <rect x="${MARGIN}" y="${MARGIN + 10}" width="${TILE}" height="${TILE}" rx="${RADIUS}" fill="#000" fill-opacity="0.32" filter="url(#b)"/>
  </svg>`);
  return sharp({ create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: shadow }, { input: tile, left: MARGIN, top: MARGIN }]).png().toBuffer();
}

async function icns(canvasPng, target) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-icon-"));
  const set = path.join(dir, "icon.iconset");
  fs.mkdirSync(set);
  const sizes = [[16, "16x16"], [32, "16x16@2x"], [32, "32x32"], [64, "32x32@2x"], [128, "128x128"], [256, "128x128@2x"], [256, "256x256"], [512, "256x256@2x"], [512, "512x512"], [1024, "512x512@2x"]];
  for (const [px, name] of sizes) {
    await sharp(canvasPng).resize(px, px, { kernel: "lanczos3" }).png().toFile(path.join(set, `icon_${name}.png`));
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", target], { stdio: "inherit" });
  fs.rmSync(dir, { recursive: true, force: true });
}

// Full bleed means: the corners outside the tile rounding must be filled. Not with ONE colour (the edge carries a light edge at the
// top, it is darker at the bottom — a mean fits no corner), but with the heavily blurred image itself: each corner gets the colour of
// its surroundings. This is visible only where no system masking applies (favicon); iOS and CSS rounding cut the corners away.
async function fullBleed(crop, reason, px) {
  const field = await sharp(crop).resize(8, 8, { fit: "fill" }).flatten({ background: reason }).png().toBuffer();
  const tile = await sharp(crop).resize(px, px, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
  return sharp(field).resize(px, px, { fit: "fill", kernel: "cubic" })
    .composite([{ input: tile }]).removeAlpha().png().toBuffer();
}

// The lens without a tile: cropped to the content and centred in a square field (`contain`, transparent). Cropping goes via the alpha
// channel — so the mark sits the same at every size, however much air the source brings. Palette PNG, because a 512 lens then weighs
// about 50 instead of 260 KB and the difference is not visible on a 28 px logo (let alone a 16 px tab).
//
// `ink` (an {r,g,b}) gives the light-ground variant: every pixel that is not the blue accent takes the ink colour, alpha untouched, so
// the anti-aliased edge stays as soft as in the source. "Blue" = blue clearly above red; the light letter is near-grey, the accent is not.
async function lensField(px, ink = null) {
  const { data, info } = await sharp(LENS).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  if (ink) {
    for (let i = 0; i < data.length; i += c) {
      if (data[i + 3] === 0 || data[i + 2] - data[i] > 60) continue;
      data[i] = ink.r; data[i + 1] = ink.g; data[i + 2] = ink.b;
    }
  }
  let l = w, r = -1, t = h, b = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * c + 3] > 8) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
  }
  return sharp(data, { raw: { width: w, height: h, channels: c } })
    .extract({ left: l, top: t, width: r - l + 1, height: b - t + 1 })
    .resize(px, px, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: "lanczos3" })
    .png({ palette: true }).toBuffer();
}

// macOS 26 (Tahoe) shows an icon like the system icons (edge-to-edge in the squircle, with a glass edge) only if it lies in the asset
// catalog as an Icon Composer icon (`Assets.car` + `CFBundleIconName`). The package is a folder with `icon.json` and the layers; here
// ONE layer with the full-bleed tile, the system crops it itself. Compiled with `actool` from Xcode 26 — if missing, it stays with the
// .icns (then a warning, no abort).
async function assetsCar(level, reason, targets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-icon-car-"));
  const pack = path.join(dir, `${ICON_NAME}.icon`);
  fs.mkdirSync(path.join(pack, "Assets"), { recursive: true });
  fs.writeFileSync(path.join(pack, "Assets", "tile.png"), level);
  const srgb = [reason.r, reason.g, reason.b].map((v) => (v / 255).toFixed(3)).join(",");
  fs.writeFileSync(path.join(pack, "icon.json"), JSON.stringify({
    fill: { solid: `srgb:${srgb},1.000` },
    groups: [{
      layers: [{ "image-name": "tile.png", name: "tile" }],
      shadow: { kind: "neutral", opacity: 0.5 },
      translucency: { enabled: false, value: 0.5 },
    }],
    "supported-platforms": { circles: ["watchOS"], squares: "shared" },
  }, null, 2));
  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  try {
    execFileSync("xcrun", ["actool", pack, "--compile", out, "--output-format", "human-readable-text", "--errors", "--warnings",
      "--output-partial-info-plist", path.join(out, "partial.plist"), "--app-icon", ICON_NAME, "--include-all-app-icons",
      "--enable-on-demand-resources", "NO", "--development-region", "en", "--target-device", "mac",
      "--minimum-deployment-target", "26.0", "--platform", "macosx"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer" } });
    const car = path.join(out, "Assets.car");
    if (!fs.existsSync(car)) throw new Error("actool wrote no Assets.car");
    for (const z of targets) { fs.copyFileSync(car, z); console.log("→", path.relative(REPO, z)); }
  } catch (e) {
    console.warn(`WARNING: Assets.car not generated (${e.message.split("\n")[0]}) — macOS 26 then shows the .icns.`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const { crop, reason, bbox, p99 } = await tileFromSource();
console.log(`Source ${path.relative(REPO, SOURCE)}: tile ${bbox.w}×${bbox.h} px at (${bbox.l},${bbox.t}), alpha p99 ${p99}, base colour #${[reason.r, reason.g, reason.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);

const canvas = await macCanvas(crop);
for (const z of TARGETS.macPng) { fs.writeFileSync(z, canvas); console.log("→", path.relative(REPO, z)); }
for (const z of TARGETS.macIcns) { await icns(canvas, z); console.log("→", path.relative(REPO, z)); }
const full1024 = await fullBleed(crop, reason, 1024);
fs.writeFileSync(TARGETS.ios, full1024); console.log("→", path.relative(REPO, TARGETS.ios));
fs.writeFileSync(TARGETS.touch, await fullBleed(crop, reason, 180)); console.log("→", path.relative(REPO, TARGETS.touch));
fs.writeFileSync(TARGETS.tab, await fullBleed(crop, reason, 512)); console.log("→", path.relative(REPO, TARGETS.tab));
await assetsCar(full1024, reason, TARGETS.car);

const lens512 = await lensField(512);
for (const z of TARGETS.lens) { fs.writeFileSync(z, lens512); console.log("→", path.relative(REPO, z)); }
// Ink = the tile's own ground colour: on a light ground the letter takes the colour it has as the background of the app icon.
const lensInk512 = await lensField(512, reason);
for (const z of TARGETS.lensInk) { fs.writeFileSync(z, lensInk512); console.log("→", path.relative(REPO, z)); }

// The client's connect page carries both lenses inline (128 px, data URI): one `<img class="mark mark-ink">` and one
// `<img class="mark mark-light">`, the page's own prefers-color-scheme rule shows the fitting one. Each slot must occur exactly once.
{
  let html = fs.readFileSync(TARGETS.connect, "utf8");
  for (const [slot, png] of [["mark-ink", await lensField(128, reason)], ["mark-light", await lensField(128)]]) {
    const re = new RegExp(`(<img class="mark ${slot}" alt="" src=")data:image/png;base64,[^"]*(")`, "g");
    if ((html.match(re) || []).length !== 1) throw new Error(`${path.relative(REPO, TARGETS.connect)}: slot ${slot} not found exactly once`);
    html = html.replace(re, `$1data:image/png;base64,${png.toString("base64")}$2`);
  }
  fs.writeFileSync(TARGETS.connect, html); console.log("→", path.relative(REPO, TARGETS.connect));
}
