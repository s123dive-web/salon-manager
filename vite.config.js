import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import changelog from "./scripts/vite-changelog-plugin.js";

// Served at the repo sub-path on GitHub Pages in production; at root during local dev.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/salon-manager/" : "/",
  plugins: [react(), changelog()],
  server: { port: 5173, open: true },
  build: {
    // Split heavy vendors into their own chunks so the browser caches them across
    // deploys and loads them in parallel instead of in one ~1.5 MB blob.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          charts: ["recharts"],
          firebase: ["firebase/app", "firebase/auth", "firebase/database"],
          xlsx: ["xlsx"],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
}));
