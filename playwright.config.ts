import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3456";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results",
  timeout: 30_000,
  expect: {
    timeout: 7_500,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.03,
    },
  },
  retries: 1,
  reporter: [["html"], ["list"]],
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "iphone-xr", use: { ...devices["iPhone XR"], browserName: "chromium" } },
    { name: "iphone-14-pro", use: { ...devices["iPhone 14 Pro"], browserName: "chromium" } },
    { name: "iphone-se", use: { ...devices["iPhone SE"], browserName: "chromium" } },
    { name: "pixel-7", use: { ...devices["Pixel 7"], browserName: "chromium" } },
    { name: "ipad-mini", use: { ...devices["iPad Mini"], browserName: "chromium" } },
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1920, height: 1080 } } },
    { name: "webkit-iphone-xr", use: { ...devices["iPhone XR"], browserName: "webkit" } },
  ],
});
