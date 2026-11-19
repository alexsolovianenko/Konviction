import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const hosted = process.env["VERCEL"] === "1" || process.env["BUILD_VERCEL"] === "true";
const capturePort = process.env["CAPTURE_PORT"];

export default defineConfig({
  plugins: [
    tailwind(),
    tanstackStart({ server: { entry: "server" } }),
    ...(hosted ? [nitro({ preset: "vercel" })] : []),
    react(),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: ["react", "react-dom"],
  },
  define: { "import.meta.env.VITE_WORKER_TRADING": JSON.stringify(hosted) },
  server: {
    host: "127.0.0.1", port: 5173, strictPort: true,
    fs: { deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.git/**", "**/data/**", "**/*.{sqlite,sqlite-wal,sqlite-shm,db,db-wal,db-shm}"] },
    proxy: capturePort ? {
      "^/api/(trading/|voice/|transcripts(?:$|[?])|intents(?:$|[?])|tools/)": {
        target: "http://127.0.0.1:" + capturePort, changeOrigin: false,
      },
    } : {},
  },
});
