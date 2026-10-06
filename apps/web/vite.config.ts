import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// FIGLAB_API_PROXY (for example http://127.0.0.1:3000) forwards API calls to a locally running
// Fastify server when the web app is served by Vite instead of Caddy or Netlify.
const apiProxy = process.env.FIGLAB_API_PROXY;
const proxy = apiProxy ? { "/v1": apiProxy, "/health": apiProxy } : undefined;

export default defineConfig({
  plugins: [react()],
  server: { port: 4173, ...(proxy ? { proxy } : {}) },
  preview: { ...(proxy ? { proxy } : {}) },
  build: { chunkSizeWarningLimit: 650 },
});
