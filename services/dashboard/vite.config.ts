import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  optimizeDeps: {
    // mapbox-gl ships CommonJS; pre-bundle it so Vite can tree-shake correctly.
    include: ["mapbox-gl"],
  },
  server: {
    port: 5173,
    proxy: {
      // Dev proxy: forward API calls to the local gateway
      "/api":  "http://localhost:3000",
      "/auth": "http://localhost:3000",
    },
  },
});
