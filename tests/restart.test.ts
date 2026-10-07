import { describe, expect, test } from "bun:test";
import { RESTART_GIVE_UP_MS, restartDone } from "../web/src/lib/restart.ts";

describe("waiting for the updated server", () => {
  test("keeps waiting while nothing listens or the old version still answers", () => {
    expect(restartDone(null, "1.11.1", 2000)).toBe(false);
    expect(restartDone({ status: 200, version: "1.11.1" }, "1.11.1", 300)).toBe(false);
    expect(restartDone({ status: 500 }, "1.11.1", 2000)).toBe(false);
  });
  test("reloads once the new version answers", () => {
    expect(restartDone({ status: 200, version: "1.12.0" }, "1.11.1", 2000)).toBe(true);
  });
  test("reloads when the new server doesn't know this window, so it shows the sign-in message", () => {
    expect(restartDone({ status: 401 }, "1.10.0", 2000)).toBe(true);
  });
  test("never waits forever", () => {
    expect(restartDone(null, "1.11.1", RESTART_GIVE_UP_MS)).toBe(true);
    expect(restartDone({ status: 200, version: "1.11.1" }, "1.11.1", RESTART_GIVE_UP_MS)).toBe(true);
  });
  test("without a known version only a refusal or the time limit ends the wait", () => {
    expect(restartDone({ status: 200, version: "1.12.0" }, "", 2000)).toBe(false);
  });
});
