#!/usr/bin/env bun
/**
 * Runs the API server (with --watch) and the Vite dev server side by side. Open http://localhost:5173.
 * The API listens on 4318, so it never takes the installed app's port (4317) and both can run at once.
 */
export {};

const procs = [
  Bun.spawn(["bun", "--watch", "src/cli.ts", "serve", "--no-open", "--port", "4318"], { stdio: ["inherit", "inherit", "inherit"] }),
  Bun.spawn(["bunx", "vite", "--config", "web/vite.config.ts"], { stdio: ["inherit", "inherit", "inherit"] }),
];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await Promise.race(procs.map((p) => p.exited));
stop();
