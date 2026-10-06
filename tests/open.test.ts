import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appWindowId, linkWindowToLauncher } from "../src/server/open.ts";
import { tempDir } from "./helpers.ts";

describe("app window on Linux", () => {
  test("the app ID each browser gives an --app window", () => {
    expect(appWindowId("/usr/bin/google-chrome-stable", "http://localhost:4317")).toBe("chrome-localhost__-Default");
    expect(appWindowId("/usr/bin/chromium", "http://localhost:4317")).toBe("chromium-localhost__-Default");
    expect(appWindowId("/usr/bin/microsoft-edge-stable", "http://localhost:4317")).toBe("msedge-localhost__-Default");
  });

  test.if(process.platform === "linux")("a hidden launcher under that ID gives the window the app's icon", () => {
    const data = tempDir();
    const apps = join(data, "applications");
    // Not installed through the installer: nothing is added.
    expect(linkWindowToLauncher("/usr/bin/google-chrome-stable", "http://localhost:4317", data)).toBe(false);

    mkdirSync(apps, { recursive: true });
    writeFileSync(join(apps, "harness-dashboard.desktop"), "[Desktop Entry]\nName=Harness Dashboard\nExec=/home/u/.local/bin/harness-dashboard\nIcon=harness-dashboard\n");
    expect(linkWindowToLauncher("/usr/bin/google-chrome-stable", "http://localhost:4317", data)).toBe(true);
    const alias = readFileSync(join(apps, "chrome-localhost__-Default.desktop"), "utf8");
    expect(alias).toContain("Icon=harness-dashboard");
    expect(alias).toContain("NoDisplay=true");
    expect(alias).toContain("Exec=/home/u/.local/bin/harness-dashboard");
    // Already there: left alone.
    expect(linkWindowToLauncher("/usr/bin/google-chrome-stable", "http://localhost:4317", data)).toBe(false);
    expect(existsSync(join(apps, "harness-dashboard.desktop"))).toBe(true);
  });
});
