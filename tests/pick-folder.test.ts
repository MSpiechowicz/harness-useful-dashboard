import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { App } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { FolderPicker, type PickCommand, PickerBusy, listDirs, nativeAvailable, parsePicked, pickCommand, startFolder } from "../src/server/pickFolder.ts";
import { tempDir } from "./helpers.ts";

const nothing = () => null;
const only = (...names: string[]) => (n: string) => (names.includes(n) ? `/usr/bin/${n}` : null);
const nasty = `x"; rm -rf ~ #$(whoami)'\``;

describe("dialog commands", () => {
  test("macOS passes the title and folder as arguments of osascript, never inside the script", () => {
    const c = pickCommand("darwin", { start: "/Users/me", title: nasty }, nothing)!;
    expect(c.cmd[0]).toBe("osascript");
    expect(c.cmd.slice(-2)).toEqual([nasty, "/Users/me"]);
    expect(c.cmd.slice(0, -2).join("\n")).not.toContain(nasty);
    expect(c.cmd.join("\n")).toContain("item 1 of argv");
    expect(c.cmd.join("\n")).toContain("POSIX path of");
  });
  test("Windows runs PowerShell in STA and hands over the title and folder in the environment", () => {
    const c = pickCommand("win32", { start: "C:\\Users\\me", title: nasty }, nothing)!;
    expect(c.cmd.slice(0, 4)).toEqual(["powershell", "-NoProfile", "-STA", "-Command"]);
    expect(c.cmd[4]).toContain("FolderBrowserDialog");
    expect(c.cmd.join("\n")).not.toContain(nasty);
    expect(c.cmd.join("\n")).not.toContain("C:\\Users");
    expect(c.env).toEqual({ HD_PICK_TITLE: nasty, HD_PICK_START: "C:\\Users\\me" });
  });
  test("Linux prefers zenity, then kdialog, then yad, and has none otherwise", () => {
    const o = { start: "/home/me", title: "Pick" };
    expect(pickCommand("linux", o, only("zenity", "kdialog", "yad"), "GNOME")!.cmd).toEqual(["zenity", "--file-selection", "--directory", "--title=Pick", "--filename=/home/me/"]);
    expect(pickCommand("linux", o, only("kdialog", "yad"), "GNOME")!.cmd).toEqual(["kdialog", "--getexistingdirectory", "/home/me", "--title", "Pick"]);
    expect(pickCommand("linux", o, only("yad"), "GNOME")!.cmd).toEqual(["yad", "--file", "--directory", "--title=Pick", "--filename=/home/me/"]);
    // On KDE its own dialog comes first, when both are installed.
    expect(pickCommand("linux", o, only("zenity", "kdialog"), "KDE")!.cmd[0]).toBe("kdialog");
    expect(pickCommand("linux", o, only("zenity"), "KDE")!.cmd[0]).toBe("zenity");
    expect(pickCommand("linux", o, nothing)).toBeNull();
    expect(pickCommand("linux", o, only("zenity"))!.env).toBeUndefined();
  });
  test("a native dialog needs a display on Linux", () => {
    expect(nativeAvailable("linux", {}, only("zenity"))).toBe(false);
    expect(nativeAvailable("linux", { WAYLAND_DISPLAY: "wayland-0" }, only("zenity"))).toBe(true);
    expect(nativeAvailable("linux", { DISPLAY: ":0" }, nothing)).toBe(false);
    expect(nativeAvailable("darwin", {}, nothing)).toBe(true);
    expect(nativeAvailable("win32", {}, nothing)).toBe(true);
  });
  test("the answer: a folder without its trailing slash, null for a cancel", () => {
    expect(parsePicked(0, "/home/me/Docs/\n")).toBe("/home/me/Docs");
    expect(parsePicked(0, "/home/me/Docs")).toBe("/home/me/Docs");
    expect(parsePicked(0, "/\n")).toBe("/");
    expect(parsePicked(1, "/home/me\n")).toBeNull();
    expect(parsePicked(0, "")).toBeNull();
    expect(parsePicked(0, "relative/dir")).toBeNull();
  });
  test("the dialog opens in the nearest folder that exists", () => {
    const root = tempDir();
    expect(startFolder(root)).toBe(root);
    expect(startFolder(join(root, "gone", "deeper"))).toBe(root);
    expect(startFolder("relative")).toBe(homedir());
    expect(startFolder(undefined)).toBe(homedir());
  });
});

describe("FolderPicker", () => {
  const ok = (stdout: string, code = 0) => async () => ({ code, stdout });
  test("returns the chosen folder, or null when cancelled", async () => {
    const seen: PickCommand[] = [];
    const p = new FolderPicker(async (c) => (seen.push(c), { code: 0, stdout: "/tmp/x/\n" }), "linux", only("zenity"));
    expect(await p.pick(tempDir(), "T")).toBe("/tmp/x");
    expect(seen[0]!.cmd[0]).toBe("zenity");
    expect(await new FolderPicker(ok("", 1), "linux", only("zenity")).pick(undefined, "T")).toBeNull();
  });
  test("is null without a dialog program", async () => {
    expect(await new FolderPicker(ok("/x"), "linux", nothing).pick(undefined, "T")).toBeNull();
  });
  test("a second request while one is open is refused, and the next one works after", async () => {
    let finish!: () => void;
    const p = new FolderPicker(() => new Promise((r) => (finish = () => r({ code: 0, stdout: "/a" }))), "linux", only("zenity"));
    const first = p.pick(undefined, "T");
    await expect(p.pick(undefined, "T")).rejects.toBeInstanceOf(PickerBusy);
    finish();
    expect(await first).toBe("/a");
    const again = p.pick(undefined, "T");
    finish();
    expect(await again).toBe("/a");
  });
});

describe("listDirs", () => {
  const root = tempDir();
  beforeAll(() => {
    for (const d of ["b", "a", "A2", ".hidden", "a/inner"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "file.txt"), "x");
    symlinkSync(join(root, "a"), join(root, "link"));
  });
  test("lists folders only, sorted, hidden ones on request", () => {
    const r = listDirs(root) as Exclude<ReturnType<typeof listDirs>, { error: string }>;
    expect(r.dirs.map((d) => d.name)).toEqual(["a", "A2", "b", "link"]);
    expect(r.dirs[0]!.path).toBe(join(root, "a"));
    expect(r.truncated).toBe(false);
    expect((listDirs(root, true) as { dirs: { name: string }[] }).dirs.map((d) => d.name)).toContain(".hidden");
  });
  test("has the parent, none at the root, and defaults to home", () => {
    expect((listDirs(join(root, "a")) as { parent: string }).parent).toBe(root);
    expect((listDirs("/") as { parent: unknown }).parent).toBeNull();
    expect((listDirs("") as { path: string }).path).toBe(homedir());
  });
  test("normalises the path and refuses what it can't list with a fixed code", () => {
    expect((listDirs(`${root}/a/../b`) as { path: string }).path).toBe(join(root, "b"));
    expect(listDirs("relative/path")).toEqual({ error: "not-absolute" });
    expect(listDirs(join(root, "nope"))).toEqual({ error: "not-found" });
    expect(listDirs(join(root, "file.txt"))).toEqual({ error: "not-a-directory" });
  });
  test("caps the list", () => {
    const big = tempDir();
    for (let i = 0; i < 520; i++) mkdirSync(join(big, `d${String(i).padStart(3, "0")}`));
    const r = listDirs(big) as { dirs: unknown[]; truncated: boolean };
    expect(r.dirs.length).toBe(500);
    expect(r.truncated).toBe(true);
  });
});

describe("routes", () => {
  const token = "a".repeat(64);
  const prevHome = process.env.HARNESS_DASHBOARD_HOME;
  let app: App;
  let handle: (req: Request) => Promise<Response>;
  let result: { code: number; stdout: string } = { code: 0, stdout: "/picked\n" };
  let release: (() => void) | undefined;
  const picker = new FolderPicker(() => (release ? new Promise((r) => (release = () => r(result))) : Promise.resolve(result)), "linux", only("zenity"));

  beforeAll(() => {
    const root = tempDir();
    process.env.HARNESS_DASHBOARD_HOME = join(root, "home");
    mkdirSync(join(root, "home"), { recursive: true });
    writeFileSync(join(root, "home", "config.json"), JSON.stringify({ scanIntervalSec: 0, sources: { enabled: { claude: false, codex: false, omp: false, pi: false, opencode: false, zed: false, cline: false, roo: false, kilo: false } } }));
    app = new App(join(root, "test.db"));
    handle = createHandler(app, { get: async () => null }, { restart() {}, shutdown() {} }, { token, port: 4317 }, picker);
  });
  afterAll(() => {
    app.close();
    process.env.HARNESS_DASHBOARD_HOME = prevHome;
  });

  const auth = { cookie: `hd_auth_4317=${token}` };
  const post = (body: unknown, headers: Record<string, string> = { "x-harness-dashboard": "1", ...auth }) =>
    handle(new Request("http://localhost:4317/api/pick-folder", { method: "POST", headers: { host: "localhost:4317", ...headers }, body: JSON.stringify(body) }));
  const get = (path: string, headers: Record<string, string> = auth) => handle(new Request(`http://localhost:4317${path}`, { headers: { host: "localhost:4317", ...headers } }));

  test("both routes need the sign-in, and the POST the CSRF header", async () => {
    expect((await post({}, { "x-harness-dashboard": "1" })).status).toBe(401);
    expect((await post({}, auth)).status).toBe(403);
    expect((await post({}, { "x-harness-dashboard": "1", "sec-fetch-site": "cross-site", ...auth })).status).toBe(403);
    expect((await get("/api/dirs", {})).status).toBe(401);
    expect((await get("/api/dirs", { ...auth, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get("/api/pick-folder/available", {})).status).toBe(401);
    expect((await get("/api/pick-folder/available")).status).toBe(200);
  });
  test("the dialog's answer, a cancel and a busy dialog", async () => {
    expect(await (await post({ start: "/tmp", title: "x" })).json()).toEqual({ path: "/picked" });
    result = { code: 1, stdout: "" };
    expect(await (await post({})).json()).toEqual({ path: null });
    release = () => {};
    const first = post({});
    await Bun.sleep(10);
    const second = await post({});
    expect(second.status).toBe(409);
    result = { code: 0, stdout: "/late" };
    release();
    expect(await (await first).json()).toEqual({ path: "/late" });
  });
  test("/api/dirs lists, and answers with fixed errors", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "sub"));
    const ok = (await (await get(`/api/dirs?path=${encodeURIComponent(dir)}`)).json()) as { dirs: unknown };
    expect(ok.dirs).toEqual([{ name: "sub", path: join(dir, "sub") }]);
    const rel = await get("/api/dirs?path=a/b");
    expect([rel.status, ((await rel.json()) as { error: string }).error]).toEqual([400, "not-absolute"]);
    const gone = await get(`/api/dirs?path=${encodeURIComponent(join(dir, "gone"))}`);
    expect([gone.status, ((await gone.json()) as { error: string }).error]).toEqual([404, "not-found"]);
  });
});
