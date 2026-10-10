#!/usr/bin/env bun
/**
 * Copies the Harness logo and app icons from the shared logo repository (harness-useful-logo, renders/dashboard):
 *
 *   tile.svg                           web/public/favicon.svg (browser tab) and assets/icons/harness-dashboard.svg (Linux)
 *   mark.svg                           web/public/logo.svg (the sidebar header, no tile behind it)
 *   app.ico                            assets/icons/harness-dashboard.ico (Windows)
 *   app.icns                           assets/icons/harness-dashboard.icns (macOS)
 *   harness-logo.js + .d.ts            web/src/lib/brand/ (the launch animation)
 *
 * The copies are committed and published with every release. Run again after the logo changes:
 *
 *   bun scripts/icons.ts [logoRepoDir]     (default ../harness-useful-logo)
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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
  ["harness-logo.js", "web/src/lib/brand/harness-logo.js"],
  ["harness-logo.d.ts", "web/src/lib/brand/harness-logo.d.ts"],
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
