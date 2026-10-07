import { en, type MessageKey } from "./locales/en.ts";

export type Lang = "en" | "de" | "es" | "fr" | "pl";
/** Each language named in itself, as a language picker lists them. */
export const LANGS: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "pl", label: "Polski" },
];

type Dict = Record<MessageKey, string>;
// English is built in. The others load when chosen, each in its own file (every one must still have every key).
const LOADERS: Record<Exclude<Lang, "en">, () => Promise<Dict>> = {
  de: () => import("./locales/de.ts").then((m) => m.de),
  es: () => import("./locales/es.ts").then((m) => m.es),
  fr: () => import("./locales/fr.ts").then((m) => m.fr),
  pl: () => import("./locales/pl.ts").then((m) => m.pl),
};
const LOCALES: Record<Lang, string> = { en: "en-US", de: "de-DE", es: "es-ES", fr: "fr-FR", pl: "pl-PL" };

function initialLang(): Lang {
  // English is the default. Another language only when explicitly chosen.
  try {
    const saved = localStorage.getItem("hd.lang");
    if (LANGS.some((l) => l.code === saved)) return saved as Lang;
  } catch {
    /* storage unavailable */
  }
  return "en";
}

class I18n {
  lang = $state<Lang>("en");
  /** The messages of `lang`. Switched together with it, so the UI never shows a language half loaded. */
  dict = $state.raw<Dict>(en);
  /** Settles once the saved language is loaded: the app mounts after it, so it never shows English first. */
  readonly ready: Promise<void>;
  private seq = 0;

  constructor() {
    this.ready = this.load(initialLang());
  }

  get locale(): string {
    return LOCALES[this.lang];
  }

  set(lang: Lang): void {
    try {
      localStorage.setItem("hd.lang", lang);
    } catch {
      /* ignore */
    }
    void this.load(lang);
  }

  private async load(lang: Lang): Promise<void> {
    const mine = ++this.seq;
    let dict: Dict = en;
    if (lang !== "en") {
      try {
        dict = await LOADERS[lang]();
      } catch {
        // Its file didn't load (e.g. the server restarted with a new version): stay in the language shown.
        return;
      }
    }
    // A later choice won.
    if (mine !== this.seq) return;
    this.dict = dict;
    this.lang = lang;
    document.documentElement.lang = lang;
  }
}

export const i18n = new I18n();

export type Params = Record<string, string | number | null | undefined>;

/** Translate a key, interpolating `{name}` placeholders. Reactive on the current language. */
export function t(key: MessageKey, params?: Params): string {
  const template = i18n.dict[key] ?? en[key] ?? key;
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
