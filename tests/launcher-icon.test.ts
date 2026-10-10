import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { launcherIconTarget, refreshLauncherIcon } from "../src/server/launcherIcon.ts";
import { tempDir } from "./helpers.ts";

describe("launcher icon after an update", () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    test(`${platform}: the installed icon is replaced with the binary's when they differ`, () => {
      const root = tempDir();
      const env = { platform, home: join(root, "home"), dataHome: join(root, "data"), binDir: join(root, "bin") };
      const target = launcherIconTarget(env)!;
      // Not installed through the installer: nothing is added.
      expect(refreshLauncherIcon(env)).toBe(false);
      expect(existsSync(target.path)).toBe(false);

      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, "old icon");
      expect(refreshLauncherIcon(env)).toBe(true);
      expect(readFileSync(target.path).equals(readFileSync(target.source))).toBe(true);
      // Already current: left alone.
      expect(refreshLauncherIcon(env)).toBe(false);
    });
  }
});
