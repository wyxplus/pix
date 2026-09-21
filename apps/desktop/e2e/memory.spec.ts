import { test, expect } from "./fixtures.ts";

test("memory settings persist, gate writes, and support forgetting while disabled", async ({
  pix,
  page,
}) => {
  await page.evaluate(async () => {
    await window.pix.trust.set(true);
    await window.pix.agent.prompt("hello");
  });
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-memory").click();
  await expect(page.getByTestId("settings-memory")).toBeVisible();
  const longTerm = page.getByTestId("memory-long-term");
  const shortTerm = page.getByTestId("memory-short-term");
  await expect(longTerm).toHaveAttribute("aria-checked", "false");
  await expect(shortTerm).toHaveAttribute("aria-checked", "false");
  await longTerm.click();
  const editor = page.getByRole("textbox", { name: /Memory content|记忆内容/ });
  await expect(editor).toBeEnabled();
  await editor.fill("Use concise Chinese explanations — memory e2e");
  await page.getByRole("button", { name: /^(Remember|记住)$/ }).click();
  await expect(page.locator("article").filter({ hasText: "memory e2e" })).toBeVisible();
  if (process.env.PIX_MEMORY_SCREENSHOT)
    await page.screenshot({ path: process.env.PIX_MEMORY_SCREENSHOT, fullPage: true });
  await longTerm.click();
  await expect(editor).toBeDisabled();
  await expect(page.locator("article").filter({ hasText: "memory e2e" })).toBeVisible();
  const restarted = await pix.restart();
  await restarted.getByTestId("nav-settings").click();
  await restarted.getByTestId("settings-nav-memory").click();
  await expect(restarted.getByTestId("memory-long-term")).toHaveAttribute("aria-checked", "false");
  const saved = restarted.locator("article").filter({ hasText: "memory e2e" });
  await expect(saved).toBeVisible();
  await saved.getByRole("button", { name: /Forget|遗忘/ }).click();
  await expect(saved).toHaveCount(0);
});

test("native transfer displays the destination and conversion preview before delivery", async ({
  pix,
  page,
}) => {
  await page.evaluate((cwd) => window.pix.host.start({ cwd, force: true }), pix.workspace);
  await page.evaluate(async () => {
    await window.pix.trust.set(true);
    await window.pix.agent.prompt("hello transfer preview");
    const preview = {
      id: "test-transfer",
      target: "codex" as const,
      version: "0.155.0-alpha.9.2",
      directory: "/chosen/codex-data",
      cwd: "/selected/project",
      sessions: [{ sourceId: "source", branch: "leaf", targetId: "target" }],
      warnings: ["No model turn is executed."],
      delivered: false,
    };
    window.pix.data.archives.list = async () => [
      {
        id: "fixture",
        createdAt: "2026-09-20T00:00:00Z",
        memoryCount: 0,
        sessions: [{ id: "source", title: "Transfer fixture" }],
        warnings: [],
        attachmentCount: 1,
        sideChatCount: 1,
      },
    ];
    window.pix.data.archives.previewNative = async () => preview;
    window.pix.data.archives.deliverNative = async () => {
      document.documentElement.dataset.transferDelivered = "yes";
      return { ...preview, delivered: true };
    };
  });
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-memory").click();
  await page
    .getByRole("button", { name: /Preview transfer to Codex CLI|预览迁出到 Codex CLI/ })
    .click();
  const preview = page.getByTestId("native-transfer-preview");
  await expect(preview).toContainText("/chosen/codex-data");
  await expect(preview).toContainText("0.155.0-alpha.9.2");
  expect(await page.locator("html").getAttribute("data-transfer-delivered")).toBeNull();
  await preview.getByRole("button", { name: /Confirm delivery|确认写入目标目录/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-transfer-delivered", "yes");
  await expect(preview.getByRole("button", { name: /^(Delivered|已交付)$/ })).toBeDisabled();
});
