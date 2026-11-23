import { defineConfig } from "vite";

// Keep the dev server from watching transient files (editor temp dirs, the
// headless-browser profile) that can be locked on Windows and crash the watcher.
export default defineConfig({
  server: {
    watch: {
      ignored: ["**/.edgeprofile/**", "**/*.tmpdir/**", "**/.*.tmp*"],
    },
  },
  build: { outDir: "dist" },
});
