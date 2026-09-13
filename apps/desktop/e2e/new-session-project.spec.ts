import { resolve } from "node:path";
import { test, expect, selectWorkspace, startHost, sendPrompt } from "./fixtures.ts";

test("New session and its shortcut inherit the active project; Conversations stays unscoped", async ({
  page,
  pix,
}) => {
  await startHost(page);
  const conversationCwd = (await page.evaluate(() => window.pix.host.snapshot()))?.cwd;
  const projectPath = await selectWorkspace(pix, page, resolve(import.meta.dirname, ".."));
  await page.evaluate(
    (path) => window.pix.workspace.openPath(path, { resumeRecent: false }),
    projectPath,
  );
  await expect(page.getByTestId("start-host")).toHaveAttribute("data-target", "project");
  const trust = page.getByTestId("project-trust-dialog");
  if (await trust.isVisible()) await page.getByTestId("project-trust-dialog-later").click();
  await sendPrompt(page, "Question inside the project");
  const first = await page.evaluate(() => window.pix.host.snapshot());
  await page.getByTestId("start-host").click();
  await expect(page.getByTestId("empty-hero")).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.pix.host.snapshot()))?.sessionId)
    .not.toBe(first?.sessionId);
  await expect(page.getByTestId("workspace-name-chip")).toContainText("desktop");
  expect((await page.evaluate(() => window.pix.host.snapshot()))?.cwd).toBe(projectPath);
  await sendPrompt(page, "Second project session");
  const second = await page.evaluate(() => window.pix.host.snapshot());
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByTestId("empty-hero")).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.pix.host.snapshot()))?.sessionId)
    .not.toBe(second?.sessionId);
  expect((await page.evaluate(() => window.pix.host.snapshot()))?.cwd).toBe(projectPath);
  await expect(page.getByTestId("workspace-name-chip")).toContainText("desktop");

  const third = await page.evaluate(() => window.pix.host.snapshot());
  await page.getByTestId("open-palette").click();
  await page.getByTestId("command-new-thread").click();
  await expect
    .poll(async () => (await page.evaluate(() => window.pix.host.snapshot()))?.sessionId)
    .not.toBe(third?.sessionId);
  expect((await page.evaluate(() => window.pix.host.snapshot()))?.cwd).toBe(projectPath);

  await page.getByTestId("threads-new-btn").evaluate((el: HTMLButtonElement) => el.click());
  await expect(page.getByTestId("start-host")).toHaveAttribute("data-target", "conversation");
  await expect(page.getByTestId("workspace-name-chip")).toContainText(/Select project|选择项目/i);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.pix.host.snapshot().catch(() => undefined)))?.cwd,
    )
    .toBe(conversationCwd);
});
