#!/usr/bin/env bun
/**
 * Copies the Harness logo and app icons from the shared logo repository (harness-useful-logo, renders/dashboard):
 *
 *   tile.svg                           web/public/favicon.svg (browser tab) and assets/icons/harness-dashboard.svg (Linux)
 *   mark.svg                           web/public/logo.svg (the sidebar header, no tile behind it)
 *   app.ico                            assets/icons/harness-dashboard.ico and src-tauri/icons/icon.ico (Windows)
 *   app.icns                           assets/icons/harness-dashboard.icns and src-tauri/icons/icon.icns (macOS)
 *   png/tile-32|128|256|512.png        src-tauri/icons/32x32.png, 128x128.png, 128x128@2x.png, icon.png (the app bundles)
 *   harness-logo.js + .d.ts            web/src/lib/brand/ (the launch animation)
 *   sound.wav                          web/public/brand/sound.wav (the sound of the launch animation, the app plays it too)
 *   lockup-dark.svg, lockup-light.svg  docs/brand/ (the logo at the top of the README)
 *   OFL.txt                            docs/brand/ (the license of the Inter font the lockups embed)
 *
 * The tray icon is the mark without its tile: mark.svg on a square canvas (src-tauri/icons/source/tray.svg), rendered at
 * 64 px by `tauri icon` to src-tauri/icons/tray.png.
 *
 * The copies are committed and published with every release. Run again after the logo changes:
 *
 *   bun scripts/icons.ts [logoRepoDir]     (default ../harness-useful-logo)
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const logoRepo = resolve(ROOT, process.argv[2] ?? "../harness-useful-logo");
const renders = join(logoRepo, "renders", "dashboard");

if (!existsSync(renders)) {
  console.error(`No logo render at ${renders}\nrender it first: cd ${logoRepo} && bun run render dashboard`);
  process.exit(1);
}

const COPIES: [string, string][] = [
  ["tile.svg", "web/public/favicon.svg"],
  ["mark.svg", "web/public/logo.svg"],
  ["tile.svg", "assets/icons/harness-dashboard.svg"],
  ["app.ico", "assets/icons/harness-dashboard.ico"],
  ["app.icns", "assets/icons/harness-dashboard.icns"],
  ["app.ico", "src-tauri/icons/icon.ico"],
  ["app.icns", "src-tauri/icons/icon.icns"],
  ["png/tile-32.png", "src-tauri/icons/32x32.png"],
  ["png/tile-128.png", "src-tauri/icons/128x128.png"],
  ["png/tile-256.png", "src-tauri/icons/128x128@2x.png"],
  ["png/tile-512.png", "src-tauri/icons/icon.png"],
  ["harness-logo.js", "web/src/lib/brand/harness-logo.js"],
  ["harness-logo.d.ts", "web/src/lib/brand/harness-logo.d.ts"],
  ["sound.wav", "web/public/brand/sound.wav"],
  ["lockup-dark.svg", "docs/brand/lockup-dark.svg"],
  ["lockup-light.svg", "docs/brand/lockup-light.svg"],
  ["OFL.txt", "docs/brand/OFL.txt"],
];

for (const [from, to] of COPIES) {
  const source = join(renders, from);
  if (!existsSync(source)) {
    console.error(`Missing ${source}\nrender it first: cd ${logoRepo} && bun run render dashboard`);
    process.exit(1);
  }

  const target = join(ROOT, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`${from} -> ${to}`);
}

/** Share of the square tray canvas the mark spans, as in the other Harness apps' tray icons. */
const TRAY_FILL = 0.926;

/** mark.svg centered on a square canvas, since `tauri icon` renders square sources only. */
function squareMark(svg: string): string {
  const viewBox = /viewBox="([\d.\s-]+)"/.exec(svg)?.[1]?.trim().split(/\s+/).map(Number);
  if (!viewBox || viewBox.length !== 4) throw new Error("mark.svg has no viewBox");

  const [x, y, width, height] = viewBox as [number, number, number, number];
  const side = Math.max(width, height) / TRAY_FILL;
  const left = x + width / 2 - side / 2;
  const top = y + height / 2 - side / 2;
  const box = [left, top, side, side].map((value) => Number(value.toFixed(3))).join(" ");

  return svg.replace(/<svg [^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="${box}">`);
}

const traySource = join(ROOT, "src-tauri/icons/source/tray.svg");
mkdirSync(dirname(traySource), { recursive: true });
writeFileSync(traySource, squareMark(readFileSync(join(renders, "mark.svg"), "utf8")));
console.log("mark.svg -> src-tauri/icons/source/tray.svg");

const rendered = mkdtempSync(join(tmpdir(), "harness-dashboard-tray-"));
try {
  const result = Bun.spawnSync(["bunx", "tauri", "icon", traySource, "-o", rendered, "-p", "64"], { cwd: ROOT, stdout: "ignore", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`tauri icon failed with exit code ${result.exitCode}`);

  copyFileSync(join(rendered, "64x64.png"), join(ROOT, "src-tauri/icons/tray.png"));
  console.log("src-tauri/icons/source/tray.svg -> src-tauri/icons/tray.png (64 px)");
} finally {
  rmSync(rendered, { recursive: true, force: true });
}
