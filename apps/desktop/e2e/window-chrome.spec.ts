import { test, expect, startHost, sendPrompt } from "./fixtures.ts";

test("home and conversation titlebars drag while toolbar controls remain clickable", async ({
  page,
  pix,
}, testInfo) => {
  const dragStarts = () => pix.app.evaluate(({ window }) => window.dragStarts);
  const emptyTitlebar = page.getByTestId("thread-titlebar");
  await expect(emptyTitlebar).toBeVisible();
  expect((await emptyTitlebar.boundingBox())!.height).toBe(46);
  await page.screenshot({ path: testInfo.outputPath("home-titlebar.png") });
  await emptyTitlebar.click();
  await expect.poll(dragStarts).toBe(1);

  // A right click must never move or maximize the window.
  await emptyTitlebar.click({ button: "right" });
  expect(await dragStarts()).toBe(1);
  await page.getByTestId("sidebar-collapse").click();
  await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
  await emptyTitlebar.click();
  await expect.poll(dragStarts).toBe(2);
  await page.getByTestId("sidebar-collapse").click();
  expect(await dragStarts()).toBe(2);

  await startHost(page);
  await expect(emptyTitlebar).toBeVisible();
  await emptyTitlebar.dblclick();
  await expect.poll(() => pix.app.evaluate(({ window }) => window.maximized)).toBe(true);

  await sendPrompt(page, "Say hello.");
  const header = page.getByTestId("thread-header");
  await expect(header).toBeVisible();
  const beforeTitle = await dragStarts();
  await header.locator("h2").click();
  await expect.poll(dragStarts).toBe(beforeTitle + 1);
  await page.getByTestId("thread-header-menu").click();
  await expect(page.getByTestId("thread-header-copy-id")).toBeVisible();
  expect(await dragStarts()).toBe(beforeTitle + 1);
});

test("settings, projects, packages and resources keep a draggable top area", async ({
  page,
  pix,
}) => {
  await page.evaluate(() => {
    localStorage.setItem("pix.sidebar.groupMode", "list");
    window.dispatchEvent(new Event("pix-sidebar-group-mode"));
  });
  for (const nav of ["nav-projects", "nav-packages", "nav-resources", "nav-settings"]) {
    await page.getByTestId(nav).click();
    const header = page.locator(".shell-content .drag-region").first();
    await expect(header).toBeVisible();
    const before = await pix.app.evaluate(({ window }) => window.dragStarts);
    // Top padding belongs to the titlebar, outside its interactive children.
    await header.click({ position: { x: 200, y: 2 } });
    await expect.poll(() => pix.app.evaluate(({ window }) => window.dragStarts)).toBe(before + 1);
  }
});

for (const platform of ["Win32", "Linux x86_64"]) {
  test(`${platform} image preview closes without hitting window controls`, async ({
    page,
    pix,
  }) => {
    await page.addInitScript((platform) => {
      Object.defineProperty(navigator, "platform", { value: platform });
      Object.defineProperty(navigator, "userAgent", {
        value:
          platform === "Win32"
            ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            : "Mozilla/5.0 (X11; Linux x86_64)",
      });
    }, platform);
    await page.reload();
    await startHost(page);
    await pix.app.evaluate(
      ({ dialog }, paths) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: paths }),
        });
      },
      pix.attachmentPaths.filter((file) => file.endsWith("photo.png")),
    );
    await page.getByTestId("composer-attach").click();
    await page.getByTestId("composer-attach-files").click();

    for (const width of [1100, 600]) {
      await page.setViewportSize({ width, height: 800 });
      await page.getByTestId("attachment-image-preview").click();
      await expect(page.getByTestId("image-preview-dialog")).toBeVisible();
      const previewClose = page.getByTestId("content-preview-close");
      const previewBox = (await previewClose.boundingBox())!;
      const captionBox = (await page.getByTestId("window-caption-buttons").boundingBox())!;
      expect(previewBox.x + previewBox.width).toBeLessThan(captionBox.x);
      await previewClose.click();
      await expect(page.getByTestId("image-preview-dialog")).toBeHidden();
      expect(await pix.app.evaluate(({ window }) => window.closed)).toBe(false);
    }
  });
}

for (const platform of ["Win32", "Linux x86_64", "MacIntel"]) {
  test(`${platform} window controls do not depend on the runtime connection`, async ({
    page,
    pix,
  }, testInfo) => {
    await page.addInitScript((platform) => {
      Object.defineProperty(navigator, "platform", { value: platform });
      Object.defineProperty(navigator, "userAgent", {
        value:
          platform === "Win32"
            ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            : platform === "MacIntel"
              ? "Mozilla/5.0 (Macintosh; Intel Mac OS X)"
              : "Mozilla/5.0 (X11; Linux x86_64)",
      });
      // Harness init scripts have no guaranteed ordering: intercept at DOM readiness,
      // before the renderer module loads and first mounts the window controls.
      document.addEventListener("readystatechange", () => {
        const scope = window as any;
        if (document.readyState !== "interactive") return;
        const invoke = scope.__TAURI_INTERNALS__.invoke;
        scope.__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
          if (command === "pix_invoke" && args.channel === "pix:app:get-runtime") {
            return Promise.reject(new Error("Runtime unavailable in window chrome regression"));
          }
          return invoke(command, args);
        };
      });
    }, platform);
    await page.reload();
    await expect(page.getByTestId("pix-app")).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.pix.app.getRuntime().then(
          () => "connected",
          () => "unavailable",
        ),
      ),
    ).toBe("unavailable");
    const controls = page.getByTestId("window-caption-buttons");
    if (platform === "MacIntel") {
      await expect(controls).toHaveCount(0);
      await expect(page.locator("html")).not.toHaveAttribute("data-custom-window-controls");
      return;
    }

    await expect(controls).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-custom-window-controls", "true");
    await page.screenshot({ path: testInfo.outputPath("window-controls.png") });
    if (platform === "Win32") expect((await controls.boundingBox())!.width).toBe(138);
    const maximize = page.getByTestId("window-maximize");
    await maximize.click();
    await expect(maximize).toHaveAccessibleName("Restore");
    expect(await pix.app.evaluate(({ window }) => window.maximized)).toBe(true);
    await maximize.click();
    await expect(maximize).toHaveAccessibleName("Maximize");
    expect(await pix.app.evaluate(({ window }) => window.maximized)).toBe(false);

    // Native resize/snap changes must also update the restore icon and label.
    await page.evaluate(() =>
      (window as any).__pixTestEvent({
        channel: "pix:window:state",
        payload: { isMaximized: true },
      }),
    );
    await expect(maximize).toHaveAccessibleName("Restore");
    await page.getByTestId("window-minimize").click();
    expect(await pix.app.evaluate(({ window }) => window.minimized)).toBe(true);
    await page.getByTestId("window-close").click();
    if (platform === "Win32") {
      await expect(page.getByTestId("window-close-dialog")).toBeVisible();
      expect(await pix.app.evaluate(({ window }) => window.closed)).toBe(false);
      await page.getByTestId("window-close-action-quit").check();
      await page.getByTestId("window-close-confirm").click();
    }
    await expect.poll(() => pix.app.evaluate(({ window }) => window.closed)).toBe(true);
    expect(await pix.app.evaluate(({ window }) => window.dragStarts)).toBe(0);
  });
}
