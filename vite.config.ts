import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.BASE_PATH ?? "/gubbas-porch/",
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
        },
      },
    },
  },
});
