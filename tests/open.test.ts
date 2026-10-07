import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appWindowCommand, appWindowId, linkWindowToLauncher, profileInUse } from "../src/server/open.ts";
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

describe("app window command", () => {
  const url = "http://localhost:4317/api/auth?k=abc";
  const flags = [`--app=${url}`, "--user-data-dir=/p", "--no-first-run", "--no-default-browser-check", "--window-size=1440,920"];

  test("Linux and Windows run the browser itself", () => {
    expect(appWindowCommand("/usr/bin/chromium", url, "/p", false, "linux")).toEqual(["/usr/bin/chromium", ...flags]);
    expect(appWindowCommand("/usr/bin/chromium", url, "/p", true, "linux")).toEqual(["/usr/bin/chromium", ...flags]);
  });

  test("macOS starts a new browser through LaunchServices", () => {
    expect(appWindowCommand("/Applications/Google Chrome.app", url, "/p", false, "darwin")).toEqual([
      "open",
      "-n",
      "-a",
      "/Applications/Google Chrome.app",
      "--args",
      ...flags,
    ]);
  });

  test("macOS hands the window to a running browser without LaunchServices, natively", () => {
    expect(appWindowCommand("/Applications/Google Chrome.app", url, "/p", true, "darwin")).toEqual([
      "arch",
      "-arm64",
      "-x86_64",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ...flags,
    ]);
    expect(appWindowCommand("/Applications/Brave Browser.app", url, "/p", true, "darwin")[3]).toBe("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
  });
});

describe("window profile in use", () => {
  test("only while the browser that locked it is alive", () => {
    const profile = tempDir();
    expect(profileInUse(profile)).toBe(false);
    symlinkSync(`host.local-${process.pid}`, join(profile, "SingletonLock"));
    expect(profileInUse(profile)).toBe(true);

    // Left behind by a crash: the process is gone.
    const stale = tempDir();
    const gone = Bun.spawnSync(["true"]).pid;
    symlinkSync(`host.local-${gone}`, join(stale, "SingletonLock"));
    expect(profileInUse(stale)).toBe(false);

    const odd = tempDir();
    symlinkSync("host.local", join(odd, "SingletonLock"));
    expect(profileInUse(odd)).toBe(false);
  });
});
