import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "jsonc-parser";
import { type IngestConfig } from "../src/core/config.ts";
import { App } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { IngestServer } from "../src/server/ingest.ts";
import { IngestAuth } from "../src/server/ingestAuth.ts";
import { connect, disconnect, type FlavorEnv, type FlavorInfo, findFlavors, isSymlinked, OTEL_KEYS, readState, vscodeEndpoint } from "../src/server/vscodeSettings.ts";
import { tempDir } from "./helpers.ts";

const INGEST: IngestConfig = { enabled: true, bind: "127.0.0.1", port: 4319, storeText: false };
const IGNORED = "settingsSync.ignoredSettings";
const TOKEN_PATTERN = /hd_ing_[0-9a-f]{64}/;

/** A temp home with a Code - OSS User folder, a fresh token store and the editor's paths. */
function setup(opts: { settings?: string | null; user?: boolean } = {}) {
  const home = tempDir();
  const env: FlavorEnv = { home, platform: "linux" };
  const auth = new IngestAuth(join(home, "data"));
  const flavor = findFlavors(env).find((f) => f.id === "Code - OSS")!;

  if (opts.user !== false) mkdirSync(flavor.userDir, { recursive: true });
  if (typeof opts.settings === "string") writeFileSync(flavor.settingsPath, opts.settings);

  const installed: FlavorInfo = { ...flavor, installed: opts.user !== false };
  return { home, env, auth, flavor: installed, read: () => readFileSync(flavor.settingsPath, "utf8"), json: () => parse(readFileSync(flavor.settingsPath, "utf8")) as Record<string, unknown> };
}

const backups = (flavor: FlavorInfo) => readdirSync(flavor.userDir).filter((f) => f.startsWith("settings.json.harness-dashboard-") && f.endsWith(".bak"));
const without = (settings: Record<string, unknown>) => {
  const rest = { ...settings };
  for (const key of OTEL_KEYS) delete rest[key];
  delete rest[IGNORED];
  return rest;
};
const bearer = (settings: Record<string, unknown>) => ((settings["github.copilot.chat.otel.headers"] as Record<string, string>).Authorization ?? "").replace("Bearer ", "");

describe("flavors and endpoint", () => {
  test("only the four editors that run Copilot Chat, with per-OS and Flatpak folders", () => {
    const linux = findFlavors({ home: "/h", platform: "linux" });
    expect(linux.map((f) => f.id)).toEqual(["Code", "Code - Insiders", "Code - OSS", "VSCodium"]);
    expect(linux[2]).toEqual({ id: "Code - OSS", userDir: "/h/.config/Code - OSS/User", settingsPath: "/h/.config/Code - OSS/User/settings.json", installed: false });
    expect(findFlavors({ home: "/h", platform: "linux", xdgConfig: "/x" })[0]!.userDir).toBe("/x/Code/User");
    expect(findFlavors({ home: "/h", platform: "darwin" })[0]!.userDir).toBe("/h/Library/Application Support/Code/User");
    expect(findFlavors({ home: "/h", platform: "win32", appData: "/a" })[3]!.userDir).toBe("/a/VSCodium/User");
  });

  test("a Flatpak's User folder is used when only it exists", () => {
    const home = tempDir();
    const flatpak = join(home, ".var", "app", "com.vscodium.codium", "config", "VSCodium", "User");
    mkdirSync(flatpak, { recursive: true });

    const found = findFlavors({ home, platform: "linux" }).find((f) => f.id === "VSCodium")!;
    expect(found).toMatchObject({ userDir: flatpak, installed: true });
    expect(findFlavors({ home, platform: "linux" }).find((f) => f.id === "Code")!.installed).toBe(false);
  });

  test("the address follows the bind: 127.0.0.1 or [::1], none for a specific other address", () => {
    const at = (bind: string) => vscodeEndpoint({ bind, port: 4400 });
    for (const bind of ["127.0.0.1", "127.1.2.3", "localhost", "0.0.0.0"]) expect(at(bind)).toBe("http://127.0.0.1:4400");
    for (const bind of ["::", "::1"]) expect(at(bind)).toBe("http://[::1]:4400");
    for (const bind of ["192.168.1.5", "10.0.0.1", "fe80::1"]) expect(at(bind)).toBeNull();
  });
});

describe("connect", () => {
  test("a missing settings.json is created with the six settings and the ignore list", () => {
    const t = setup();
    expect(connect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });

    const settings = t.json();
    expect(settings).toMatchObject({
      "github.copilot.chat.otel.enabled": true,
      "github.copilot.chat.otel.exporterType": "otlp-http",
      "github.copilot.chat.otel.otlpEndpoint": "http://127.0.0.1:4319",
      "github.copilot.chat.otel.captureContent": false,
      "github.copilot.chat.otel.maxAttributeSizeChars": 64,
    });
    expect(bearer(settings)).toMatch(TOKEN_PATTERN);
    expect(settings[IGNORED]).toEqual([...OTEL_KEYS]);
    expect(t.auth.findToken(bearer(settings))).toMatchObject({ purpose: "vscode", flavor: "Code - OSS", label: "VS Code (Code - OSS)" });
    expect(backups(t.flavor)).toEqual([]);
    expect(readState(t.flavor, t.auth, INGEST)).toBe("connected");
  });

  test("an empty object and an empty file both get the settings", () => {
    for (const start of ["{}", "", "  \n"]) {
      const t = setup({ settings: start });
      expect(connect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });
      expect(t.json()["github.copilot.chat.otel.enabled"]).toBe(true);
    }
  });

  test("not-installed when the User folder is missing, and nothing is made", () => {
    const t = setup({ user: false });
    expect(connect(t.flavor, t.auth, INGEST)).toEqual({ error: "not-installed" });
    expect(existsSync(t.flavor.userDir)).toBe(false);
    expect(t.auth.vscodeTokens()).toEqual([]);
    expect(readState(t.flavor, t.auth, INGEST)).toBe("not-installed");
  });

  test("a specific non-loopback bind is refused", () => {
    const t = setup({ settings: "{}" });
    expect(connect(t.flavor, t.auth, { ...INGEST, bind: "192.168.1.5" })).toEqual({ error: "not-local-bind" });
    expect(t.read()).toBe("{}");
    expect(t.auth.vscodeTokens()).toEqual([]);
  });

  test("comments, trailing commas and unrelated settings stay", () => {
    const original = `// my settings
{
    "editor.fontSize": 14, // big
    /* theme */
    "workbench.colorTheme": "Dark",
    "github.copilot.chat.otel.dbPath": "/somewhere",
    "files.exclude": { "**/.git": true,   "**/.svn":true, },
    "terminal.integrated.env": {
        "A": "1",
    },
}
`;
    const t = setup({ settings: original });
    expect(connect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });

    const text = t.read();
    expect(text).toContain("// my settings");
    expect(text).toContain("// big");
    expect(text).toContain("/* theme */");
    expect(text).toContain(`"files.exclude": { "**/.git": true,   "**/.svn":true, },`);
    expect(text).toContain(`"editor.fontSize": 14,`);
    expect(without(t.json())).toEqual(parse(original, [], { allowTrailingComma: true }));
  });

  test("tabs and CRLF are kept", () => {
    const tabs = setup({ settings: '{\n\t"editor.fontSize": 14\n}\n' });
    connect(tabs.flavor, tabs.auth, INGEST);
    expect(tabs.read()).toContain('\n\t"github.copilot.chat.otel.enabled": true');
    expect(tabs.read()).not.toMatch(/\n {2,}"/);

    const crlf = setup({ settings: '{\r\n  "editor.fontSize": 14\r\n}\r\n' });
    connect(crlf.flavor, crlf.auth, INGEST);
    expect(crlf.read()).toContain('\r\n  "github.copilot.chat.otel.enabled": true');
    expect(crlf.read().replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("existing ignoredSettings entries stay and ours are added once", () => {
    const t = setup({ settings: JSON.stringify({ [IGNORED]: ["editor.fontSize", "github.copilot.chat.otel.enabled"], "editor.fontSize": 14 }) });
    expect(connect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });
    expect(connect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });

    const ignored = t.json()[IGNORED] as string[];
    expect(ignored.slice(0, 2)).toEqual(["editor.fontSize", "github.copilot.chat.otel.enabled"]);
    expect([...ignored].sort()).toEqual(["editor.fontSize", ...OTEL_KEYS].sort());
    expect(new Set(ignored).size).toBe(ignored.length);
  });

  test("a foreign enabled endpoint is refused until overwrite", () => {
    const original = JSON.stringify({ "github.copilot.chat.otel.enabled": true, "github.copilot.chat.otel.otlpEndpoint": "http://collector.example:4318", "editor.fontSize": 14 }, null, 2);
    const t = setup({ settings: original });

    expect(readState(t.flavor, t.auth, INGEST)).toBe("other-endpoint");
    expect(connect(t.flavor, t.auth, INGEST)).toEqual({ error: "other-endpoint" });
    expect(t.read()).toBe(original);
    expect(t.auth.vscodeTokens()).toEqual([]);
    expect(backups(t.flavor)).toEqual([]);

    expect(connect(t.flavor, t.auth, INGEST, { overwrite: true })).toEqual({ ok: true });
    expect(t.json()["github.copilot.chat.otel.otlpEndpoint"]).toBe("http://127.0.0.1:4319");
    expect(t.json()["editor.fontSize"]).toBe(14);
    expect(backups(t.flavor)).toHaveLength(1);
  });

  test("a disabled foreign endpoint is not in the way", () => {
    const t = setup({ settings: JSON.stringify({ "github.copilot.chat.otel.enabled": false, "github.copilot.chat.otel.otlpEndpoint": "http://collector.example:4318" }) });
    expect(readState(t.flavor, t.auth, INGEST)).toBe("off");
    expect(connect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });
  });

  test("an unparsable or non-object file is refused and left byte-identical", () => {
    for (const bad of ['{ "a": ', "[1, 2]", '"text"', "{ 'a': 1 }", '{ "a": 1 } trailing']) {
      const t = setup({ settings: bad });
      expect(readState(t.flavor, t.auth, INGEST)).toBe("unparsable");
      expect(connect(t.flavor, t.auth, INGEST, { overwrite: true })).toEqual({ error: "unparsable" });
      expect(disconnect(t.flavor, t.auth, INGEST)).toEqual({ error: "unparsable" });
      expect(t.read()).toBe(bad);
      expect(t.auth.vscodeTokens()).toEqual([]);
      expect(backups(t.flavor)).toEqual([]);
    }
  });

  test("a symlinked settings.json is refused without confirmation, then followed and kept a symlink", () => {
    const t = setup();
    const dotfiles = join(t.home, "dotfiles");
    mkdirSync(dotfiles);
    writeFileSync(join(dotfiles, "settings.json"), '{ "editor.fontSize": 14 }');
    symlinkSync(join(dotfiles, "settings.json"), t.flavor.settingsPath);

    expect(isSymlinked(t.flavor.settingsPath)).toBe(true);
    expect(connect(t.flavor, t.auth, INGEST)).toEqual({ error: "symlinked" });
    expect(readFileSync(join(dotfiles, "settings.json"), "utf8")).toBe('{ "editor.fontSize": 14 }');
    expect(t.auth.vscodeTokens()).toEqual([]);

    expect(connect(t.flavor, t.auth, INGEST, { confirmSymlink: true })).toEqual({ ok: true });
    expect(lstatSync(t.flavor.settingsPath).isSymbolicLink()).toBe(true);
    expect(parse(readFileSync(join(dotfiles, "settings.json"), "utf8"))["github.copilot.chat.otel.enabled"]).toBe(true);
    expect(readState(t.flavor, t.auth, INGEST)).toBe("connected");

    // The backup is next to the link, the temp file went into the target's folder and is gone.
    expect(backups(t.flavor)).toHaveLength(1);
    expect(readdirSync(dotfiles).filter((f) => f.endsWith(".bak"))).toEqual([]);
    expect(readdirSync(dotfiles)).toEqual(["settings.json"]);
  });

  test("a symlink to nowhere is refused", () => {
    const t = setup();
    symlinkSync(join(t.home, "nowhere.json"), t.flavor.settingsPath);

    expect(readState(t.flavor, t.auth, INGEST)).toBe("unparsable");
    expect(connect(t.flavor, t.auth, INGEST, { confirmSymlink: true })).toEqual({ error: "unparsable" });
    expect(t.auth.vscodeTokens()).toEqual([]);
    expect(existsSync(join(t.home, "nowhere.json"))).toBe(false);
  });

  test("duplicate settings are refused: the editor would read one and an edit would change the other", () => {
    const dupIgnored = '{\n  "settingsSync.ignoredSettings": ["a"],\n  "editor.fontSize": 14,\n  "settingsSync.ignoredSettings": ["b"]\n}\n';
    const dupEndpoint = '{\n  "github.copilot.chat.otel.enabled": true,\n  "github.copilot.chat.otel.otlpEndpoint": "http://collector.example:4318",\n  "github.copilot.chat.otel.otlpEndpoint": "http://other.example:4318"\n}\n';

    for (const original of [dupIgnored, dupEndpoint]) {
      const t = setup({ settings: original });
      expect(readState(t.flavor, t.auth, INGEST)).toBe("unparsable");
      expect(connect(t.flavor, t.auth, INGEST, { overwrite: true })).toEqual({ error: "duplicate-keys" });
      expect(disconnect(t.flavor, t.auth, INGEST)).toEqual({ error: "duplicate-keys" });
      expect(t.read()).toBe(original);
      expect(t.auth.vscodeTokens()).toEqual([]);
      expect(backups(t.flavor)).toEqual([]);
    }

    // A repeated key that isn't ours is the user's business.
    const other = setup({ settings: '{ "a": 1, "a": 2 }' });
    expect(connect(other.flavor, other.auth, INGEST)).toEqual({ ok: true });
  });

  test("a symlinked User folder or editor folder needs confirmation too", () => {
    const user = setup({ user: false });
    const dotfiles = join(user.home, "dotfiles", "User");
    mkdirSync(dotfiles, { recursive: true });
    writeFileSync(join(dotfiles, "settings.json"), '{ "editor.fontSize": 14 }');
    mkdirSync(dirname(user.flavor.userDir), { recursive: true });
    symlinkSync(dotfiles, user.flavor.userDir);

    const linked = { ...user.flavor, installed: true };
    expect(isSymlinked(linked.settingsPath)).toBe(true);
    expect(connect(linked, user.auth, INGEST)).toEqual({ error: "symlinked" });
    expect(readFileSync(join(dotfiles, "settings.json"), "utf8")).toBe('{ "editor.fontSize": 14 }');
    expect(connect(linked, user.auth, INGEST, { confirmSymlink: true })).toEqual({ ok: true });
    expect(parse(readFileSync(join(dotfiles, "settings.json"), "utf8"))["github.copilot.chat.otel.enabled"]).toBe(true);
    // The backup is named after the lexical path, so it lands in the same folder here.
    expect(readdirSync(dotfiles).filter((f) => f.endsWith(".bak"))).toHaveLength(1);

    const folder = setup({ user: false });
    const stowed = join(folder.home, "dotfiles", "Code - OSS");
    mkdirSync(join(stowed, "User"), { recursive: true });
    mkdirSync(dirname(dirname(folder.flavor.userDir)), { recursive: true });
    symlinkSync(stowed, dirname(folder.flavor.userDir));
    expect(isSymlinked(folder.flavor.settingsPath)).toBe(true);

    const missing = setup({ user: false });
    mkdirSync(join(missing.home, "dotfiles", "User"), { recursive: true });
    mkdirSync(dirname(missing.flavor.userDir), { recursive: true });
    symlinkSync(join(missing.home, "dotfiles", "User"), missing.flavor.userDir);
    expect(isSymlinked(missing.flavor.settingsPath)).toBe(true);
    expect(connect({ ...missing.flavor, installed: true }, missing.auth, INGEST)).toEqual({ error: "symlinked" });

    expect(isSymlinked(setup({ settings: "{}" }).flavor.settingsPath)).toBe(false);
  });

  test("any value under a dotted prefix of our settings, or a key below one, is refused", () => {
    const forms = [
      '{ "github": { "copilot": { "chat": { "otel": { "enabled": true } } } } }',
      '{ "github.copilot": { "chat.otel.enabled": true } }',
      '{ "github.copilot.chat": { "otel.otlpEndpoint": "http://collector.example:4318" } }',
      '{ "github.copilot.chat.otel": { "enabled": true } }',
      '{ "settingsSync": { "ignoredSettings": [] } }',
      '{ "github.copilot": 1 }',
      '{ "github": "x" }',
      '{ "settingsSync": null }',
      '{ "github.copilot.chat.otel.headers.Authorization": "Bearer x" }',
      '{ "github.copilot.chat.otel.enabled.x": true }',
      '{ "settingsSync.ignoredSettings.0": "x" }',
      '{ "__proto__": { "github.copilot.chat.otel.enabled": true } }',
    ];
    for (const original of forms) {
      const t = setup({ settings: original });
      expect(readState(t.flavor, t.auth, INGEST)).toBe("unparsable");
      expect(connect(t.flavor, t.auth, INGEST, { overwrite: true })).toEqual({ error: "duplicate-keys" });
      expect(disconnect(t.flavor, t.auth, INGEST)).toEqual({ error: "duplicate-keys" });
      expect(t.read()).toBe(original);
      expect(t.auth.vscodeTokens()).toEqual([]);
    }

    // Other settings under the same names, and language overrides, are none of our business.
    for (const fine of ['{ "github.copilot.enable": { "*": true } }', '{ "[python]": { "editor.tabSize": 4 } }', '{ "github.copilot.chat.otel.dbPath": "/x", "settingsSync.ignoredExtensions": [] }']) {
      const t = setup({ settings: fine });
      expect(connect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });
    }
  });

  test("a file nested deeper than the parser goes is unusable, not an error", () => {
    const deep = `${"[".repeat(200_000)}${"]".repeat(200_000)}`;
    for (const original of [deep, `{ "a": ${deep} }`]) {
      const t = setup({ settings: original });
      expect(readState(t.flavor, t.auth, INGEST)).toBe("unparsable");
      expect(connect(t.flavor, t.auth, INGEST, { overwrite: true })).toEqual({ error: "unparsable" });
      expect(disconnect(t.flavor, t.auth, INGEST)).toEqual({ error: "unparsable" });
      expect(t.read()).toBe(original);
      expect(t.auth.vscodeTokens()).toEqual([]);
    }
  });

  test("backup rotation counts only its own names and none newer than the new backup", () => {
    const t = setup({ settings: "{}" });
    const dir = t.flavor.userDir;
    const stamp = 1_800_000_000_000;
    const name = (n: number) => `settings.json.harness-dashboard-${n}.bak`;

    // Four older real backups, planted names that don't match the pattern, and names stamped in the future.
    for (const n of [stamp - 4, stamp - 3, stamp - 2, stamp - 1]) writeFileSync(join(dir, name(n)), "old");
    const planted = [name(stamp + 10_000), name(stamp + 20_000), "settings.json.harness-dashboard-zzzz.bak", `settings.json.harness-dashboard-${stamp - 5}.bak.extra`, "settings.json.harness-dashboard-1.bak"];
    for (const f of planted) writeFileSync(join(dir, f), "planted");

    const now = spyOn(Date, "now").mockReturnValue(stamp);
    try {
      expect(connect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });
    } finally {
      now.mockRestore();
    }

    const left = readdirSync(dir).filter((f) => f.includes("harness-dashboard"));
    expect(left).toContain(name(stamp));
    for (const f of planted) expect(left).toContain(f);
    // Of the real ones (the four older and the new), only the newest three remain.
    expect(left.filter((f) => /^settings\.json\.harness-dashboard-\d{13}\.bak$/.test(f) && Number(f.match(/\d{13}/)![0]) <= stamp).sort()).toEqual([name(stamp - 2), name(stamp - 1), name(stamp)]);
  });

  test("a symlinked User folder without a settings.json gets one once confirmed", () => {
    const t = setup({ user: false });
    const real = join(t.home, "dotfiles", "User");
    mkdirSync(real, { recursive: true });
    mkdirSync(dirname(t.flavor.userDir), { recursive: true });
    symlinkSync(real, t.flavor.userDir);
    const flavor = { ...t.flavor, installed: true };

    expect(readState(flavor, t.auth, INGEST)).toBe("off");
    expect(connect(flavor, t.auth, INGEST)).toEqual({ error: "symlinked" });
    expect(connect(flavor, t.auth, INGEST, { confirmSymlink: true })).toEqual({ ok: true });
    expect(parse(readFileSync(join(real, "settings.json"), "utf8"))["github.copilot.chat.otel.enabled"]).toBe(true);
    expect(readState(flavor, t.auth, INGEST)).toBe("connected");
  });

  test("an own '__proto__' setting is no setting", () => {
    const t = setup({ settings: '{ "__proto__": { "github.copilot.chat.otel.enabled": true } }' });
    expect(readState(t.flavor, t.auth, INGEST)).toBe("unparsable");
    expect(disconnect(t.flavor, t.auth, INGEST)).toEqual({ error: "duplicate-keys" });
  });

  test("a broken token store neither masks the error nor fails a write that was made", () => {
    const t = setup({ settings: "{}" });
    connect(t.flavor, t.auth, INGEST);
    const broken = (over: Partial<typeof t.auth>) => ({ addToken: t.auth.addToken.bind(t.auth), findToken: t.auth.findToken.bind(t.auth), vscodeTokens: t.auth.vscodeTokens.bind(t.auth), revokeToken: t.auth.revokeToken.bind(t.auth), ...over });
    const throwing = () => {
      throw new Error("unreadable");
    };

    // The write is made, the old token can't be revoked: still a success.
    expect(connect(t.flavor, broken({ revokeToken: throwing }), INGEST)).toEqual({ ok: true });
    expect(disconnect(t.flavor, broken({ revokeToken: throwing }), INGEST)).toEqual({ ok: true });
    expect(t.json()).toEqual({});

    // The write fails and the new token can't be revoked: the write error is what is reported.
    writeFileSync(t.flavor.settingsPath, "[1]");
    let revoked = 0;
    const counting = broken({
      revokeToken: () => {
        revoked++;
        throw new Error("unreadable");
      },
    });
    expect(connect(t.flavor, counting, INGEST)).toEqual({ error: "unparsable" });
    expect(revoked).toBe(0);

    // A store that fails entirely is a write-failed, not a throw.
    writeFileSync(t.flavor.settingsPath, "{}");
    expect(connect(t.flavor, broken({ findToken: throwing, addToken: throwing }), INGEST)).toEqual({ error: "write-failed" });
    expect(t.read()).toBe("{}");
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("the new token is attempted to be revoked when the write fails", () => {
    const t = setup({ settings: "{}" });
    let revoked = 0;
    const auth = {
      addToken: t.auth.addToken.bind(t.auth),
      findToken: t.auth.findToken.bind(t.auth),
      vscodeTokens: t.auth.vscodeTokens.bind(t.auth),
      revokeToken: () => {
        revoked++;
        throw new Error("unreadable");
      },
    };

    chmodSync(t.flavor.userDir, 0o500);
    try {
      expect(connect(t.flavor, auth, INGEST)).toEqual({ error: "write-failed" });
    } finally {
      chmodSync(t.flavor.userDir, 0o700);
    }
    expect(revoked).toBe(1);
  });

  test("a directory with a backup's name can't block the write or be removed", () => {
    const t = setup({ settings: "{}" });
    const dir = t.flavor.userDir;
    const stamp = 1_800_000_000_000;
    const name = (n: number) => `settings.json.harness-dashboard-${n}.bak`;

    mkdirSync(join(dir, name(stamp - 10)));
    writeFileSync(join(dir, name(stamp - 10), "inside"), "x");
    for (const n of [stamp - 4, stamp - 3, stamp - 2, stamp - 1]) writeFileSync(join(dir, name(n)), "old");

    const now = spyOn(Date, "now").mockReturnValue(stamp);
    try {
      expect(connect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });
    } finally {
      now.mockRestore();
    }

    expect(lstatSync(join(dir, name(stamp - 10))).isDirectory()).toBe(true);
    expect(existsSync(join(dir, name(stamp)))).toBe(true);
    expect(existsSync(join(dir, name(stamp - 4)))).toBe(false);
    expect(existsSync(join(dir, name(stamp - 3)))).toBe(false);
  });

  test("a file that became a symlink while connecting is refused, and the token revoked", () => {
    const t = setup({ settings: '{ "editor.fontSize": 14 }' });
    const elsewhere = join(t.home, "elsewhere.json");
    writeFileSync(elsewhere, "{}");

    // Right after the token is made, settings.json is swapped for a link.
    const swapping = {
      addToken: (...args: Parameters<typeof t.auth.addToken>) => {
        const made = t.auth.addToken(...args);
        rmSync(t.flavor.settingsPath);
        symlinkSync(elsewhere, t.flavor.settingsPath);
        return made;
      },
      findToken: t.auth.findToken.bind(t.auth),
      vscodeTokens: t.auth.vscodeTokens.bind(t.auth),
      revokeToken: t.auth.revokeToken.bind(t.auth),
    };

    expect(connect(t.flavor, swapping, INGEST)).toEqual({ error: "symlinked" });
    expect(readFileSync(elsewhere, "utf8")).toBe("{}");
    expect(t.auth.vscodeTokens()).toEqual([]);
  });

  test("a FIFO, a directory and an oversized file are not read", () => {
    const fifo = setup();
    if (process.platform !== "win32") {
      expect(spawnSync("mkfifo", [fifo.flavor.settingsPath]).status).toBe(0);
      expect(readState(fifo.flavor, fifo.auth, INGEST)).toBe("unparsable");
      expect(connect(fifo.flavor, fifo.auth, INGEST)).toEqual({ error: "unparsable" });
      expect(fifo.auth.vscodeTokens()).toEqual([]);
    }

    const dir = setup();
    mkdirSync(dir.flavor.settingsPath);
    expect(readState(dir.flavor, dir.auth, INGEST)).toBe("unparsable");
    expect(connect(dir.flavor, dir.auth, INGEST)).toEqual({ error: "unparsable" });

    const big = setup();
    const text = `{ "padding": "${"x".repeat(17 * 1024 * 1024)}" }`;
    writeFileSync(big.flavor.settingsPath, text);
    expect(readState(big.flavor, big.auth, INGEST)).toBe("unparsable");
    expect(connect(big.flavor, big.auth, INGEST)).toEqual({ error: "unparsable" });
    expect(disconnect(big.flavor, big.auth, INGEST)).toEqual({ error: "unparsable" });
    expect(big.auth.vscodeTokens()).toEqual([]);
    expect(readFileSync(big.flavor.settingsPath, "utf8")).toBe(text);
  });

  test("a backup name that something planted is skipped, never followed", () => {
    const t = setup({ settings: '{ "editor.fontSize": 14 }' });
    const victim = join(t.home, "victim.txt");
    writeFileSync(victim, "precious");
    const stamp = 1_800_000_000_000;
    symlinkSync(victim, join(t.flavor.userDir, `settings.json.harness-dashboard-${stamp}.bak`));
    symlinkSync(join(t.home, "not-there"), join(t.flavor.userDir, `settings.json.harness-dashboard-${stamp + 1}.bak`));

    const now = spyOn(Date, "now").mockReturnValue(stamp);
    try {
      expect(connect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });
    } finally {
      now.mockRestore();
    }

    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(existsSync(join(t.home, "not-there"))).toBe(false);

    const made = join(t.flavor.userDir, `settings.json.harness-dashboard-${stamp + 2}.bak`);
    expect(lstatSync(made).isFile()).toBe(true);
    expect(readFileSync(made, "utf8")).toBe('{ "editor.fontSize": 14 }');
  });

  test("a backup of the original is made and only the newest three are kept", () => {
    const original = '{ "editor.fontSize": 14 }';
    const t = setup({ settings: original });
    connect(t.flavor, t.auth, INGEST);

    const [first] = backups(t.flavor);
    expect(readFileSync(join(t.flavor.userDir, first!), "utf8")).toBe(original);

    for (let i = 0; i < 5; i++) connect(t.flavor, t.auth, INGEST);
    const kept = backups(t.flavor);
    expect(kept).toHaveLength(3);
    expect(kept).not.toContain(first!);
  });

  test.skipIf(process.platform === "win32")("settings.json and its backups are owner-only", () => {
    const t = setup({ settings: "{}" });
    chmodSync(t.flavor.settingsPath, 0o644);
    connect(t.flavor, t.auth, INGEST);

    expect(lstatSync(t.flavor.settingsPath).mode & 0o777).toBe(0o600);
    for (const file of backups(t.flavor)) expect(lstatSync(join(t.flavor.userDir, file)).mode & 0o777).toBe(0o600);
    expect(readdirSync(t.flavor.userDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("reconnecting rotates the token: the old one is revoked and gone from the file", () => {
    const t = setup({ settings: "{}" });
    connect(t.flavor, t.auth, INGEST);
    const old = bearer(t.json());

    connect(t.flavor, t.auth, INGEST);
    const fresh = bearer(t.json());

    expect(fresh).not.toBe(old);
    expect(t.auth.findToken(old)).toBeNull();
    expect(t.auth.findToken(fresh)?.purpose).toBe("vscode");
    expect(t.auth.vscodeTokens()).toHaveLength(1);
  });

  test("another editor's token is not rotated", () => {
    const a = setup({ settings: "{}" });
    const other = a.auth.addToken("VS Code (Code)", { purpose: "vscode", flavor: "Code" });
    if ("error" in other) throw new Error(other.error);

    connect(a.flavor, a.auth, INGEST);
    expect(a.auth.findToken(other.token)).not.toBeNull();
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a failed write revokes the new token and leaves the file and the old token", () => {
    const t = setup({ settings: "{}" });
    connect(t.flavor, t.auth, INGEST);
    const before = t.read();
    const old = bearer(t.json());

    // No temp file can be made in a folder that isn't writable.
    chmodSync(t.flavor.userDir, 0o500);
    try {
      expect(connect(t.flavor, t.auth, INGEST)).toEqual({ error: "write-failed" });
    } finally {
      chmodSync(t.flavor.userDir, 0o700);
    }

    expect(t.read()).toBe(before);
    expect(t.auth.vscodeTokens().map((x) => x.id)).toEqual([t.auth.findToken(old)!.id]);
    expect(readState(t.flavor, t.auth, INGEST)).toBe("connected");
  });
});

describe("readState", () => {
  test("off for a missing file, empty settings and a disabled export", () => {
    expect(readState(setup().flavor, setup().auth, INGEST)).toBe("off");
    const t = setup({ settings: "{}" });
    expect(readState(t.flavor, t.auth, INGEST)).toBe("off");
    writeFileSync(t.flavor.settingsPath, '{ "github.copilot.chat.otel.enabled": false }');
    expect(readState(t.flavor, t.auth, INGEST)).toBe("off");
  });

  test("connected, then stale once the token is revoked", () => {
    const t = setup({ settings: "{}" });
    connect(t.flavor, t.auth, INGEST);
    expect(readState(t.flavor, t.auth, INGEST)).toBe("connected");

    t.auth.revokeToken(t.auth.vscodeTokens()[0]!.id);
    expect(readState(t.flavor, t.auth, INGEST)).toBe("stale");
  });

  test("stale when the port changed, and connect fixes it", () => {
    const t = setup({ settings: "{}" });
    connect(t.flavor, t.auth, INGEST);

    const moved = { ...INGEST, port: 4400 };
    expect(readState(t.flavor, t.auth, moved)).toBe("stale");
    expect(connect(t.flavor, t.auth, moved)).toEqual({ ok: true });
    expect(readState(t.flavor, t.auth, moved)).toBe("connected");
  });

  test("a moved port with a revoked token is stale, and connect replaces it without overwrite", () => {
    const t = setup({ settings: "{}" });
    connect(t.flavor, t.auth, INGEST);
    t.auth.revokeToken(t.auth.vscodeTokens()[0]!.id);

    const moved = { ...INGEST, port: 4400 };
    expect(readState(t.flavor, t.auth, moved)).toBe("stale");
    expect(connect(t.flavor, t.auth, moved)).toEqual({ ok: true });
    expect(t.json()["github.copilot.chat.otel.otlpEndpoint"]).toBe("http://127.0.0.1:4400");
    expect(readState(t.flavor, t.auth, moved)).toBe("connected");
  });

  test("a hand-kept loopback config with a token of our format is stale on either loopback address", () => {
    const stale = (endpoint: string) =>
      JSON.stringify({ "github.copilot.chat.otel.enabled": true, "github.copilot.chat.otel.otlpEndpoint": endpoint, "github.copilot.chat.otel.headers": { Authorization: `Bearer hd_ing_${"ab".repeat(32)}` } });
    for (const endpoint of ["http://127.0.0.1:4000", "http://[::1]:4000"]) {
      const t = setup({ settings: stale(endpoint) });
      expect(readState(t.flavor, t.auth, INGEST)).toBe("stale");
      expect(connect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });
      expect(readState(t.flavor, t.auth, INGEST)).toBe("connected");
    }

    // Not our token format: another program's loopback collector.
    const foreign = setup({ settings: JSON.stringify({ "github.copilot.chat.otel.enabled": true, "github.copilot.chat.otel.otlpEndpoint": "http://127.0.0.1:4000", "github.copilot.chat.otel.headers": { Authorization: "Bearer abc" } }) });
    expect(readState(foreign.flavor, foreign.auth, INGEST)).toBe("other-endpoint");
  });

  test("a token that isn't a vscode token does not count", () => {
    const plain = setup();
    const made = plain.auth.addToken("ci");
    if ("error" in made) throw new Error(made.error);
    writeFileSync(
      plain.flavor.settingsPath,
      JSON.stringify({ "github.copilot.chat.otel.enabled": true, "github.copilot.chat.otel.otlpEndpoint": "http://127.0.0.1:4319", "github.copilot.chat.otel.headers": { authorization: `Bearer ${made.token}` } }),
    );
    expect(readState(plain.flavor, plain.auth, INGEST)).toBe("stale");
  });

  test("enabled without an endpoint is another endpoint", () => {
    const t = setup({ settings: '{ "github.copilot.chat.otel.enabled": true }' });
    expect(readState(t.flavor, t.auth, INGEST)).toBe("other-endpoint");
  });
});

describe("disconnect", () => {
  test("removes only our settings and ignore entries, and revokes the editor's tokens", () => {
    const original = '{\n  // keep\n  "editor.fontSize": 14,\n  "github.copilot.chat.otel.dbPath": "/x",\n  "settingsSync.ignoredSettings": ["editor.fontSize"]\n}\n';
    const t = setup({ settings: original });
    const other = t.auth.addToken("VS Code (Code)", { purpose: "vscode", flavor: "Code" });
    if ("error" in other) throw new Error(other.error);

    connect(t.flavor, t.auth, INGEST);
    const token = bearer(t.json());
    expect(disconnect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });

    const after = t.json();
    for (const key of OTEL_KEYS) expect(after).not.toHaveProperty(key);
    expect(after).toEqual(parse(original));
    expect(t.read()).toContain("// keep");
    expect(t.auth.findToken(token)).toBeNull();
    expect(t.auth.findToken(other.token)).not.toBeNull();
    expect(readState(t.flavor, t.auth, INGEST)).toBe("off");
  });

  test("an ignore list that only held ours is removed, other settings stay", () => {
    const t = setup({ settings: '{ "editor.fontSize": 14 }' });
    connect(t.flavor, t.auth, INGEST);
    disconnect(t.flavor, t.auth, INGEST);
    expect(t.json()).toEqual({ "editor.fontSize": 14 });
  });

  test("a stale connection is taken out too", () => {
    const t = setup({ settings: "{}" });
    connect(t.flavor, t.auth, INGEST);
    t.auth.revokeToken(t.auth.vscodeTokens()[0]!.id);

    expect(disconnect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });
    expect(t.json()).toEqual({});
  });

  test("a foreign endpoint is refused and left alone", () => {
    const original = JSON.stringify({ "github.copilot.chat.otel.enabled": true, "github.copilot.chat.otel.otlpEndpoint": "http://collector.example:4318" });
    const t = setup({ settings: original });
    expect(disconnect(t.flavor, t.auth, INGEST)).toEqual({ error: "other-endpoint" });
    expect(t.read()).toBe(original);
  });

  test("a connection left over from a moved port and a revoked token is taken out", () => {
    const t = setup({ settings: "{}" });
    connect(t.flavor, t.auth, INGEST);
    t.auth.revokeToken(t.auth.vscodeTokens()[0]!.id);

    expect(disconnect(t.flavor, t.auth, { ...INGEST, port: 4400 })).toEqual({ ok: true });
    expect(t.json()).toEqual({});
  });

  test("with nothing of ours in the file, no token is revoked", () => {
    const t = setup({ settings: '{ "editor.fontSize": 14 }' });
    const made = t.auth.addToken("VS Code (Code - OSS)", { purpose: "vscode", flavor: "Code - OSS" });
    if ("error" in made) throw new Error(made.error);

    expect(disconnect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });
    expect(t.auth.findToken(made.token)).not.toBeNull();

    const foreign = setup({ settings: JSON.stringify({ "github.copilot.chat.otel.enabled": true, "github.copilot.chat.otel.otlpEndpoint": "http://collector.example:4318" }) });
    const other = foreign.auth.addToken("VS Code (Code - OSS)", { purpose: "vscode", flavor: "Code - OSS" });
    if ("error" in other) throw new Error(other.error);
    expect(disconnect(foreign.flavor, foreign.auth, INGEST)).toEqual({ error: "other-endpoint" });
    expect(foreign.auth.findToken(other.token)).not.toBeNull();
  });

  test("settings that were never ours are left alone", () => {
    const original = '{ "github.copilot.chat.otel.captureContent": true }';
    const t = setup({ settings: original });
    expect(disconnect(t.flavor, t.auth, INGEST)).toEqual({ ok: true });
    expect(t.read()).toBe(original);
    expect(backups(t.flavor)).toEqual([]);

    const none = setup();
    expect(disconnect(none.flavor, none.auth, INGEST)).toEqual({ ok: true });
    expect(existsSync(none.flavor.settingsPath)).toBe(false);
  });
});

describe("Connect VS Code API", () => {
  const dashboardToken = "d".repeat(64);
  let root: string;
  let app: App;
  let auth: IngestAuth;
  let env: FlavorEnv;
  let userDir: string;
  let settingsPath: string;
  let handle: (req: Request) => Promise<Response>;
  const prevHome = process.env.HARNESS_DASHBOARD_HOME;
  const prevEnv = Object.fromEntries(["OTEL_EXPORTER_OTLP_ENDPOINT", "COPILOT_OTEL_ENABLED", "COPILOT_OTEL_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS"].map((k) => [k, process.env[k]]));
  const responses: string[] = [];
  const logs: string[] = [];
  const spies: ReturnType<typeof spyOn>[] = [];

  beforeAll(() => {
    for (const k of Object.keys(prevEnv)) delete process.env[k];
    root = tempDir();
    const home = join(root, "harness-home");
    mkdirSync(home, { recursive: true });
    process.env.HARNESS_DASHBOARD_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ scanIntervalSec: 0 }));

    app = new App(join(root, "test.db"));
    auth = new IngestAuth(home);
    env = { home: join(root, "user-home"), platform: "linux" };
    userDir = findFlavors(env).find((f) => f.id === "Code")!.userDir;
    settingsPath = join(userDir, "settings.json");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(settingsPath, '{ "editor.fontSize": 14 }');

    const ingest = new IngestServer({ app, auth });
    handle = createHandler(app, { get: async () => null }, { shutdown() {}, ingest, vscodeEnv: env }, { token: dashboardToken, port: 4317 });
    for (const method of ["log", "warn", "error", "info"] as const) spies.push(spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))));
  });

  afterAll(() => {
    for (const spy of spies) spy.mockRestore();
    app.close();
    process.env.HARNESS_DASHBOARD_HOME = prevHome;
    for (const [k, v] of Object.entries(prevEnv)) if (v !== undefined) process.env[k] = v;
  });

  const call = async (method: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handle(
      new Request("http://localhost:4317/api/ingest/vscode", {
        method,
        headers: { host: "localhost:4317", cookie: `hd_auth_4317=${dashboardToken}`, "x-harness-dashboard": "1", "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    responses.push(text);
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  };

  test("GET lists the flavors, the collector and the environment override", async () => {
    const { status, body } = await call("GET");
    expect(status).toBe(200);
    expect(body).toEqual({
      flavors: [
        { id: "Code", installed: true, state: "off", symlinked: false },
        { id: "Code - Insiders", installed: false, state: "not-installed", symlinked: false },
        { id: "Code - OSS", installed: false, state: "not-installed", symlinked: false },
        { id: "VSCodium", installed: false, state: "not-installed", symlinked: false },
      ],
      collector: { enabled: false, state: "off", port: 4319, loopback: true },
      lastVscodeAt: null,
      envOverride: false,
    });

    process.env.COPILOT_OTEL_ENABLED = "true";
    expect(((await call("GET")).body as { envOverride: boolean }).envOverride).toBe(true);
    delete process.env.COPILOT_OTEL_ENABLED;
  });

  test("POST with the collector off is a 409 and changes nothing", async () => {
    const { status, body } = await call("POST", { flavor: "Code" });
    expect(status).toBe(409);
    expect(body).toEqual({ error: "collector-off" });
    expect(app.cfg.ingest.enabled).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe('{ "editor.fontSize": 14 }');
    expect(auth.vscodeTokens()).toEqual([]);
  });

  test("POST with enableCollector turns the collector on and connects, without showing the token", async () => {
    const { status, body } = await call("POST", { flavor: "Code", enableCollector: true });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, collector: { enabled: true } });
    expect((body.flavors as { id: string; installed: boolean; state: string; symlinked: boolean }[]).find((f) => f.id === "Code")).toEqual({ id: "Code", installed: true, state: "connected", symlinked: false });
    expect(app.cfg.ingest.enabled).toBe(true);

    const written = parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(written["github.copilot.chat.otel.otlpEndpoint"]).toBe(`http://127.0.0.1:${app.cfg.ingest.port}`);
    expect((written["github.copilot.chat.otel.headers"] as Record<string, string>).Authorization).toMatch(/^Bearer hd_ing_/);
  });

  test("POST again connects with the collector already on", async () => {
    const before = auth.vscodeTokens()[0]!.id;
    const { status } = await call("POST", { flavor: "Code" });
    expect(status).toBe(200);
    expect(auth.vscodeTokens()).toHaveLength(1);
    expect(auth.vscodeTokens()[0]!.id).not.toBe(before);
  });

  test("errors are { error: code }", async () => {
    expect(await call("POST", { flavor: "Cursor" })).toEqual({ status: 400, body: { error: "unknown-flavor" } });
    expect(await call("POST", {})).toEqual({ status: 400, body: { error: "unknown-flavor" } });
    expect(await call("POST", { flavor: "VSCodium" })).toEqual({ status: 404, body: { error: "not-installed" } });
    expect(await call("DELETE", { flavor: "../etc" })).toEqual({ status: 400, body: { error: "unknown-flavor" } });
    expect(await call("DELETE", { flavor: "Code - OSS" })).toEqual({ status: 404, body: { error: "not-installed" } });
  });

  test("a foreign endpoint is a 409 until overwrite", async () => {
    const foreign = JSON.stringify({ "github.copilot.chat.otel.enabled": true, "github.copilot.chat.otel.otlpEndpoint": "http://collector.example:4318" });
    writeFileSync(settingsPath, foreign);

    expect(await call("POST", { flavor: "Code" })).toEqual({ status: 409, body: { error: "other-endpoint" } });
    expect(readFileSync(settingsPath, "utf8")).toBe(foreign);
    expect((await call("DELETE", { flavor: "Code" })).body).toEqual({ error: "other-endpoint" });

    expect((await call("POST", { flavor: "Code", overwrite: true })).status).toBe(200);
  });

  test("a symlinked settings.json needs confirmSymlink, and GET says so", async () => {
    const real = join(root, "dotfiles-settings.json");
    const saved = readFileSync(settingsPath, "utf8");
    writeFileSync(real, saved);
    rmSync(settingsPath);
    symlinkSync(real, settingsPath);

    const listed = (await call("GET")).body.flavors as { id: string; symlinked: boolean }[];
    expect(listed.find((f) => f.id === "Code")?.symlinked).toBe(true);

    app.updateConfig({ ingest: { enabled: false } });
    expect(await call("POST", { flavor: "Code", enableCollector: true })).toEqual({ status: 409, body: { error: "symlinked" } });
    expect(app.cfg.ingest.enabled).toBe(false);
    expect(readFileSync(real, "utf8")).toBe(saved);

    expect((await call("POST", { flavor: "Code", enableCollector: true, confirmSymlink: true })).status).toBe(200);
    expect(parse(readFileSync(real, "utf8"))["github.copilot.chat.otel.enabled"]).toBe(true);
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);

    rmSync(settingsPath);
    writeFileSync(settingsPath, saved);
  });

  test("a symlinked User folder is a 409 symlinked too", async () => {
    const real = `${userDir}-real`;
    renameSync(userDir, real);
    symlinkSync(real, userDir);
    try {
      const listed = (await call("GET")).body.flavors as { id: string; symlinked: boolean }[];
      expect(listed.find((f) => f.id === "Code")?.symlinked).toBe(true);
      expect(await call("POST", { flavor: "Code", enableCollector: true })).toEqual({ status: 409, body: { error: "symlinked" } });
      expect(readFileSync(join(real, "settings.json"), "utf8")).toBe(readFileSync(settingsPath, "utf8"));
    } finally {
      rmSync(userDir);
      renameSync(real, userDir);
    }
  });

  test("duplicate settings are a 400", async () => {
    const dup = '{ "settingsSync.ignoredSettings": [], "settingsSync.ignoredSettings": [] }';
    writeFileSync(settingsPath, dup);
    expect(await call("POST", { flavor: "Code", overwrite: true })).toEqual({ status: 400, body: { error: "duplicate-keys" } });
    expect(readFileSync(settingsPath, "utf8")).toBe(dup);
    writeFileSync(settingsPath, "{}");
  });

  test("GET says whether the collector is bound to loopback only", async () => {
    app.updateConfig({ ingest: { bind: "0.0.0.0" } });
    expect(((await call("GET")).body.collector as { loopback: boolean }).loopback).toBe(false);
    app.updateConfig({ ingest: { bind: "127.0.0.1" } });
    expect(((await call("GET")).body.collector as { loopback: boolean }).loopback).toBe(true);
  });

  test("an unparsable file is refused", async () => {
    writeFileSync(settingsPath, "{ nope");
    expect(await call("POST", { flavor: "Code" })).toEqual({ status: 400, body: { error: "unparsable" } });
    expect(readFileSync(settingsPath, "utf8")).toBe("{ nope");
    writeFileSync(settingsPath, "{}");
  });

  test("GET never fails because of one editor's file", async () => {
    const deep = `{ "a": ${"[".repeat(200_000)}${"]".repeat(200_000)} }`;
    writeFileSync(settingsPath, deep);

    const { status, body } = await call("GET");
    expect(status).toBe(200);
    expect((body.flavors as { id: string; state: string }[]).find((f) => f.id === "Code")?.state).toBe("unparsable");
    writeFileSync(settingsPath, "{}");
  });

  test("a specific non-loopback bind is refused before anything changes", async () => {
    app.updateConfig({ ingest: { bind: "192.168.1.5" } });
    const tokens = auth.vscodeTokens().length;

    expect(await call("POST", { flavor: "Code" })).toEqual({ status: 400, body: { error: "not-local-bind" } });
    expect(auth.vscodeTokens()).toHaveLength(tokens);
    app.updateConfig({ ingest: { bind: "127.0.0.1" } });
  });

  test("a refused connect puts the collector back off", async () => {
    app.updateConfig({ ingest: { enabled: false } });
    writeFileSync(settingsPath, "[]");

    expect((await call("POST", { flavor: "Code", enableCollector: true })).body).toEqual({ error: "unparsable" });
    expect(app.cfg.ingest.enabled).toBe(false);
    writeFileSync(settingsPath, "{}");
  });

  test("DELETE disconnects", async () => {
    expect((await call("POST", { flavor: "Code", enableCollector: true })).status).toBe(200);

    const { status, body } = await call("DELETE", { flavor: "Code" });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect((body.flavors as { id: string; state: string }[]).find((f) => f.id === "Code")?.state).toBe("off");
    expect(parse(readFileSync(settingsPath, "utf8"))).toEqual({});
    expect(auth.vscodeTokens()).toEqual([]);
  });

  test("the usual guards apply", async () => {
    expect((await call("GET", undefined, { cookie: "" })).status).toBe(401);
    expect((await call("POST", { flavor: "Code" }, { "x-harness-dashboard": "" })).status).toBe(403);
    expect((await call("GET", undefined, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await call("PUT", { flavor: "Code" })).status).toBe(404);
  });

  test("no response and no log ever holds a token", () => {
    expect(responses.length).toBeGreaterThan(5);
    for (const text of responses) expect(text).not.toMatch(TOKEN_PATTERN);
    for (const line of logs) expect(line).not.toMatch(TOKEN_PATTERN);
  });
});
