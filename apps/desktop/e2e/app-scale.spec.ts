import { expect, test, startHost } from "./fixtures.ts";

test.describe("App scale", () => {
  test("folds smoothly with content retained, reverses mid-motion, and respects reduced motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await startHost(page);
    const sidebar = page.getByTestId("sidebar");
    const initialWidth = (await sidebar.boundingBox())!.width;
    await page.setViewportSize({ width: 800, height: 650 });
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    const midway = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>('[data-testid="sidebar"]')!;
      const main = document.querySelector<HTMLElement>('[data-testid="shell-main"]')!;
      const animations = [...sidebar.getAnimations(), ...main.getAnimations()];
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = 60;
      }
      const result = {
        width: sidebar.getBoundingClientRect().width,
        inset: parseFloat(getComputedStyle(main).paddingLeft),
        contentPresent: !!sidebar.querySelector('[data-testid="start-host"]'),
        inert: sidebar.inert,
      };
      for (const animation of animations) animation.play();
      return result;
    });
    expect(midway.width).toBeGreaterThan(0);
    expect(midway.width).toBeLessThan(initialWidth);
    expect(Math.abs(midway.width - midway.inset)).toBeLessThan(2);
    expect(midway.contentPresent).toBe(true);
    expect(midway.inert).toBe(true);

    // Restore the window before the exit finishes: the same content must reopen.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(initialWidth);
    await expect(page.getByTestId("start-host")).toBeVisible();

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByTestId("sidebar-collapse").click();
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(0);
    await expect(page.getByTestId("start-host")).toHaveCount(0);
    expect(
      await sidebar.evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration)),
    ).toBeLessThan(0.001);
  });

  test("resizes navigation, restores desktop preferences, and keeps compact navigation reachable", async ({
    page,
  }) => {
    await startHost(page);
    const app = page.getByTestId("pix-app");
    const sidebar = page.getByTestId("sidebar");
    const toggle = page.getByTestId("sidebar-collapse");
    const handle = (await page.getByTestId("sidebar-resize-handle").boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, 200);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 40, 200);
    await page.mouse.up();
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(340);
    const savedPrefs = () =>
      page.evaluate(() => ({
        width: localStorage.getItem("pix.sidebarWidth"),
        collapsed: localStorage.getItem("pix.sidebarCollapsed"),
      }));
    const initialPrefs = await savedPrefs();
    const initialWidth = (await sidebar.boundingBox())!.width;

    await page.setViewportSize({ width: 880, height: 700 });
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(280);
    await expect(page.getByTestId("shell-main")).toHaveAttribute("data-rail-width", "280");
    await expect.poll(savedPrefs).toEqual(initialPrefs);

    await page.setViewportSize({ width: 800, height: 650 });
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await expect(page.getByTestId("shell-main")).toHaveAttribute("data-rail-width", "0");
    await expect(page.getByTestId("prompt-input")).toBeVisible();
    await toggle.click();
    await expect(app).toHaveAttribute("data-sidebar-mode", "overlay");
    await expect(toggle).toBeFocused();
    await expect(page.getByTestId("shell-main")).toHaveAttribute("inert", "");
    await page.keyboard.press("Shift+Tab");
    await expect
      .poll(() => sidebar.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
    await expect(toggle).not.toBeFocused();
    await page.keyboard.press("Tab");
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(app).toHaveAttribute("data-sidebar-mode", "collapsed");
    await expect(toggle).toBeFocused();
    await toggle.click();
    await page.getByTestId("sidebar-backdrop").click({ position: { x: 700, y: 100 } });
    await expect(app).toHaveAttribute("data-sidebar-mode", "collapsed");

    await toggle.click();
    await page.getByTestId("nav-settings").click();
    await expect(page.getByTestId("settings-general")).toBeVisible();
    await expect(app).toHaveAttribute("data-sidebar-mode", "collapsed");
    await toggle.click();
    await page.getByTestId("settings-nav-appearance").click();
    await expect(page.getByTestId("settings-appearance")).toBeVisible();
    await expect(app).toHaveAttribute("data-sidebar-mode", "collapsed");
    await expect.poll(savedPrefs).toEqual(initialPrefs);

    await page.setViewportSize({ width: 850, height: 700 });
    await expect(app).toHaveAttribute("data-sidebar-mode", "collapsed");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(app).toHaveAttribute("data-sidebar-mode", "docked");
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(initialWidth);
    await page.getByTestId("settings-back").click();

    // Manual collapse remains a preference, even after a temporary compact drawer.
    await toggle.click();
    await page.setViewportSize({ width: 800, height: 650 });
    await toggle.click();
    await expect(app).toHaveAttribute("data-sidebar-mode", "overlay");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(app).toHaveAttribute("data-sidebar-mode", "collapsed");
    await page.reload();
    await expect(app).toHaveAttribute("data-bootstrap-ready", "true");
    await expect(app).toHaveAttribute("data-sidebar-mode", "collapsed");
  });

  test("reflows navigation when native app zoom reduces the available viewport", async ({
    page,
    pix,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-nav-appearance").click();
    const app = page.getByTestId("pix-app");
    const scaleControl = page.getByTestId("appearance-app-scale");
    await scaleControl.click();
    await page.getByRole("option", { name: "150%" }).click();
    await expect.poll(() => pix.app.evaluate(({ window }) => window.scale)).toBe(1.5);
    await expect(app).toHaveAttribute("data-sidebar-mode", "collapsed");
    await expect(page.getByTestId("sidebar-collapse")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await scaleControl.click();
    await page.getByRole("option", { name: "100%" }).click();
    await expect(app).toHaveAttribute("data-sidebar-mode", "docked");
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "false");
  });

  test("updates the whole-app scale and keeps it after reload", async ({ page, pix }) => {
    await expect.poll(() => page.evaluate(() => window.pix.appearance.getAppScale())).toBe(100);

    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-nav-appearance").click();
    const scaleControl = page.getByTestId("appearance-app-scale");
    await scaleControl.click();
    await page.getByRole("option", { name: "120%" }).click();

    await expect.poll(() => page.evaluate(() => window.pix.appearance.getAppScale())).toBe(120);
    await expect.poll(() => pix.app.evaluate(({ window }) => window.scale)).toBe(1.2);
    await expect(scaleControl).toContainText("120%");

    await page.reload();
    await page.waitForSelector('[data-testid="pix-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });
    await expect.poll(() => page.evaluate(() => window.pix.appearance.getAppScale())).toBe(120);
    await expect.poll(() => pix.app.evaluate(({ window }) => window.scale)).toBe(1.2);
  });
});
