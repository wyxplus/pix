import { test, expect, startHost, sendPrompt } from "./fixtures.ts";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "Win32" });
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    });
  });
  await page.reload();
  await expect(page.getByTestId("pix-app")).toHaveAttribute("data-bootstrap-ready", "true");
});

test("Windows close asks by default, can cancel, remembers tray and can return to asking in settings", async ({
  page,
  pix,
}, testInfo) => {
  await startHost(page);
  await page.getByTestId("window-close").click();
  await expect(page.getByTestId("window-close-dialog")).toBeVisible();
  await expect(page.getByTestId("window-close-cancel")).toBeFocused();
  await expect(page.getByTestId("window-close-remember")).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("close-choices.png") });
  await page.getByTestId("window-close-cancel").click();
  expect(
    await pix.app.evaluate(({ window }) => ({ hidden: window.hidden, closed: window.closed })),
  ).toEqual({ hidden: false, closed: false });

  // A native close event (such as Alt+F4) goes through the same prompt.
  await page.evaluate(() => (window as any).__pixTestNativeEvent("tauri://close-requested"));
  await expect(page.getByTestId("window-close-dialog")).toBeVisible();
  await page.getByTestId("window-close-remember").check();
  await page.getByTestId("window-close-confirm").click();
  await expect.poll(() => pix.app.evaluate(({ window }) => window.hidden)).toBe(true);
  expect(await pix.app.evaluate(({ window }) => window.closed)).toBe(false);
  const runtimeId = (await page.evaluate(() => window.pix.host.snapshot())).runtimeId;
  await sendPrompt(page, "Reply after hiding the window");
  expect((await page.evaluate(() => window.pix.host.snapshot())).runtimeId).toBe(runtimeId);

  await pix.app.evaluate(({ window }) => {
    window.hidden = false;
  });
  await page.reload();
  await expect(page.getByTestId("pix-app")).toHaveAttribute("data-bootstrap-ready", "true");
  await page.getByTestId("window-close").click();
  await expect.poll(() => pix.app.evaluate(({ window }) => window.hidden)).toBe(true);
  await expect(page.getByTestId("window-close-dialog")).toHaveCount(0);

  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-general").click();
  await page.getByTestId("settings-window-close-behavior").click();
  await page.getByRole("option", { name: "每次询问" }).click();
  await page.getByTestId("window-close").click();
  await expect(page.getByTestId("window-close-dialog")).toBeVisible();
});

test("Windows close remembers quit and settings can also select a default", async ({
  page,
  pix,
}) => {
  await page.getByTestId("window-close").click();
  await page.getByTestId("window-close-action-quit").check();
  await page.getByTestId("window-close-remember").check();
  await page.getByTestId("window-close-confirm").click();
  await expect.poll(() => pix.app.evaluate(({ window }) => window.closed)).toBe(true);
  await pix.app.evaluate(({ window }) => {
    window.closed = false;
  });
  await page.reload();
  await expect(page.getByTestId("pix-app")).toHaveAttribute("data-bootstrap-ready", "true");
  await page.getByTestId("window-close").click();
  await expect.poll(() => pix.app.evaluate(({ window }) => window.closed)).toBe(true);
  await expect(page.getByTestId("window-close-dialog")).toHaveCount(0);

  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-general").click();
  await page.getByTestId("settings-window-close-behavior").click();
  await page.getByRole("option", { name: "隐藏到系统托盘" }).click();
  await pix.app.evaluate(({ window }) => {
    window.closed = false;
  });
  await page.getByTestId("window-close").click();
  await expect.poll(() => pix.app.evaluate(({ window }) => window.hidden)).toBe(true);
  expect(await pix.app.evaluate(({ window }) => window.closed)).toBe(false);
});

test("A missing tray keeps the window open and does not remember a failed choice", async ({
  page,
  pix,
}) => {
  await pix.app.evaluate(({ window }) => {
    window.trayAvailable = false;
  });
  await page.getByTestId("window-close").click();
  await page.getByTestId("window-close-remember").check();
  await page.getByTestId("window-close-confirm").click();
  await expect(page.getByTestId("window-close-dialog").getByRole("alert")).toContainText(
    "tray icon is unavailable",
  );
  expect(
    await pix.app.evaluate(({ window }) => ({ hidden: window.hidden, closed: window.closed })),
  ).toEqual({ hidden: false, closed: false });
  await page.getByTestId("window-close-cancel").click();
  await page.getByTestId("window-close").click();
  await expect(page.getByTestId("window-close-dialog")).toBeVisible();
  await page.getByTestId("window-close-action-quit").check();
  await page.getByTestId("window-close-confirm").click();
  await expect.poll(() => pix.app.evaluate(({ window }) => window.closed)).toBe(true);
});
