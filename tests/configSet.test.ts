import { describe, expect, test } from "bun:test";
import { configKeyPatch, defaultConfig, mergeConfig } from "../src/core/config.ts";

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
});
