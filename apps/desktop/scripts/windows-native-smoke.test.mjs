import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { prepareLaunchEnv } from "./launch-env.mjs";

await test(
  "Installed Windows window: native IPC, Sidecar startup and model settings",
  { skip: process.platform !== "win32", timeout: 180_000 },
  async () => {
    assert.ok(process.env.PIX_NATIVE_EXECUTABLE, "Set PIX_NATIVE_EXECUTABLE to the installed app");
    const prepared = await prepareLaunchEnv({ isolated: true });
    let browser;
    let stderr = "";
    let spawnError;
    // The debugger is local to this disposable CI fixture, never enabled in product config.
    const child = spawn(process.env.PIX_NATIVE_EXECUTABLE, [], {
      env: {
        ...prepared.environment,
        PIX_NO_AUTO_RESUME: "1",
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
          "--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1",
        WEBVIEW2_USER_DATA_FOLDER: join(prepared.environment.PIX_DATA_DIR, "webview-test"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.stdout.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-40_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-40_000);
    });
    try {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error(`Pix exited ${child.exitCode}: ${stderr}`);
        try {
          const response = await fetch("http://127.0.0.1:9222/json/version", {
            signal: AbortSignal.timeout(1000),
          });
          if (response.ok) break;
        } catch {
          /* WebView2 is still starting. */
        }
        await delay(250);
      }
      browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 10_000 });
      const context = browser.contexts()[0];
      const page = context.pages()[0] || (await context.waitForEvent("page", { timeout: 30_000 }));
      page.on("pageerror", (error) => console.error("WebView error:", error.message));
      await page.waitForFunction(() => Boolean(window.pix), undefined, { timeout: 30_000 });
      const runtime = await page.evaluate(() => window.pix.app.getRuntime());
      assert.equal(runtime.platform, "win32");
      assert.equal(runtime.isPackaged, true);
      assert.equal(runtime.customWindowControls, true);
      await page.getByTestId("window-caption-buttons").waitFor();
      for (const id of ["window-minimize", "window-maximize", "window-close"]) {
        assert.ok(await page.getByTestId(id).isVisible(), `${id} must be visible on Windows`);
      }
      console.log("Native window connected to Sidecar");
      await page.locator('[data-testid="pix-app"][data-bootstrap-ready="true"]').waitFor({
        timeout: 60_000,
      });
      const wasMaximized = await page.evaluate(() => window.pix.window.isMaximized());
      await page.getByTestId("window-maximize").click();
      await page.waitForFunction(
        async (expected) => (await window.pix.window.isMaximized()) === expected,
        !wasMaximized,
      );
      await page.getByTestId("window-maximize").click();
      await page.waitForFunction(
        async (expected) => (await window.pix.window.isMaximized()) === expected,
        wasMaximized,
      );
      await page.getByTestId("thread-titlebar").waitFor();
      console.log("Native caption buttons maximize and restore the window successfully");
      await page.getByTestId("nav-settings").click();
      await page.getByTestId("settings-nav-models").click();
      await page.getByTestId("settings-models").waitFor();
      const models = await page.evaluate(async () => {
        await window.pix.host.start();
        return window.pix.models.refreshCatalog();
      });
      assert.ok(models.some((model) => model.provider === "pix-fake" && model.id === "pix-fake"));
      await page.getByTestId("models-custom-group-custom:pix-fake-toggle").click();
      await page.getByTestId("provider-row-pix-fake").waitFor();
      console.log("Installed model settings loaded successfully");
      await page.getByTestId("settings-back").click();
      await page.getByTestId("model-select-wrap").click();
      await page.getByTestId("composer-model-list-trigger").click();
      await page.getByTestId("composer-model-pix-fake").click();
      assert.match(await page.getByTestId("model-select-label").innerText(), /Pix Fake Model/);
      assert.ok(!(await page.locator("body").innerText()).includes("Node Agent Sidecar exited"));
      console.log("Installed composer model picker selected the model successfully");
    } catch (error) {
      console.error("Native application output:\n", stderr);
      throw error;
    } finally {
      if (child.pid && child.exitCode === null) {
        try {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          /* The app may already have exited. */
        }
      }
      await browser?.close().catch(() => {});
      await prepared.cleanup().catch((error) => {
        // WebView2 can retain its lock briefly after taskkill; do not hide the
        // actual test failure behind cleanup of a disposable temporary folder.
        console.warn("Could not remove temporary smoke profile:", error.message);
      });
    }
  },
);
