#!/usr/bin/env bun
/**
 * Generates the app icons the installers put next to the launcher, all from the UI's logo (web/public/favicon.svg):
 *
 *   assets/icons/harness-dashboard.svg   Linux (hicolor/scalable)
 *   assets/icons/harness-dashboard.icns  macOS (the .app bundle), the tile inset on Apple's icon grid
 *   assets/icons/harness-dashboard.ico   Windows (the Start menu shortcut)
 *
 * They are committed and published with every release. Run again after changing the logo:
 *
 *   bun scripts/icons.ts     (needs rsvg-convert and ImageMagick's magick)
 */
import { $ } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "assets", "icons");
const NAME = "harness-dashboard";
const logo = readFileSync(join(ROOT, "web", "public", "favicon.svg"), "utf8");

mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "hd-icons-"));

try {
  writeFileSync(join(OUT, `${NAME}.svg`), logo);

  // macOS draws icons on a 1024 grid with the tile at 824, so the logo sits inset like the apps around it.
  const inner = logo.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const mac = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><svg x="100" y="100" width="824" height="824" viewBox="0 0 32 32">${inner}</svg></svg>`;
  writeFileSync(join(tmp, "mac.svg"), mac);
  const png = async (src: string, size: number) => {
    const out = join(tmp, `${src}-${size}.png`);
    await $`rsvg-convert -w ${size} -h ${size} -o ${out} ${join(tmp, `${src}.svg`)}`.quiet();
    return readFileSync(out);
  };

  // An .icns is a list of PNGs, each tagged with the size it is for (the @2x ones double the pixels).
  const ICNS: [string, number][] = [
    ["icp4", 16], ["icp5", 32], ["ic11", 32], ["ic12", 64], ["ic07", 128],
    ["ic13", 256], ["ic08", 256], ["ic14", 512], ["ic09", 512], ["ic10", 1024],
  ];
  const chunks: Buffer[] = [];
  for (const [type, size] of ICNS) {
    const data = await png("mac", size);
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    chunks.push(head, data);
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  writeFileSync(join(OUT, `${NAME}.icns`), Buffer.concat([head, body]));

  // Windows shows icons edge to edge, so the .ico uses the tile as it is.
  writeFileSync(join(tmp, "win.svg"), logo);
  const big = join(tmp, "win-256.png");
  await png("win", 256);
  await $`magick ${big} -define icon:auto-resize=256,64,48,32,24,16 ${join(OUT, `${NAME}.ico`)}`.quiet();

  console.log(`icons written to ${OUT}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
