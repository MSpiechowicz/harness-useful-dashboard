import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeProjects, resolveProject, type ProjectEnv } from "../src/core/project.ts";
import { memDb, tempDir } from "./helpers.ts";

/** A fake home inside a temp dir; temp roots are cleared so the fixture itself isn't treated as scratch. */
function fixture(): { home: string; env: ProjectEnv } {
  const home = join(tempDir(), "home");
  mkdirSync(home, { recursive: true });
  return { home, env: { home, temps: [] } };
}

function dir(...parts: string[]): string {
  const p = join(...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

describe("resolveProject", () => {
  test("a session started in a subfolder belongs to the enclosing git repository", () => {
    const { home, env } = fixture();
    const repo = dir(home, "code", "app");
    dir(repo, ".git");
    expect(resolveProject(dir(repo, "web", "src", "pages"), env)).toBe(repo);
    expect(resolveProject(repo, env)).toBe(repo);
  });

  test("a linked worktree maps to its main repository", () => {
    const { home, env } = fixture();
    const repo = dir(home, "code", "app");
    dir(repo, ".git", "worktrees", "feature");
    const wt = dir(repo, ".claude", "worktrees", "feature");
    writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "feature")}\n`);
    expect(resolveProject(join(wt, "src"), env)).toBe(repo);
  });

  test("a submodule stays its own project", () => {
    const { home, env } = fixture();
    const repo = dir(home, "code", "app");
    dir(repo, ".git", "modules", "lib");
    const sub = dir(repo, "vendor", "lib");
    writeFileSync(join(sub, ".git"), "gitdir: ../../.git/modules/lib\n");
    expect(resolveProject(sub, env)).toBe(sub);
  });

  test("folders outside git, and missing folders, are their own project", () => {
    const { home, env } = fixture();
    expect(resolveProject(dir(home, "notes"), env)).toBe(join(home, "notes"));
    expect(resolveProject(join(home, "gone", "sub"), env)).toBe(join(home, "gone", "sub"));
  });

  test("a dotfiles repository in home does not swallow folders below it", () => {
    const { home, env } = fixture();
    dir(home, ".git");
    expect(resolveProject(dir(home, "notes"), env)).toBe(join(home, "notes"));
  });

  test("scratch locations and the bare home directory are not projects", () => {
    const { home, env } = fixture();
    expect(resolveProject(home, env)).toBeNull();
    expect(resolveProject(join(home, "Documents", "Codex", "2026-09-08", "can-you-modify-my-local-machine"), env)).toBeNull();
    expect(resolveProject(join(home, ".config", "Claude", "scratch-workspaces", "a", "b"), env)).toBeNull();
    expect(resolveProject("/tmp/claude-1000/-home-u-proj/abc/scratchpad/mtest", { ...env, temps: ["/tmp"] })).toBeNull();
    // A regular folder under ~/Documents/Codex is still a project.
    expect(resolveProject(join(home, "Documents", "Codex", "my-repo"), env)).toBe(join(home, "Documents", "Codex", "my-repo"));
    expect(resolveProject(null, env)).toBeNull();
  });

  test("labels that aren't paths pass through", () => {
    expect(resolveProject("Cursor", fixture().env)).toBe("Cursor");
  });
});

describe("normalizeProjects", () => {
  test("re-maps stored paths for this host only", () => {
    const db = memDb();
    const rows: [string, string, string][] = [
      ["a", "/r/app/web", "me"],
      ["b", "/r/app", "me"],
      ["c", "/tmp/x", "me"],
      ["d", "/r/app/web", "other-host"],
    ];
    for (const [id, project, host] of rows) {
      db.query("INSERT INTO sessions (id, provider, native_id, project, host) VALUES (?, 'claude', ?, ?, ?)").run(id, id, project, host);
      db.query("INSERT INTO usage (id, provider, session_id, ts, project, host) VALUES (?, 'claude', ?, 0, ?, ?)").run(id, id, project, host);
      db.query("INSERT INTO tool_calls (id, session_id, provider, ts, project, tool) VALUES (?, ?, 'claude', 0, ?, 'Read')").run(id, id, project);
    }
    const map: Record<string, string | null> = { "/r/app/web": "/r/app", "/r/app": "/r/app", "/tmp/x": null };
    expect(normalizeProjects(db, "me", (p) => (p in map ? map[p]! : p))).toBe(2);

    const project = (table: string, id: string) => db.query<{ project: string | null }, [string]>(`SELECT project FROM ${table} WHERE id = ?`).get(id)!.project;
    for (const table of ["usage", "sessions", "tool_calls"]) {
      expect(project(table, "a")).toBe("/r/app");
      expect(project(table, "c")).toBeNull();
      expect(project(table, "d")).toBe("/r/app/web");
    }
  });
});
