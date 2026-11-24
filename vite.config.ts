import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.BASE_PATH ?? "/gubbas-porch/",
  build: {
    target: "es2022",
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "three", test: /node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
});
