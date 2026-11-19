// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// Never set ssr.external or resolve.external: the Worker has no runtime module resolution, so
// the build fails. Never add compression (compressPublicAssets, vite-plugin-compression):
// hosting already compresses at the edge.
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { fileURLToPath } from "node:url";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  nitro: process.env['BUILD_WORKER'] === 'true',
  vite: {
    define: { "import.meta.env.VITE_WORKER_TRADING": JSON.stringify(process.env["BUILD_WORKER"] === "true") },
    server: { host: "127.0.0.1", port: 5173, strictPort: true,
      fs: { deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.git/**", "**/data/**", "**/*.{sqlite,sqlite-wal,sqlite-shm,db,db-wal,db-shm}"] },
      proxy: process.env['CAPTURE_PORT'] ? {
        "^/api/(trading/|voice/|transcripts(?:$|[?])|intents(?:$|[?])|tools/)": "http://127.0.0.1:" + process.env['CAPTURE_PORT'],
      } : {},
    },
    resolve: {
      alias: {
        // rpc-websockets has no worker/default export; its browser build uses Web APIs.
        "rpc-websockets": fileURLToPath(
          new URL("./node_modules/rpc-websockets/dist/index.browser.mjs", import.meta.url),
        ),
      },
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
