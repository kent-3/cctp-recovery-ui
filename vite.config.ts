import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Solana web3.js and anchor expect a few Node globals in the browser.
// The define + resolve aliases below cover the common gaps without a
// heavyweight polyfill plugin.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "docs",
  },
  define: {
    "process.env": {},
    global: "globalThis",
  },
  resolve: {
    alias: {
      // bs58 / borsh pull in Buffer; ensure a browser Buffer is available.
      buffer: "buffer",
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: { global: "globalThis" },
    },
  },
});
