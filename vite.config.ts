import { defineConfig } from "vite";

// Relative asset paths so the same build works at a custom domain root and under
// a project subpath (e.g. the default github.io/Narita_Taxi_Guide/ URL).
// Keep the dev server from watching transient files (editor temp dirs, the
// headless-browser profile) that can be locked on Windows and crash the watcher.
export default defineConfig({
  base: "./",
  server: {
    watch: {
      ignored: ["**/.edgeprofile/**", "**/*.tmpdir/**", "**/.*.tmp*"],
    },
  },
  build: { outDir: "dist" },
});
