import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dbFileFor, dbTarget, findSyncFolders } from "../src/core/syncFolders.ts";
import { tempDir } from "./helpers.ts";

const home = () => tempDir();

describe("findSyncFolders", () => {
  test("finds the folders sync clients keep on macOS", () => {
    const h = home();
    mkdirSync(join(h, "Library", "Mobile Documents", "com~apple~CloudDocs"), { recursive: true });
    mkdirSync(join(h, "Library", "CloudStorage", "OneDrive-Personal"), { recursive: true });
    mkdirSync(join(h, "Library", "CloudStorage", "GoogleDrive-me@example.com", "My Drive"), { recursive: true });
    mkdirSync(join(h, "Library", "CloudStorage", "GoogleDrive-me@example.com", "Shared drives"), { recursive: true });
    const found = findSyncFolders({ home: h, platform: "darwin", env: {} });
    expect(found).toEqual([
      { name: "iCloud Drive", path: join(h, "Library", "Mobile Documents", "com~apple~CloudDocs") },
      { name: "OneDrive", path: join(h, "Library", "CloudStorage", "OneDrive-Personal") },
      { name: "Google Drive", path: join(h, "Library", "CloudStorage", "GoogleDrive-me@example.com", "My Drive") },
    ]);
  });

  test("reads Dropbox's own record of its folders and lists each folder once", () => {
    const h = home();
    const business = join(h, "Dropbox (Acme)");
    mkdirSync(join(h, "Dropbox"));
    mkdirSync(business);
    mkdirSync(join(h, ".dropbox"));
    writeFileSync(join(h, ".dropbox", "info.json"), JSON.stringify({ personal: { path: join(h, "Dropbox") }, business: { path: business } }));
    expect(findSyncFolders({ home: h, platform: "linux", env: {} })).toEqual([
      { name: "Dropbox", path: join(h, "Dropbox") },
      { name: "Dropbox", path: business },
    ]);
  });

  test("finds nothing on a machine without sync clients", () => {
    expect(findSyncFolders({ home: home(), platform: "linux", env: {} })).toEqual([]);
  });
});

describe("dbTarget", () => {
  test("a folder holds usage.db, a .db path is the file itself", () => {
    expect(dbFileFor("/sync/Harness Dashboard")).toBe(join("/sync/Harness Dashboard", "usage.db"));
    expect(dbFileFor("/sync/team.db")).toBe("/sync/team.db");
    expect(dbFileFor("  ")).toBe("");
  });

  test("says what saving would do", () => {
    const h = home();
    mkdirSync(join(h, "shared"));
    writeFileSync(join(h, "shared", "usage.db"), "");
    const current = join(h, "local", "usage.db");
    expect(dbTarget("", current, current).state).toBe("current");
    expect(dbTarget("", current, join(h, "default.db")).state).toBe("default");
    expect(dbTarget(join(h, "shared"), current, current)).toEqual({ file: join(h, "shared", "usage.db"), state: "existing" });
    // The folder itself may be new, its parent must be there.
    expect(dbTarget(join(h, "Harness Dashboard"), current, current).state).toBe("new");
    expect(dbTarget(join(h, "nope", "Harness Dashboard"), current, current).state).toBe("missing");
    expect(dbTarget("relative/folder", current, current).state).toBe("invalid");
  });
});
