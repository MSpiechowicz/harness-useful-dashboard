import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { loadToken } from "../src/server/auth.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [svelte(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      // The dev server signs the UI in itself: requests through it carry the token the API server reads from the same
      // app data folder. So http://localhost:5173 just works, without the sign-in link.
      "/api": { target: "http://127.0.0.1:4318", changeOrigin: false, headers: { Authorization: `Bearer ${loadToken()}` } },
    },
  },
});
