import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173/gubbas-porch/",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
      ],
    },
  },
  webServer: {
    command: "BASE_PATH=/gubbas-porch/ npm run build && BASE_PATH=/gubbas-porch/ npm run preview",
    url: "http://127.0.0.1:4173/gubbas-porch/",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
