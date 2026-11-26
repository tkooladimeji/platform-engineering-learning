import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const proxy = {
  "/api": {
    target: process.env.GATEWAY_URL ?? "http://127.0.0.1:4000",
    changeOrigin: true,
  },
};

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy },
});
