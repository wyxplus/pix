import type { Locator } from "@playwright/test";
import { test, expect, startHost, sendPrompt, conversationSessionButtons } from "./fixtures.ts";

async function placeCaret(input: Locator, position: number) {
  await input.evaluate((el: HTMLTextAreaElement, pos) => {
    el.focus();
    el.setSelectionRange(pos, pos);
  }, position);
}

async function expectCaret(input: Locator, position: number) {
  await expect
    .poll(() => input.evaluate((el: HTMLTextAreaElement) => el.selectionStart))
    .toBe(position);
}

test("recalls only this conversation's prompts and resets after sending and switching", async ({
  page,
}) => {
  await startHost(page);
  const input = page.getByTestId("prompt-input");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("");
  await input.fill("Unsent without history");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Unsent without history");

  await sendPrompt(page, "History first question");
  await sendPrompt(page, "History second question\nwith another line");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("History second question\nwith another line");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("History first question");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("History first question");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("History second question\nwith another line");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("timeline").locator('[data-kind="user"]')).toHaveCount(2);

  await input.press("ArrowUp");
  await input.press("Enter");
  await expect(page.getByTestId("host-status").first()).toContainText("Agent settled");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("History second question\nwith another line");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("");

  await page.getByTestId("start-host").click();
  await expect(page.getByTestId("empty-hero")).toBeVisible();
  await expect(page.getByTestId("send-prompt")).toBeDisabled();
  await input.fill("New conversation draft");
  await expect(page.getByTestId("send-prompt")).toBeEnabled();
  await input.press("ArrowUp");
  await expect(input).toHaveValue("New conversation draft");
  await sendPrompt(page, "Separate conversation question");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Separate conversation question");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Separate conversation question");
  await input.fill("");
  await conversationSessionButtons(page).filter({ hasText: "History first question" }).click();
  await expect(page.getByTestId("timeline")).toContainText("History first question");
  await expect(page.getByTestId("timeline").locator('[data-kind="user"]').last()).toBeVisible();
  await expect(page.getByTestId("host-status").first()).toContainText("Agent Host ready");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("History second question\nwith another line");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("");
});

test("uses two-step boundaries for edits and restores the unsent multiline draft", async ({
  page,
}) => {
  await startHost(page);
  await sendPrompt(page, "First sent question");
  await sendPrompt(page, "Second sent question");
  const input = page.getByTestId("prompt-input");
  const draft = "草稿第一行\n草稿中间行\n草稿最后一行";
  await input.fill(draft);
  await placeCaret(input, draft.indexOf("中间") + 1);
  await input.press("ArrowUp");
  await expect(input).toHaveValue(draft);
  await placeCaret(input, 3);
  await input.press("ArrowUp");
  await expectCaret(input, 0);
  await expect(input).toHaveValue(draft);
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Second sent question");
  const edit = "Edited first line\nEdited last line";
  await input.fill(edit);
  await placeCaret(input, 3);
  await input.press("ArrowUp");
  await expectCaret(input, 0);
  await expect(input).toHaveValue(edit);
  await input.press("ArrowUp");
  await expect(input).toHaveValue("First sent question");
  await input.press("ArrowDown");
  await expect(input).toHaveValue(edit);
  await placeCaret(input, edit.lastIndexOf("\n") + 3);
  await input.press("ArrowDown");
  await expectCaret(input, edit.length);
  await expect(input).toHaveValue(edit);
  await input.press("ArrowDown");
  await expect(input).toHaveValue(draft);
  await expect(page.getByTestId("timeline").locator('[data-kind="user"]')).toHaveCount(2);
});

test("respects soft-wrapped lines, selections, modifiers, IME and suggestion menus", async ({
  page,
}) => {
  await startHost(page);
  await sendPrompt(page, "Previously sent question");
  const input = page.getByTestId("prompt-input");
  await page.setViewportSize({ width: 900, height: 800 });
  const wrapped = "自动换行的中文草稿内容需要保留正常光标移动。".repeat(12);
  await input.fill(wrapped);
  await placeCaret(input, Math.floor(wrapped.length / 2));
  await input.press("ArrowUp");
  await expect(input).toHaveValue(wrapped);
  expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBeGreaterThan(0);
  await placeCaret(input, 3);
  await input.press("ArrowDown");
  await expect(input).toHaveValue(wrapped);
  expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBeLessThan(
    wrapped.length,
  );

  await placeCaret(input, wrapped.length - 3);
  await input.press("ArrowDown");
  await expectCaret(input, wrapped.length);
  await expect(input).toHaveValue(wrapped);
  await placeCaret(input, 3);
  await input.press("ArrowUp");
  await expectCaret(input, 0);
  await expect(input).toHaveValue(wrapped);
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Previously sent question");
  await input.press("ArrowDown");
  await expect(input).toHaveValue(wrapped);

  await input.fill("Keep this draft");
  await placeCaret(input, 0);
  await input.press("Shift+ArrowDown");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Keep this draft");
  await placeCaret(input, 0);
  await input.press("Control+ArrowUp");
  await expect(input).toHaveValue("Keep this draft");
  await input.dispatchEvent("keydown", { key: "ArrowUp", isComposing: true });
  await input.dispatchEvent("keydown", { key: "ArrowUp", keyCode: 229 });
  await expect(input).toHaveValue("Keep this draft");
  await input.fill("/");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("/");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("/");
  await input.fill("@");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("@");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("@");
});

test("side conversations recall their own prompts without replacing the main draft", async ({
  page,
}) => {
  await startHost(page);
  await sendPrompt(page, "Main conversation question");
  const main = page.getByTestId("prompt-input");
  await main.fill("Unsent main draft");
  await page
    .locator("[data-selection-message] p")
    .first()
    .evaluate((element) => {
      (document.activeElement as HTMLElement | null)?.blur();
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
  await page.getByTestId("selection-ask").click();
  const input = page.getByTestId("selection-side-chat-input");
  await input.fill("Side conversation question");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Side conversation question");
  await input.press("Enter");
  await expect(
    page.getByTestId("selection-side-chat").locator('[data-role="assistant"]'),
  ).toContainText("Pix fake model response.");
  await expect(page.getByTestId("selection-side-chat-stop")).toBeHidden();
  await input.fill("Unsent side draft");
  await placeCaret(input, 0);
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Side conversation question");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Side conversation question");
  await expect(main).toHaveValue("Unsent main draft");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("Unsent side draft");
});
