import { defineConfig } from "@playwright/test";

/**
 * WebView-compatible browser + Node Sidecar E2E for the Pix desktop UI.
 * Workers must stay at 1 — each test launches an isolated Sidecar + Agent Host.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    browserName: process.env.PIX_TEST_BROWSER === "webkit" ? "webkit" : "chromium",
    trace: "off",
    screenshot: "only-on-failure",
  },
});
