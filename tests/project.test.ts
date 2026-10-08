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

  test("re-maps rolled-up outcomes, compactions and git events, and a commit moves to the key a rescan gives it", () => {
    const db = memDb();
    const rows: [string, string, string][] = [
      ["a", "/r/app/web", "me"],
      ["c", "/tmp/x", "me"],
      ["d", "/r/app/web", "other-host"],
    ];
    for (const [id, project, host] of rows) {
      db.query("INSERT INTO sessions (id, provider, native_id, project, host) VALUES (?, 'claude', ?, ?, ?)").run(id, id, project, host);
      db.query("INSERT INTO outcome_days (ts, host, provider, session_id, project, n) VALUES (0, ?, 'claude', ?, ?, 2)").run(host, id, project);
      db.query("INSERT INTO compactions (id, provider, session_id, ts, project, host) VALUES (?, 'claude', ?, 0, ?, ?)").run(id, id, project, host);
    }
    const git = db.query("INSERT INTO git_events (id, kind, provider, session_id, ts, project, host, sha) VALUES (?, ?, 'claude', 'a', ?, ?, ?, ?)");
    git.run("commit:/r/app/web:1111111", "commit", 5, "/r/app/web", "me", "1111111");
    git.run("commit:/r/app/web:2222222", "commit", 5, "/r/app/web", "me", "2222222");
    git.run("commit:/r/app:2222222", "commit", 9, "/r/app", "me", "2222222"); // the same commit, read again since
    git.run("commit:/tmp/x:3333333", "commit", 5, "/tmp/x", "me", "3333333");
    git.run("commit:call-1", "commit", 5, "/r/app/web", "me", null);
    git.run("pr:github.com/acme/app#4", "pr", 5, "/r/app/web", "me", null);
    git.run("commit:/r/app/web:4444444", "commit", 5, "/r/app/web", "other-host", "4444444");
    const map: Record<string, string | null> = { "/r/app/web": "/r/app", "/tmp/x": null };
    normalizeProjects(db, "me", (p) => (p in map ? map[p]! : p));

    const project = (table: string, where: string) =>
      db.query<{ project: string | null }, []>(`SELECT project FROM ${table} WHERE ${where}`).get()!.project;
    for (const [table, key] of [["outcome_days", "session_id"], ["compactions", "id"]]) {
      expect(project(table, `${key} = 'a'`)).toBe("/r/app");
      expect(project(table, `${key} = 'c'`)).toBeNull();
      expect(project(table, `${key} = 'd'`)).toBe("/r/app/web");
    }
    const events = db.query<{ id: string; project: string | null }, []>("SELECT id, project FROM git_events ORDER BY id").all();
    expect(events).toEqual([
      { id: "commit:/r/app/web:4444444", project: "/r/app/web" },
      { id: "commit:/r/app:1111111", project: "/r/app" },
      { id: "commit:/r/app:2222222", project: "/r/app" },
      { id: "commit::3333333", project: null },
      { id: "commit:call-1", project: "/r/app" },
      { id: "pr:github.com/acme/app#4", project: "/r/app" },
    ]);
  });
});
