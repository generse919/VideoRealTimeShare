import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/video": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
