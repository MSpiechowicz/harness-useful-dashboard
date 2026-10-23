import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_FILE, IngestAuth, IngestAuthBusy, IngestAuthUnreadable, MAX_TOKENS, type VerifyPassword } from "../src/server/ingestAuth.ts";
import { tempDir } from "./helpers.ts";

const bearer = (token: string) => `Bearer ${token}`;
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const HOUR = 3_600_000;

describe("ingest tokens", () => {
  test("a new token is returned once and lets its sender in under its label", async () => {
    const dir = tempDir();
    const auth = new IngestAuth(dir);
    const made = auth.addToken("  build box  ");
    if ("error" in made) throw new Error(made.error);

    expect(made.token).toMatch(/^hd_ing_[0-9a-f]{64}$/);
    expect(made.item).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), label: "build box", prefix: made.token.slice(0, 11), createdAt: expect.any(Number), lastUsedAt: null });
    expect(made.item).not.toHaveProperty("hash");
    expect(await auth.authenticate(bearer(made.token))).toEqual({ kind: "token", label: "build box", key: `t${made.item.id}` });
    expect(await auth.authenticate(`bearer   ${made.token}`)).toEqual({ kind: "token", label: "build box", key: `t${made.item.id}` });
  });

  test("a token's purpose and flavor are kept in the file, listed, and carried by its credential", async () => {
    const dir = tempDir();
    const auth = new IngestAuth(dir);
    const made = auth.addToken("VS Code (Code - Insiders)", { purpose: "vscode", flavor: "Code - Insiders" });
    const plain = auth.addToken("ci");
    if ("error" in made || "error" in plain) throw new Error("token");

    expect(made.item).toMatchObject({ purpose: "vscode", flavor: "Code - Insiders" });
    expect(Object.keys(plain.item).sort()).toEqual(["createdAt", "id", "label", "lastUsedAt", "prefix"]);

    // A new instance reads the same file.
    const again = new IngestAuth(dir);
    expect(again.vscodeTokens().map((t) => t.id)).toEqual([made.item.id]);
    expect(await again.authenticate(bearer(made.token))).toEqual({ kind: "token", label: "VS Code (Code - Insiders)", key: `t${made.item.id}`, purpose: "vscode", flavor: "Code - Insiders" });
    expect(await again.authenticate(bearer(plain.token))).toEqual({ kind: "token", label: "ci", key: `t${plain.item.id}` });
    expect(JSON.stringify(again.tokens())).not.toMatch(/hash|[0-9a-f]{64}/);
  });

  test("a vscode token is found by its plaintext without counting as a use, and revoked by id", async () => {
    const auth = new IngestAuth(tempDir());
    const made = auth.addToken("VS Code (Code)", { purpose: "vscode", flavor: "Code" });
    if ("error" in made) throw new Error(made.error);

    expect(auth.findToken(made.token)).toMatchObject({ id: made.item.id, purpose: "vscode", flavor: "Code" });
    expect(auth.findToken(`hd_ing_${"0".repeat(64)}`)).toBeNull();
    expect(auth.findToken("nonsense")).toBeNull();
    expect(auth.tokens()[0]!.lastUsedAt).toBeNull();

    expect(auth.revokeToken(made.item.id)).toBe(true);
    expect(auth.findToken(made.token)).toBeNull();
    expect(auth.vscodeTokens()).toEqual([]);
    expect(await auth.authenticate(bearer(made.token))).toBeNull();
  });

  test("an invalid purpose or flavor makes no token", () => {
    const auth = new IngestAuth(tempDir());
    expect(auth.addToken("x", { purpose: "other" as "vscode" })).toEqual({ error: "invalid value for purpose" });
    expect(auth.addToken("x", { purpose: "vscode", flavor: "  " })).toEqual({ error: "invalid value for flavor" });
    expect(auth.tokens()).toEqual([]);
  });

  test("a file written before purposes existed still loads, and its tokens have none", async () => {
    const dir = tempDir();
    const token = `hd_ing_${"ab".repeat(32)}`;
    const hash = new Bun.CryptoHasher("sha256").update(token).digest("hex");
    writeFileSync(join(dir, AUTH_FILE), JSON.stringify({ tokens: [{ id: "0123456789abcdef", label: "old", hash, prefix: token.slice(0, 11), createdAt: 1, lastUsedAt: null }], basic: null }));

    const auth = new IngestAuth(dir);
    expect(auth.tokens()).toEqual([{ id: "0123456789abcdef", label: "old", prefix: token.slice(0, 11), createdAt: 1, lastUsedAt: null }]);
    expect(await auth.authenticate(bearer(token))).toEqual({ kind: "token", label: "old", key: "t0123456789abcdef" });
    expect(auth.vscodeTokens()).toEqual([]);
  });

  test("the file keeps only hashes and is private to this account", () => {
    const dir = tempDir();
    const auth = new IngestAuth(dir);
    const made = auth.addToken("ci");
    if ("error" in made) throw new Error(made.error);

    const file = readFileSync(join(dir, AUTH_FILE), "utf8");
    expect(file).not.toContain(made.token);
    expect(file).not.toContain(made.token.slice(7));
    if (process.platform !== "win32") expect(statSync(join(dir, AUTH_FILE)).mode & 0o777).toBe(0o600);
    expect(auth.tokens()).toEqual([made.item]);
    expect(JSON.stringify(auth.tokens())).not.toContain("hash");
  });

  test("a wrong, malformed or missing token lets nobody in", async () => {
    const auth = new IngestAuth(tempDir());
    auth.addToken("ci");
    for (const header of [null, "", bearer(`hd_ing_${"0".repeat(64)}`), bearer("hd_ing_short"), bearer("x".repeat(70)), "Token abc", basic("ci", "whatever-password")]) {
      expect(await auth.authenticate(header), String(header)).toBeNull();
    }
  });

  test("a revoked token is refused at once", async () => {
    const auth = new IngestAuth(tempDir());
    const made = auth.addToken("ci");
    if ("error" in made) throw new Error(made.error);

    expect(auth.revokeToken(made.item.id)).toBe(true);
    expect(await auth.authenticate(bearer(made.token))).toBeNull();
    expect(auth.revokeToken(made.item.id)).toBe(false);
    expect(auth.tokens()).toEqual([]);
  });

  test("a change another process makes to the file is picked up on the next request", async () => {
    const dir = tempDir();
    const server = new IngestAuth(dir);
    const cli = new IngestAuth(dir);
    expect(server.tokens()).toEqual([]);

    const made = cli.addToken("laptop");
    if ("error" in made) throw new Error(made.error);
    expect(await server.authenticate(bearer(made.token))).toEqual({ kind: "token", label: "laptop", key: `t${made.item.id}` });

    new IngestAuth(dir).revokeToken(made.item.id);
    expect(await server.authenticate(bearer(made.token))).toBeNull();
  });

  test("labels are 1 to 100 characters without control characters, and there are at most 100 tokens", () => {
    const auth = new IngestAuth(tempDir());
    for (const label of ["", "   ", "a\nb", "tab\there", "x".repeat(101), 5, null]) {
      expect(auth.addToken(label), JSON.stringify(label)).toEqual({ error: "invalid value for label" });
    }
    expect("token" in auth.addToken("x".repeat(100))).toBe(true);

    for (let i = 1; i < MAX_TOKENS; i++) auth.addToken(`t${i}`);
    expect(auth.tokens()).toHaveLength(MAX_TOKENS);
    expect(auth.addToken("one more")).toEqual({ error: `at most ${MAX_TOKENS} tokens` });
  });

  test("the last use is shown at once and written to the file at most hourly", async () => {
    const dir = tempDir();
    let now = 1_000_000;
    const auth = new IngestAuth(dir, () => now);
    const made = auth.addToken("ci");
    if ("error" in made) throw new Error(made.error);
    const onDisk = () => new IngestAuth(dir).tokens()[0]!.lastUsedAt;

    await auth.authenticate(bearer(made.token));
    expect(auth.tokens()[0]!.lastUsedAt).toBe(now);
    expect(onDisk()).toBe(now);

    const first = now;
    now += 60_000;
    await auth.authenticate(bearer(made.token));
    expect(auth.tokens()[0]!.lastUsedAt).toBe(now);
    expect(onDisk()).toBe(first);

    now += HOUR;
    await auth.authenticate(bearer(made.token));
    expect(onDisk()).toBe(now);
  });

  test("a broken file lets nobody in", async () => {
    const dir = tempDir();
    const auth = new IngestAuth(dir);
    const made = auth.addToken("ci");
    if ("error" in made) throw new Error(made.error);

    writeFileSync(join(dir, AUTH_FILE), "{ not json");
    expect(await auth.authenticate(bearer(made.token))).toBeNull();
    expect(auth.tokens()).toEqual([]);
  });

  test("a broken file is never written over: every change is refused until it is repaired or deleted", async () => {
    const dir = tempDir();
    const file = join(dir, AUTH_FILE);
    const auth = new IngestAuth(dir);
    const made = auth.addToken("ci");
    if ("error" in made) throw new Error(made.error);
    const broken = readFileSync(file, "utf8").slice(0, -20);
    writeFileSync(file, broken);

    expect(auth.readError()).toBeTruthy();
    expect(() => auth.addToken("another")).toThrow(IngestAuthUnreadable);
    expect(() => auth.revokeToken(made.item.id)).toThrow(IngestAuthUnreadable);
    expect(() => auth.clearBasic()).toThrow(IngestAuthUnreadable);
    await expect(auth.setBasic("hermes", "a long enough password")).rejects.toBeInstanceOf(IngestAuthUnreadable);
    expect(readFileSync(file, "utf8")).toBe(broken);

    for (const json of ["null", "[]", '"tokens"']) {
      writeFileSync(file, json);
      expect(() => auth.addToken("x"), json).toThrow(IngestAuthUnreadable);
    }

    rmSync(file);
    expect(auth.readError()).toBeNull();
    expect("token" in auth.addToken("fresh")).toBe(true);
  });

  test("names lose invisible characters and take one Unicode form", () => {
    const auth = new IngestAuth(tempDir());
    const made = auth.addToken("\u200bbuild\u200d   box\ufeff");
    expect("item" in made && made.item.label).toBe("build box");
    const wide = auth.addToken("\uff43\uff49");
    expect("item" in wide && wide.item.label).toBe("ci");
    expect(auth.addToken("a\u2028b")).toEqual({ error: "invalid value for label" });
    expect(auth.addToken("\u200b\u200b")).toEqual({ error: "invalid value for label" });
  });

  test("a name of megabytes is refused at once, before it is normalized", async () => {
    const auth = new IngestAuth(tempDir());
    // U+FDFA is one character that NFKC makes eighteen.
    const huge = "\ufdfa".repeat(5_000_000);
    const started = performance.now();
    expect(auth.addToken(huge)).toEqual({ error: "invalid value for label" });
    expect(await auth.setBasic(huge, "a long enough password")).toEqual({ error: "invalid value for user" });
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("ingest basic auth", () => {
  const PASSWORD = "correct horse battery";

  test("the user and password let a sender in under the user's name, nothing else does", async () => {
    const dir = tempDir();
    const auth = new IngestAuth(dir);
    expect(await auth.setBasic(" hermes ", PASSWORD)).toEqual({ user: "hermes" });
    expect(auth.basic()).toEqual({ user: "hermes" });
    expect(readFileSync(join(dir, AUTH_FILE), "utf8")).not.toContain(PASSWORD);

    expect(await auth.authenticate(basic("hermes", PASSWORD))).toEqual({ kind: "basic", label: "hermes", key: "b:hermes" });
    // A second time comes from the cache of verified headers: the same answer.
    expect(await auth.authenticate(basic("hermes", PASSWORD))).toEqual({ kind: "basic", label: "hermes", key: "b:hermes" });
    expect(await auth.authenticate(basic("hermes", "wrong password!"))).toBeNull();
    expect(await auth.authenticate(basic("other", PASSWORD))).toBeNull();
    expect(await auth.authenticate("Basic !!!")).toBeNull();
    expect(await auth.authenticate(`Basic ${Buffer.from("no colon").toString("base64")}`)).toBeNull();
  });

  test("a new password or clearing it takes effect at once, also for a header that passed before", async () => {
    const auth = new IngestAuth(tempDir());
    await auth.setBasic("hermes", PASSWORD);
    expect(await auth.authenticate(basic("hermes", PASSWORD))).not.toBeNull();

    await auth.setBasic("hermes", "another long password");
    expect(await auth.authenticate(basic("hermes", PASSWORD))).toBeNull();
    expect(await auth.authenticate(basic("hermes", "another long password"))).not.toBeNull();

    auth.clearBasic();
    expect(auth.basic()).toBeNull();
    expect(await auth.authenticate(basic("hermes", "another long password"))).toBeNull();
  });

  test("a header that passed is kept when the file changes but the user and password don't", async () => {
    const dir = tempDir();
    let checks = 0;
    const auth = new IngestAuth(dir, Date.now, async (password, hash) => {
      checks++;
      return Bun.password.verify(password, hash);
    });
    await auth.setBasic("hermes", PASSWORD);
    const made = auth.addToken("ci");
    if ("error" in made) throw new Error(made.error);

    const header = basic("hermes", PASSWORD);
    expect(await auth.authenticate(header)).not.toBeNull();
    expect(checks).toBe(1);

    // A token's first use writes when it was used to the file, and the CLI adds a token: no password changed.
    const before = readFileSync(join(dir, AUTH_FILE), "utf8");
    expect(await auth.authenticate(bearer(made.token))).not.toBeNull();
    expect(readFileSync(join(dir, AUTH_FILE), "utf8")).not.toBe(before);
    expect(auth.cachedBasic(header)).toEqual({ kind: "basic", label: "hermes", key: "b:hermes" });
    new IngestAuth(dir).addToken("laptop");
    expect(auth.cachedBasic(header)).not.toBeNull();
    expect(await auth.authenticate(header)).not.toBeNull();
    expect(checks).toBe(1);

    // A new password, also one set by another process, forgets it.
    await new IngestAuth(dir).setBasic("hermes", "another long password");
    expect(auth.cachedBasic(header)).toBeNull();
    expect(await auth.authenticate(header)).toBeNull();
    expect(checks).toBe(2);
  });

  test.each([
    ["a new password is set", (dir: string) => new IngestAuth(dir).setBasic("hermes", "another long password")],
    ["another user is set", (dir: string) => new IngestAuth(dir).setBasic("hermes2", PASSWORD)],
    ["basic auth is turned off", (dir: string) => new IngestAuth(dir).clearBasic()],
  ])("a check against the old password that passes after %s lets nobody in, then or later", async (_name, change) => {
    const dir = tempDir();
    const checked: string[] = [];
    const held: ((ok: boolean) => void)[] = [];
    const auth = new IngestAuth(dir, Date.now, (password, hash) => {
      checked.push(hash);
      if (checked.length > 1) return Bun.password.verify(password, hash);
      return new Promise((resolve) => held.push(resolve));
    });
    await auth.setBasic("hermes", PASSWORD);
    const oldHash = JSON.parse(readFileSync(join(dir, AUTH_FILE), "utf8")).basic.hash;

    const header = basic("hermes", PASSWORD);
    const pending = auth.authenticate(header);
    while (!held.length) await Bun.sleep(1);
    expect(checked).toEqual([oldHash]);

    // The basic auth user changes while the check against the old one is still running, and that check then passes.
    await change(dir);
    held[0]!(true);
    expect(await pending).toBeNull();

    // The old header isn't taken from the cache either: it is refused again.
    expect(auth.cachedBasic(header)).toBeNull();
    expect(await auth.authenticate(header)).toBeNull();
  });

  test("a wrong user is checked like a wrong password: the password check runs either way", async () => {
    const checked: string[] = [];
    const auth = new IngestAuth(tempDir(), Date.now, async (password, hash) => {
      checked.push(hash);
      return Bun.password.verify(password, hash);
    });
    await auth.setBasic("hermes", PASSWORD);

    expect(await auth.authenticate(basic("other", PASSWORD))).toBeNull();
    expect(await auth.authenticate(basic("hermes", "wrong password!"))).toBeNull();
    expect(checked).toHaveLength(2);
    expect(checked[0]).toStartWith("$argon2id$");
    // The wrong user's check was against a decoy, never the stored hash: the right password doesn't let it in.
    expect(checked[0]).not.toBe(checked[1]);
  });

  test("at most 2 password checks run at once with 8 waiting: one more is told the server is busy", async () => {
    let running = 0;
    let most = 0;
    const auth = new IngestAuth(tempDir(), Date.now, async () => {
      most = Math.max(most, ++running);
      await Bun.sleep(20);
      running--;
      return false;
    });
    await auth.setBasic("hermes", PASSWORD);

    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => auth.authenticate(basic("hermes", `wrong password ${i}`))));
    expect(most).toBe(2);
    expect(results.filter((r) => r.status === "fulfilled" && r.value === null)).toHaveLength(10);
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof IngestAuthBusy)).toHaveLength(10);

    // Once they are done, there is room again.
    expect(await auth.authenticate(basic("hermes", "one more wrong one"))).toBeNull();
  });

  test("the decoy hash waits its turn with the password checks, and is made again after making it failed", async () => {
    const held: (() => void)[] = [];
    const checked: string[] = [];
    const verify: VerifyPassword = (_, hash) => {
      checked.push(hash);
      if (held.length >= 2) return Promise.resolve(false);
      return new Promise((resolve) => held.push(() => resolve(false)));
    };
    let decoys = 0;
    const makeDecoy = async () => {
      if (++decoys === 1) throw new Error("hash failed");
      return "$decoy";
    };
    const auth = new IngestAuth(tempDir(), Date.now, verify, makeDecoy);
    await auth.setBasic("hermes", PASSWORD);

    // Both checks are taken: the decoy for a wrong user isn't made until one of them is done.
    const busy = [auth.authenticate(basic("hermes", "wrong password 1")), auth.authenticate(basic("hermes", "wrong password 2"))];
    const wrongUser = auth.authenticate(basic("other", PASSWORD));
    await Bun.sleep(10);
    expect(decoys).toBe(0);

    held[0]!();
    await expect(wrongUser).rejects.toThrow("hash failed");
    held[1]!();
    expect(await Promise.all(busy)).toEqual([null, null]);

    // The failure isn't kept: the next wrong user makes the decoy again and is checked against it.
    expect(await auth.authenticate(basic("other", PASSWORD))).toBeNull();
    expect(decoys).toBe(2);
    expect(checked.at(-1)).toBe("$decoy");
  });

  test("a user is 1 to 100 characters without a colon, a password 12 to 1024", async () => {
    const auth = new IngestAuth(tempDir());
    for (const user of ["", "a:b", "x".repeat(101), "a\u0000b", 1]) {
      expect(await auth.setBasic(user, PASSWORD), JSON.stringify(user)).toEqual({ error: "invalid value for user" });
    }
    for (const password of ["short", "x".repeat(11), "x".repeat(1025), null]) {
      expect("error" in (await auth.setBasic("hermes", password)), String(password).slice(0, 20)).toBe(true);
    }
    expect(auth.basic()).toBeNull();
    expect(await auth.setBasic("hermes", "x".repeat(12))).toEqual({ user: "hermes" });
  });
});
