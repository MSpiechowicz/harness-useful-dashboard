import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { loadColorRanking } from "./lib/colors.svelte.ts";
import { i18n } from "./lib/i18n.svelte.ts";
import { live } from "./lib/live.svelte.ts";

void loadColorRanking();
live.start();

// The saved language first, so the UI doesn't show in English for a moment.
await i18n.ready;

export default mount(App, { target: document.getElementById("app")! });
