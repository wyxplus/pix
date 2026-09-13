import { test, expect, startHost, sendPrompt, conversationSessionButtons } from "./fixtures.ts";

test("keeps a draft unsent until a new conversation has its own session identity", async ({
  page,
}) => {
  await startHost(page);
  await sendPrompt(page, "Original conversation");
  await expect(page.getByTestId("timeline").locator('[data-kind="assistant"]')).toBeVisible();
  await page.evaluate(() => {
    const original = window.pix.session.createBlankConversation.bind(window.pix.session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    window.pix.session.createBlankConversation = async () => {
      await gate;
      return original();
    };
    (window as Window & { __releaseSessionCreation?: () => void }).__releaseSessionCreation =
      release;
  });
  await page.getByTestId("start-host").click();
  const input = page.getByTestId("prompt-input");
  const send = page.getByTestId("send-prompt");
  await input.fill("Draft for the new conversation");
  await expect(send).toBeDisabled();
  await input.press("Enter");
  await expect(input).toHaveValue("Draft for the new conversation");
  await expect(page.getByTestId("timeline").locator('[data-kind="user"]')).toHaveCount(0);
  await page.evaluate(() => {
    (window as Window & { __releaseSessionCreation?: () => void }).__releaseSessionCreation?.();
  });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId("timeline").locator('[data-kind="assistant"]')).toBeVisible();
  await expect(
    conversationSessionButtons(page).filter({ hasText: "Draft for the new conversation" }),
  ).toHaveCount(1);
  await conversationSessionButtons(page).filter({ hasText: "Original conversation" }).click();
  await expect(page.getByTestId("timeline").locator('[data-kind="user"]')).toContainText(
    "Original conversation",
  );
  await conversationSessionButtons(page)
    .filter({ hasText: "Draft for the new conversation" })
    .click();
  await expect(page.getByTestId("timeline").locator('[data-kind="user"]')).toContainText(
    "Draft for the new conversation",
  );
});
