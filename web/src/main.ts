import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { loadColorRanking } from "./lib/colors.svelte.ts";
import { live } from "./lib/live.svelte.ts";

void loadColorRanking();
live.start();

export default mount(App, { target: document.getElementById("app")! });
