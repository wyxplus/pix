import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, sendPrompt } from "./fixtures.ts";

test.use({ conversationWorkspace: true });

test("local file links show full paths and dispatch open/reveal with visible failures", async ({
  page,
  pix,
}, testInfo) => {
  await mkdir(join(pix.workspace, "output"));
  const report = join(pix.workspace, "output", "季度报告 2026 v2.docx");
  await writeFile(report, "document fixture");
  const canonical = await realpath(report);
  const opened: string[] = [];
  const revealed: string[] = [];
  pix.app.native.shell.openPath = async (path) => {
    opened.push(path);
    return "";
  };
  pix.app.native.shell.reveal = async (path) => {
    revealed.push(path);
  };
  await page.evaluate((cwd) => window.pix.host.start({ cwd, force: true }), pix.workspace);
  await page.reload();
  await expect(page.getByTestId("pix-app")).toHaveAttribute("data-bootstrap-ready", "true");
  await sendPrompt(page, "Render the local file links fixture.");

  const link = page.getByRole("link", { name: "季度报告.docx", exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("title", /output[/\\]季度报告 2026 v2\.docx$/);
  const fullPath = (await link.getAttribute("title"))!;
  const actions = page.getByRole("button", { name: /(?:File actions|文件操作): 季度报告\.docx/ });

  for (const theme of ["light", "dark"]) {
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-nav-appearance").click();
    await page.getByTestId("appearance-theme").click();
    await page.getByRole("option", { name: theme === "dark" ? /Dark|深色/ : /Light|浅色/ }).click();
    await page.getByTestId("settings-back").click();
    await expect(page.getByTestId("pix-app")).toHaveAttribute("data-theme", theme);
    await expect(link).toHaveCSS("color", "rgb(58, 131, 247)");
    await page.mouse.move(0, 0);
    await link.hover();
    await expect(page.getByRole("tooltip")).toHaveText(fullPath);
    await page.screenshot({ path: testInfo.outputPath(`file-link-${theme}.png`) });
    await page.keyboard.press("Escape");
  }
  await link.click();
  await expect.poll(() => opened).toEqual([canonical]);
  await actions.click();
  await page.screenshot({ path: testInfo.outputPath("file-link-menu.png") });
  await page.getByRole("menuitem", { name: /Show in folder|打开所在位置/ }).click();
  await expect.poll(() => revealed).toEqual([canonical]);
  await actions.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();

  // Focusing the link gives keyboard users the same full path.
  await link.focus();
  await expect(page.getByRole("tooltip")).toHaveText(fullPath);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect.poll(() => opened.length).toBe(2);

  pix.app.native.shell.openPath = async () => {
    throw new Error("No associated application");
  };
  await link.click();
  await expect(
    link
      .locator("xpath=ancestor::span[contains(@class,'content-file-reference')]")
      .getByRole("alert"),
  ).toContainText(/No associated application|没有关联的应用/);
  pix.app.native.shell.openPath = async (path) => {
    opened.push(path);
    return "";
  };
  await actions.click();
  await page.getByRole("menuitem", { name: /^(Open file|打开文件)$/ }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => opened.length).toBe(3);

  await rm(report);
  await link.click();
  await expect(page.getByRole("alert")).toContainText(/File no longer exists|文件已不存在/);
  await expect(page.getByRole("alert")).not.toContainText(/pix:workspace|node:/);
  expect(opened).toHaveLength(3);

  const windows = page.getByRole("link", { name: "Windows report", exact: true });
  await expect(windows).toHaveAttribute(
    "title",
    /^C:\/Users\/Alice\/Documents\/.*报告 2026 v2.xlsx$/,
  );
  await expect(page.getByRole("link", { name: "Shared report" })).toHaveAttribute(
    "title",
    "//server/share/report.pptx",
  );
  await page.setViewportSize({ width: 440, height: 800 });
  await windows.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText((await windows.getAttribute("title"))!);
  const bounds = await tooltip.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(440);
  await page.screenshot({ path: testInfo.outputPath("file-link-narrow.png") });

  const system = pix.fakeModel.requests[0]?.messages?.find((message) => message.role === "system");
  expect(JSON.stringify(system?.content)).toContain(
    "Pix desktop renders local Markdown file links",
  );
});
