import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The backend (node:http on :8000) owns /run and /health; in dev we proxy so the
// browser stays same-origin and the backend never needs CORS.
const BACKEND = "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/run": BACKEND,
      "/health": BACKEND,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
