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
    // The ECharts chunk is about 690 kB, loaded only by the pages with charts. Every other chunk stays far below.
    chunkSizeWarningLimit: 750,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // ECharts is the one large dependency, loaded with the first page that draws a chart.
            { name: "echarts", test: /node_modules[\\/](echarts|zrender)[\\/]/ },
            // The icons in one file, not one small file per icon the pages share.
            { name: "icons", test: /node_modules[\\/]@lucide[\\/]/ },
          ],
        },
      },
    },
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
