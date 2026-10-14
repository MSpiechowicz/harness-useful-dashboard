import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configKeyPatch, defaultConfig, loadConfig, mergeConfig, updateConfig } from "../src/core/config.ts";
import { tempDir } from "./helpers.ts";

describe("config set", () => {
  test("a dotted key sets a field inside its section", () => {
    const cfg = defaultConfig();
    const next = mergeConfig(cfg, configKeyPatch(cfg, "budgets.daily", 40));
    expect(next.budgets.daily).toBe(40);
    expect(next.budgets.notify).toBe(cfg.budgets.notify);
    expect("budgets.daily" in next).toBe(false);
  });

  test("turning metrics on makes its token", () => {
    const cfg = defaultConfig();
    const next = mergeConfig(cfg, configKeyPatch(cfg, "metrics.enabled", true));
    expect(next.metrics.enabled).toBe(true);
    expect(next.metrics.token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a top-level key is set as before", () => {
    const cfg = defaultConfig();
    expect(configKeyPatch(cfg, "port", 4400)).toEqual({ port: 4400 });
  });

  test("an unknown key is refused", () => {
    const cfg = defaultConfig();
    expect(() => configKeyPatch(cfg, "nope", 1)).toThrow("unknown config key");
    expect(() => configKeyPatch(cfg, "port.x", 1)).toThrow("has no fields");
    expect(() => configKeyPatch(cfg, "sources.enabled.claude.x", 1)).toThrow("unknown config key");
  });

  test("the config passed in is left as it was", () => {
    const cfg = defaultConfig();
    configKeyPatch(cfg, "limits.claude", false);
    expect(cfg.limits.claude).toBe(true);
  });

  test("the listener's fields are checked like Settings checks them", () => {
    const cfg = defaultConfig();
    expect(mergeConfig(cfg, configKeyPatch(cfg, "ingest.port", 4400)).ingest).toEqual({ enabled: false, bind: "127.0.0.1", port: 4400, storeText: false });
    expect(configKeyPatch(cfg, "ingest.bind", "::").ingest?.bind).toBe("::");
    expect(configKeyPatch(cfg, "ingest", { enabled: true }).ingest).toEqual({ ...cfg.ingest, enabled: true });

    expect(() => configKeyPatch(cfg, "ingest.port", 80)).toThrow("invalid value for ingest.port");
    expect(() => configKeyPatch(cfg, "ingest.port", cfg.port)).toThrow("invalid value for ingest.port");
    expect(() => configKeyPatch(cfg, "ingest.bind", "my-host")).toThrow("invalid value for ingest.bind");
    expect(() => configKeyPatch(cfg, "ingest.enabled", "yes")).toThrow("invalid value for ingest.enabled");
    expect(() => configKeyPatch(cfg, "ingest.token", "x")).toThrow("unknown config key");
    expect(() => configKeyPatch(cfg, "ingest.toString", "x")).toThrow("unknown config key");
    expect(() => configKeyPatch(cfg, "ingest.port.x", 1)).toThrow("unknown config key");
  });

  test("a hand-edited listener section falls back to the defaults for what is wrong", () => {
    const path = join(tempDir(), "config.json");
    writeFileSync(path, JSON.stringify({ ingest: { enabled: true, bind: "not an address", port: 22, storeText: "yes" } }));
    expect(loadConfig(path).ingest).toEqual({ enabled: true, bind: "127.0.0.1", port: 4319, storeText: false });
    writeFileSync(path, JSON.stringify({ ingest: "on" }));
    expect(loadConfig(path).ingest).toEqual(defaultConfig().ingest);
  });

  test("the window setting of older versions is dropped from the config file", () => {
    const path = join(tempDir(), "config.json");
    writeFileSync(path, JSON.stringify({ openMode: "browser", port: 4400 }));
    expect("openMode" in loadConfig(path)).toBe(false);
    expect(loadConfig(path).port).toBe(4400);
    updateConfig({ userName: "ada" }, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("openMode");
    expect(() => configKeyPatch(defaultConfig(), "openMode", "app")).toThrow("unknown config key");
  });
});
