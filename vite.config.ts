import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./web/src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist/assets",
    emptyOutDir: false,
    cssCodeSplit: false,
    minify: "oxc",
    lib: {
      entry: fileURLToPath(new URL("./web/src/main.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "studio.js",
      cssFileName: "studio",
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.names.some((name) => name.endsWith(".css"))
            ? "studio.css"
            : "[name]-[hash][extname]",
      },
    },
  },
});
