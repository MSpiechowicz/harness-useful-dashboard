import { de } from "./locales/de.ts";
import { en, type MessageKey } from "./locales/en.ts";

export type Lang = "en" | "de";
export const LANGS: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
];

const DICTS: Record<Lang, Record<MessageKey, string>> = { en, de };
const LOCALES: Record<Lang, string> = { en: "en-US", de: "de-DE" };

function initialLang(): Lang {
  // English is the default; German only when explicitly chosen.
  try {
    const saved = localStorage.getItem("hd.lang");
    if (saved === "en" || saved === "de") return saved;
  } catch {
    /* storage unavailable */
  }
  return "en";
}

class I18n {
  lang = $state<Lang>(initialLang());

  get locale(): string {
    return LOCALES[this.lang];
  }

  set(lang: Lang): void {
    this.lang = lang;
    document.documentElement.lang = lang;
    try {
      localStorage.setItem("hd.lang", lang);
    } catch {
      /* ignore */
    }
  }
}

export const i18n = new I18n();

export type Params = Record<string, string | number | null | undefined>;

/** Translate a key, interpolating `{name}` placeholders. Reactive on the current language. */
export function t(key: MessageKey, params?: Params): string {
  const template = DICTS[i18n.lang][key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params[name];
    return v === null || v === undefined ? "" : String(v);
  });
}

/** For dynamic keys (e.g. tip ids) that may not exist. */
export function tMaybe(key: string, params?: Params): string | null {
  return key in en ? t(key as MessageKey, params) : null;
}

export type { MessageKey };
