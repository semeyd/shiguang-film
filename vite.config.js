import { defineConfig } from "vite";

export default defineConfig({
  publicDir: "public",
  base: "./",
  build: {
    chunkSizeWarningLimit: 650,
  },
  server: {
    host: "127.0.0.1",
  },
});
