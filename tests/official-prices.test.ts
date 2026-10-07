import { describe, expect, test } from "bun:test";
import { OFFICIAL_SOURCES, anthropicId, loadOfficial, parseAnthropic, parseGoogle, parseMiniMax, parseMoonshot, parseOpenAI, parseXai, parseZai, type OfficialEntry } from "../scripts/official-prices.ts";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/prices/${name}.md`, import.meta.url)).text();
const TODAY = "2026-10-07";

/** input, output, cache read, cache write 5m, cache write 1h. */
const rates = (e: OfficialEntry | undefined) => (e ? [e.input, e.output, e.cacheRead, e.cacheWrite5m, e.cacheWrite1h] : undefined);
const byId = (entries: OfficialEntry[], id: string) => entries.find((e) => e.id === id);

describe("Anthropic", () => {
  test("model names map to our ids", () => {
    expect([
      "Claude Opus 5.5",
      "Claude Sonnet 5.5",
      "Claude Fable 5.1",
      "Claude Mythos 5.1",
      "Claude Haiku 4.5",
      "Claude Opus 4",
      "Claude Opus 4.1",
      "Claude Haiku 3.5",
      "Claude Sonnet 3.7",
      "Claude Haiku 3",
    ].map(anthropicId)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-mythos-5-1", "claude-haiku-4-5", "claude-opus-4", "claude-opus-4-1", "claude-3-5-haiku", "claude-3-7-sonnet", "claude-3-haiku"]);
    expect(() => anthropicId("Claude Mythos Preview")).toThrow("unrecognised");
  });

  test("the model table is read with footnote marks, links and explicit cache prices", async () => {
    const r = parseAnthropic(await fixture("anthropic"));
    expect(rates(byId(r.entries, "claude-opus-5-5"))).toEqual([4, 20, 0.2, 5, 8]);
    expect(rates(byId(r.entries, "claude-sonnet-5-5"))).toEqual([2, 10, 0.2, 2.5, 4]);
    expect(rates(byId(r.entries, "claude-fable-5-1"))).toEqual([10, 50, 0.25, 12.5, 20]);
    expect(rates(byId(r.entries, "claude-mythos-5-1"))).toEqual([10, 50, 0.25, 12.5, 20]);
    expect(rates(byId(r.entries, "claude-haiku-4-5"))).toEqual([1, 5, 0.1, 1.25, 2]);
    expect(rates(byId(r.entries, "claude-3-5-haiku"))).toEqual([0.8, 4, 0.08, 1, 1.6]);
    expect(r.entries.map((e) => e.id)).toContain("claude-opus-4");
  });

  test("the batch table is not read and fast mode is checked against 2x", async () => {
    const r = parseAnthropic(await fixture("anthropic"));
    expect(byId(r.entries, "claude-opus-5-5")!.input).toBe(4);
    expect(r.warnings).toEqual([]);
    expect(r.notes[0]).toContain("still 2x");
  });

  test("a fast mode price that is not 2x is reported", async () => {
    const text = (await fixture("anthropic")).replace("| Claude Opus 5.5                 | $8 / MTok  | $40 / MTok |", "| Claude Opus 5.5                 | $12 / MTok | $40 / MTok |");
    const r = parseAnthropic(text);
    expect(r.warnings[0]).toContain("Claude Opus 5.5 is $12 in and $40 out, not 2x");
  });

  test("a table it does not recognise, an unreadable price or a missing column fails the page", async () => {
    const text = await fixture("anthropic");
    expect(() => parseAnthropic("# Pricing\n\nNothing here.")).toThrow("model pricing table was not found");
    expect(() => parseAnthropic(text.replace("$10 / MTok", "contact sales"))).toThrow("cannot read the price");
    expect(() => parseAnthropic(text.replace("| Cache hits and refreshes", "| Reads"))).toThrow();
  });
});

describe("OpenAI", () => {
  test("the standard tier, short context, with cache writes where listed", async () => {
    const r = parseOpenAI(await fixture("openai"));
    expect(rates(byId(r.entries, "gpt-5.6-sol"))).toEqual([4, 20, 0.4, 5, 5]);
    expect(rates(byId(r.entries, "gpt-6-sol"))).toEqual([2, 10, 0.2, 2.5, 2.5]);
    expect(rates(byId(r.entries, "gpt-6.1-sol"))).toEqual([2, 10, 0.1, 2.5, 2.5]);
    expect(rates(byId(r.entries, "gpt-5.6-luna"))).toEqual([0.2, 1.2, 0.02, 0.25, 0.25]);
    expect(rates(byId(r.entries, "gpt-6-astra"))).toEqual([10, 50, 1, 12.5, 12.5]);
    expect(rates(byId(r.entries, "gpt-6-luna"))).toEqual([0.1, 0.5, 0.01, 0.125, 0.125]);
  });

  test("a context note on the name is dropped, no cache write means writes cost input, a missing cached price is unlisted", async () => {
    const r = parseOpenAI(await fixture("openai"));
    expect(rates(byId(r.entries, "gpt-5.5"))).toEqual([5, 30, 0.5, 5, 5]);
    const pro = byId(r.entries, "gpt-5.5-pro")!;
    expect(rates(pro)).toEqual([30, 180, 30, 30, 30]);
    expect(pro.unlisted).toEqual(["cacheRead"]);
    expect(rates(byId(r.entries, "gpt-5.5-cyber"))).toEqual([12.5, 75, 1.25, 12.5, 12.5]);
    expect(rates(byId(r.entries, "gpt-5.6-cyber"))).toEqual([12.5, 75, 1.25, 15.625, 15.625]);
  });

  test("batch tables and realtime tables are not read", async () => {
    const r = parseOpenAI(await fixture("openai"));
    expect(r.entries.filter((e) => e.id === "gpt-6-astra")).toHaveLength(1);
    expect(r.entries.some((e) => e.id.startsWith("gpt-realtime"))).toBe(false);
  });

  test("the same model with two different prices fails the page", async () => {
    const text = await fixture("openai");
    const cyber = text.replace("| gpt-5.6-cyber |", "| gpt-5.6-sol | $9.00 | $1.00 | $1.00 | $9.00 | - | - | - | - |\n| gpt-5.6-cyber |");
    expect(() => parseOpenAI(cyber)).toThrow("gpt-5.6-sol is listed twice with different prices");
  });
});

describe("Google", () => {
  test("paid tier, short prompts, text price, cache read from context caching, writes at input", async () => {
    const r = parseGoogle(await fixture("google"), TODAY);
    expect(rates(byId(r.entries, "gemini-3.1-pro-preview"))).toEqual([2, 12, 0.2, 2, 2]);
    expect(rates(byId(r.entries, "gemini-3.1-pro-preview-customtools"))).toEqual([2, 12, 0.2, 2, 2]);
    expect(rates(byId(r.entries, "gemini-2.5-flash-lite"))).toEqual([0.1, 0.4, 0.01, 0.1, 0.1]);
    expect(rates(byId(r.entries, "gemini-2.5-flash"))).toEqual([0.3, 2.5, 0.03, 0.3, 0.3]);
    expect(rates(byId(r.entries, "gemini-3.5-flash-lite"))).toEqual([0.3, 2.5, 0.03, 0.3, 0.3]);
  });

  test("the storage price per hour is never a price per token, and TTS sections are skipped", async () => {
    const r = parseGoogle(await fixture("google"), TODAY);
    expect(r.entries.every((e) => e.cacheWrite5m === e.input)).toBe(true);
    expect(r.entries.some((e) => e.id.includes("tts"))).toBe(false);
  });

  test("an intro price is the one valid today, and the scheduled change is kept", async () => {
    const r = parseGoogle(await fixture("google"), TODAY);
    const flash = byId(r.entries, "gemini-3.8-flash")!;
    expect(rates(flash)).toEqual([0.75, 3.75, 0.075, 0.75, 0.75]);
    expect(flash.scheduled).toEqual([{ from: "2027-01-01", to: { input: 1.5, output: 7.5, cacheRead: 0.15 } }]);
  });

  test("on and after the date the new price applies and nothing is scheduled", async () => {
    for (const day of ["2027-01-01", "2027-03-15"]) {
      const flash = byId(parseGoogle(await fixture("google"), day).entries, "gemini-3.8-flash")!;
      expect(rates(flash)).toEqual([1.5, 7.5, 0.15, 1.5, 1.5]);
      expect(flash.scheduled).toBeUndefined();
    }
    expect(rates(byId(parseGoogle(await fixture("google"), "2026-12-31").entries, "gemini-3.8-flash"))).toEqual([0.75, 3.75, 0.075, 0.75, 0.75]);
  });

  test("a dated price it cannot read fails the page", async () => {
    const text = (await fixture("google")).replace("$0.75 through December 31, 2026. $1.50 starting January 1, 2027.", "$0.75 through December 31, 2026, then $1.50 starting January 1, 2027.");
    expect(() => parseGoogle(text, TODAY)).toThrow("cannot read the dated price");
  });
});

describe("Z.ai", () => {
  test("input, cached input and output per model", async () => {
    const r = parseZai(await fixture("zai"));
    expect(rates(byId(r.entries, "glm-4.6"))).toEqual([0.6, 2.2, 0.11, 0.6, 0.6]);
    expect(rates(byId(r.entries, "glm-4.5-air"))).toEqual([0.2, 1.1, 0.03, 0.2, 0.2]);
    expect(rates(byId(r.entries, "glm-5.3-flashx"))).toEqual([0.37, 1.25, 0.075, 0.37, 0.37]);
  });

  test("free models are skipped and a missing cached price is unlisted", async () => {
    const r = parseZai(await fixture("zai"));
    expect(byId(r.entries, "glm-4.7-flash")).toBeUndefined();
    expect(byId(r.entries, "glm-4-32b-0414-128k")!.unlisted).toEqual(["cacheRead"]);
  });

  test("the image price table is not read as tokens", async () => {
    expect(parseZai(await fixture("zai")).entries.some((e) => e.id === "glm-image")).toBe(false);
  });

  test("a model name it does not know fails the page", async () => {
    const text = (await fixture("zai")).replace("| GLM-5 |", "| Mystery 9 |");
    expect(() => parseZai(text)).toThrow("unrecognised Z.ai model name");
  });
});

describe("xAI", () => {
  test("short prompt tier, release dates dropped from the ids", async () => {
    const r = parseXai(await fixture("xai"));
    expect(rates(byId(r.entries, "grok-4.7"))).toEqual([2, 6, 0.5, 2, 2]);
    expect(rates(byId(r.entries, "grok-4.5"))).toEqual([2, 6, 0.3, 2, 2]);
    expect(rates(byId(r.entries, "grok-4.20-reasoning"))).toEqual([1.25, 2.5, 0.2, 1.25, 1.25]);
    expect(rates(byId(r.entries, "grok-4.20-multi-agent"))).toEqual([1.25, 2.5, 0.2, 1.25, 1.25]);
    expect(rates(byId(r.entries, "grok-build-0.1"))).toEqual([1, 2, 0.2, 1, 1]);
  });
});

describe("Moonshot", () => {
  test("the MDX tables give the 5 minute and 1 hour cache writes where listed", async () => {
    const r = parseMoonshot(await fixture("moonshot"));
    expect(rates(byId(r.entries, "kimi-k3"))).toEqual([3, 15, 0.3, 3, 6]);
    expect(rates(byId(r.entries, "kimi-k2.6"))).toEqual([0.95, 4, 0.16, 0.95, 0.95]);
    expect(rates(byId(r.entries, "kimi-k2.7-code-highspeed"))).toEqual([1.9, 8, 0.38, 1.9, 1.9]);
  });
});

describe("MiniMax", () => {
  test("the Standard tier up to 512k, after the strike-through discount, no Priority", async () => {
    const r = parseMiniMax(await fixture("minimax"));
    expect(rates(byId(r.entries, "minimax-m3"))).toEqual([0.3, 1.2, 0.06, 0.3, 0.3]);
    expect(rates(byId(r.entries, "minimax-m2.7"))).toEqual([0.3, 1.2, 0.06, 0.375, 0.375]);
    expect(rates(byId(r.entries, "minimax-m2.7-highspeed"))).toEqual([0.6, 2.4, 0.06, 0.375, 0.375]);
    expect(rates(byId(r.entries, "minimax-m2.5"))).toEqual([0.3, 1.2, 0.03, 0.375, 0.375]);
  });
});

describe("loading the pages", () => {
  const files: Record<string, string> = { anthropic: "anthropic", openai: "openai", google: "google", zai: "zai", xai: "xai", moonshot: "moonshot", minimax: "minimax" };

  test("one page failing leaves the others untouched and is reported by maker", async () => {
    const out = await loadOfficial(TODAY, async (s) => {
      if (s.key === "openai") throw new Error("HTTP 503 from https://developers.openai.com/api/docs/pricing.md");
      if (s.key === "google") return "<html>a catch-all page</html>";
      return fixture(files[s.key]!);
    });
    const by = (m: string) => out.find((o) => o.maker === m)!;
    expect(by("OpenAI").error).toContain("HTTP 503");
    expect(by("OpenAI").entries).toBeUndefined();
    expect(by("Google Gemini").error).toBeDefined();
    expect(by("Anthropic").entries!.length).toBeGreaterThan(5);
    expect(by("Z.ai (GLM)").error).toBeUndefined();
    expect(out.map((o) => o.maker)).toEqual([...OFFICIAL_SOURCES.map((s) => s.maker), "DeepSeek", "Alibaba Qwen", "Mistral"]);
    expect(by("DeepSeek").unavailable).toBeDefined();
  });
});
