import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect, startHost, sendPrompt, conversationSessionButtons } from "./fixtures.ts";

test("side composer shares file, folder, model and effort controls without changing the main composer", async ({
  page,
  pix,
}, testInfo) => {
  const configPath = join(pix.agentDir, "models.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.providers["pix-fake"].models.push({
    ...config.providers["pix-fake"].models[0],
    id: "pix-fake-alt",
    name: "Pix Alt Model",
    reasoning: true,
    input: ["text", "image"],
  });
  await writeFile(configPath, JSON.stringify(config));
  await startHost(page);
  await sendPrompt(page, "Hello selection");
  const main = page.getByTestId("composer-root");
  await main.getByTestId("prompt-input").fill("主会话草稿");
  await page.evaluate(
    (path) => window.dispatchEvent(new CustomEvent("pix:native-drop", { detail: [path] })),
    pix.attachmentPaths[6]!,
  );
  await expect(main.getByTestId("composer-attachment-card")).toHaveCount(1);
  const mainModel = await main.getByTestId("model-select").inputValue();

  await selectText(page, page.locator("[data-selection-message] p").first());
  await page.getByTestId("selection-ask").click();
  const panel = page.getByTestId("selection-side-chat");
  const composer = panel.getByTestId("side-chat-composer");
  await composer.getByTestId("model-select-wrap").click();
  await page.getByTestId("composer-model-list-trigger").click();
  await page
    .getByTestId("composer-model-menu")
    .getByRole("menuitemradio", { name: "Pix Alt Model" })
    .click();
  await page.getByTestId("composer-model-menu").getByRole("slider").focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(composer.getByTestId("model-select-label")).toHaveText("Pix Alt Model");
  await expect(composer.getByTestId("thinking-select")).toHaveValue("high");
  await expect(main.getByTestId("model-select")).toHaveValue(mainModel);

  const filePath = join(pix.workspace, "fixture.txt");
  const imagePath = pix.attachmentPaths[1]!;
  await pix.app.evaluate(
    ({ dialog }, paths) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: paths }),
      });
    },
    [filePath, imagePath],
  );
  await composer.getByTestId("composer-attach").click();
  await page.getByTestId("composer-attach-files").click();
  await expect(composer.getByTestId("composer-attachment-card")).toHaveCount(2);
  await pix.app.evaluate(({ dialog }, path) => {
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [path] }),
    });
  }, pix.workspace);
  await composer.getByTestId("composer-attach").click();
  await page.getByTestId("composer-attach-folders").click();
  await expect(composer.getByTestId("composer-attachment-card")).toHaveCount(3);
  await expect(main.getByTestId("composer-attachment-card")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("side-composer-files-model.png") });

  await composer
    .getByTestId("selection-side-chat-input")
    .fill("Use the tool to read the attached file");
  await composer.getByTestId("selection-side-chat-send").click();
  await expect(panel.locator('[data-role="assistant"]')).toContainText("Tool result received.");
  await expect(composer.getByTestId("selection-side-chat-stop")).toBeHidden();
  const request = pix.fakeModel.requests.at(-1)!;
  expect(request.model).toBe("pix-fake-alt");
  expect(request.reasoning_effort).toBe("high");
  expect(JSON.stringify(request.messages)).toContain("data:image/png;base64,");
  expect(JSON.stringify(request.messages?.filter((message) => message.role === "tool"))).toContain(
    "Pix Playwright E2E fixture",
  );
  expect(JSON.stringify(request.messages)).not.toContain("主会话草稿");
  await expect(composer.getByTestId("composer-attachment-card")).toHaveCount(0);
  await expect(
    panel.locator('[data-role="user"]').getByTestId("composer-attachment-card"),
  ).toHaveCount(3);
  await expect(main.getByTestId("prompt-input")).toHaveValue("主会话草稿");
  await expect(main.getByTestId("composer-attachment-card")).toHaveCount(1);
  await expect(main.getByTestId("model-select")).toHaveValue(mainModel);

  // A native drop is routed to exactly one composer, including while both are mounted.
  await composer.getByTestId("selection-side-chat-input").focus();
  await page.evaluate(
    (path) => window.dispatchEvent(new CustomEvent("pix:native-drop", { detail: [path] })),
    imagePath,
  );
  await expect(composer.getByTestId("composer-attachment-card")).toHaveCount(1);
  await expect(main.getByTestId("composer-attachment-card")).toHaveCount(1);
  await composer.getByTestId("selection-side-chat-input").fill("未发送的侧边草稿");
  await panel.getByTestId("selection-side-chat-close").click();
  await confirmSideClose(page);
  await expect(page.getByTestId("thread-header-side-chat")).toBeHidden();
  await selectText(page, page.locator("[data-selection-message] p").first());
  await page.getByTestId("selection-ask").click();
  await expect(composer.getByTestId("selection-side-chat-input")).toHaveValue("");
  await expect(composer.getByTestId("composer-attachment-card")).toHaveCount(0);
  await expect(panel.locator('[data-role="user"]')).toHaveCount(0);
  await expect(composer.getByTestId("model-select")).toHaveValue(mainModel);
  await composer.getByTestId("selection-side-chat-input").press("Escape");
  await confirmSideClose(page);
  await expect(panel).toBeHidden();
});

async function expectSideAnswers(panel: Locator, count: number) {
  await expect(panel.locator('[data-role="assistant"]')).toHaveCount(count);
  await expect(panel.getByTestId("selection-side-chat-stop")).toBeHidden();
  await expect(panel.locator('[data-role="assistant"]').last()).toContainText(
    "Pix fake model response.",
  );
}

async function selectText(page: Page, target: Locator, menuTestId = "text-selection-menu") {
  await target.scrollIntoViewIfNeeded();
  await target.evaluate((element) => {
    (document.activeElement as HTMLElement | null)?.blur();
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByTestId(menuTestId)).toBeVisible();
}

async function confirmSideClose(page: Page) {
  const dialog = page.getByTestId("side-chat-close-confirm");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("无法恢复");
  await expect(dialog.getByTestId("confirm-dialog-confirm")).toHaveAttribute(
    "data-variant",
    "destructive",
  );
  await dialog.getByTestId("confirm-dialog-confirm").click();
  await expect(dialog).toBeHidden();
}

test.describe("persistent side chats", () => {
  test.use({ conversationWorkspace: true });
  test("side chat tabs survive session/settings navigation and full app restarts", async ({
    page,
    pix,
  }, testInfo) => {
    const configPath = join(pix.agentDir, "models.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.providers["pix-fake"].models.push({
      ...config.providers["pix-fake"].models[0],
      id: "pix-fake-alt",
      name: "Pix Alt Model",
      reasoning: true,
    });
    await writeFile(configPath, JSON.stringify(config));
    await page.evaluate((cwd) => window.pix.host.start({ cwd, force: true }), pix.workspace);
    await page.reload();
    await expect(page.getByTestId("pix-app")).toHaveAttribute("data-bootstrap-ready", "true");
    await sendPrompt(page, "Main alpha");
    const source = page.getByTestId("timeline").locator("[data-selection-message] p").first();
    await selectText(page, source);
    await page.getByTestId("selection-ask").click();
    const panel = page.getByTestId("selection-side-chat");
    const input = panel.getByTestId("selection-side-chat-input");
    const composer = panel.getByTestId("side-chat-composer");
    await input.fill("Side alpha");
    await input.press("Enter");
    await expectSideAnswers(panel, 1);
    await input.fill("Alpha draft");
    await page.evaluate(
      (path) => window.dispatchEvent(new CustomEvent("pix:native-drop", { detail: [path] })),
      pix.attachmentPaths[6]!,
    );
    await expect(composer.getByTestId("composer-attachment-card")).toHaveCount(1);
    await composer.getByTestId("model-select-wrap").click();
    await page.getByTestId("composer-model-list-trigger").click();
    await page
      .getByTestId("composer-model-menu")
      .getByRole("menuitemradio", { name: "Pix Alt Model" })
      .click();
    await page.getByTestId("composer-model-menu").getByRole("slider").focus();
    await page.keyboard.press("End");
    await page.keyboard.press("Escape");

    await selectText(page, source);
    await page.getByTestId("selection-ask").click();
    await expect(panel.getByTestId("side-chat-tab")).toHaveCount(2);
    await expect(input).toHaveValue("");
    await expect(composer.getByTestId("composer-attachment-card")).toHaveCount(0);
    await expect(composer.getByTestId("model-select-label")).toHaveText("Pix Fake Model");
    await input.fill("abort beta");
    await input.press("Enter");
    await expect(panel.locator('[data-role="assistant"]')).toContainText("Waiting for abort...");
    await input.fill("Beta draft");

    const alpha = panel.getByRole("tab", { name: "Side alpha", exact: true });
    const beta = panel.getByRole("tab", { name: /abort beta/ });
    await alpha.click();
    await expect(input).toHaveValue("Alpha draft");
    await expect(composer.getByTestId("composer-attachment-card")).toHaveCount(1);
    await expect(composer.getByTestId("model-select-label")).toHaveText("Pix Alt Model");
    await expect(composer.getByTestId("thinking-select")).toHaveValue("high");
    await alpha.focus();
    await page.keyboard.press("ArrowRight");
    await expect(beta).toHaveAttribute("aria-selected", "true");
    await expect(input).toHaveValue("Beta draft");
    await page.screenshot({
      path: testInfo.outputPath("side-chat-tabs.png"),
      animations: "disabled",
    });

    // A running side request remains attached to the old main conversation while navigating.
    await page.getByTestId("start-host").click();
    await expect(panel).toBeHidden();
    await expect(page.getByTestId("side-chat-close-confirm")).toBeHidden();
    await sendPrompt(page, "Main gamma");
    await selectText(
      page,
      page.getByTestId("timeline").locator("[data-selection-message] p").first(),
    );
    await page.getByTestId("selection-ask").click();
    await expect(panel.getByTestId("side-chat-tab")).toHaveCount(1);
    await input.fill("Side gamma");
    await input.press("Enter");
    await expectSideAnswers(panel, 1);
    await input.fill("Gamma draft");
    await conversationSessionButtons(page).filter({ hasText: "Main alpha" }).click();
    await expect(panel.getByTestId("side-chat-tab")).toHaveCount(2);
    await expect(beta).toHaveAttribute("aria-selected", "true");
    await expect(input).toHaveValue("Beta draft");
    await expect(panel.getByTestId("selection-side-chat-stop")).toBeVisible();
    await alpha.click();
    await page.getByRole("button", { name: "系统设置", exact: true }).click();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await page.getByRole("button", { name: "返回应用", exact: true }).click();
    await expect(alpha).toHaveAttribute("aria-selected", "true");
    await expect(input).toHaveValue("Alpha draft");
    await expect(composer.getByTestId("composer-attachment-card")).toHaveCount(1);
    await beta.click();

    const archivePath = join(pix.root, "tauri-userData", "side-chats.json");
    await expect
      .poll(async () => {
        const archive = JSON.parse(await readFile(archivePath, "utf8"));
        return Object.values(archive.chats).map((chat: any) => chat.draft);
      })
      .toEqual(["Alpha draft", "Beta draft", "Gamma draft"]);
    const beforeRestartRequests = pix.fakeModel.requests.length;
    let current = await pix.restart();
    current.setDefaultTimeout(15_000);
    await conversationSessionButtons(current).filter({ hasText: "Main alpha" }).click();
    let restored = current.getByTestId("selection-side-chat");
    await expect(restored.getByTestId("side-chat-tab")).toHaveCount(2);
    await expect(restored.getByRole("tab", { name: /abort beta/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(restored.getByTestId("selection-side-chat-input")).toHaveValue("Beta draft");
    await expect(restored.getByRole("status")).toContainText("已停止生成");
    await expect(restored.locator('[data-role="assistant"]')).toContainText("Waiting for abort...");
    expect(pix.fakeModel.requests.length).toBe(beforeRestartRequests);
    await restored.getByRole("tab", { name: "Side alpha", exact: true }).click();
    await expect(restored.getByTestId("selection-side-chat-input")).toHaveValue("Alpha draft");
    await expect(
      restored.getByTestId("side-chat-composer").getByTestId("composer-attachment-card"),
    ).toHaveCount(1);
    await expect(restored.getByTestId("model-select-label")).toHaveText("Pix Alt Model");
    await expect(restored.getByTestId("thinking-select")).toHaveValue("high");

    // Close the inactive tab: cancel keeps both; confirming removes only that tab.
    await restored.getByTestId("side-chat-tab-close").nth(1).click();
    await current
      .getByTestId("side-chat-close-confirm")
      .getByTestId("confirm-dialog-cancel")
      .click();
    await expect(restored.getByTestId("side-chat-tab")).toHaveCount(2);
    await expect(restored.getByRole("tab", { name: "Side alpha", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await restored.getByTestId("side-chat-tab-close").nth(1).click();
    await confirmSideClose(current);
    await expect(restored.getByTestId("side-chat-tab")).toHaveCount(1);
    await expect(restored.getByTestId("selection-side-chat-input")).toHaveValue("Alpha draft");
    await restored.getByTestId("selection-side-chat-input").press("Enter");
    await expectSideAnswers(restored, 2);
    expect(pix.fakeModel.requests.at(-1)!.model).toBe("pix-fake-alt");
    expect(JSON.stringify(pix.fakeModel.requests.at(-1)!.messages)).toContain("Side alpha");
    await conversationSessionButtons(current).filter({ hasText: "Main gamma" }).click();
    await expect(restored.getByTestId("side-chat-tab")).toHaveCount(1);
    await expect(restored.getByTestId("selection-side-chat-input")).toHaveValue("Gamma draft");
    await expect
      .poll(async () => Object.keys(JSON.parse(await readFile(archivePath, "utf8")).chats).length)
      .toBe(2);
    current = await pix.restart();
    current.setDefaultTimeout(15_000);
    await conversationSessionButtons(current).filter({ hasText: "Main alpha" }).click();
    restored = current.getByTestId("selection-side-chat");
    await expect(restored.getByTestId("side-chat-tab")).toHaveCount(1);
    await expectSideAnswers(restored, 2);
    await conversationSessionButtons(current).filter({ hasText: "Main gamma" }).click();
    await expect(restored.getByTestId("selection-side-chat-input")).toHaveValue("Gamma draft");
  });
});

test("side chat tab overflow remains usable with keyboard navigation in a narrow panel", async ({
  page,
}, testInfo) => {
  await startHost(page);
  await sendPrompt(page, "Hello selection");
  const source = page.getByTestId("timeline").locator("[data-selection-message] p").first();
  const panel = page.getByTestId("selection-side-chat");
  for (let index = 0; index < 5; index++) {
    await selectText(page, source);
    await page.getByTestId("selection-ask").click();
    await expect(panel.getByTestId("side-chat-tab")).toHaveCount(index + 1);
    await expect(panel.getByTestId("selection-side-chat-input")).toBeFocused();
    await panel.getByTestId("selection-side-chat-input").fill(`草稿 ${index + 1}`);
  }
  await page.setViewportSize({ width: 600, height: 800 });
  const tabs = panel.getByTestId("side-chat-tab");
  await tabs.last().focus();
  await page.keyboard.press("Home");
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByTestId("selection-side-chat-input")).toHaveValue("草稿 1");
  await page.keyboard.press("End");
  await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByTestId("selection-side-chat-input")).toHaveValue("草稿 5");
  await expect
    .poll(async () => {
      const selected = await tabs.last().boundingBox();
      const bounds = await panel.boundingBox();
      return (
        !!selected &&
        !!bounds &&
        selected.x >= bounds.x &&
        selected.x + selected.width <= bounds.x + bounds.width
      );
    })
    .toBe(true);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.getByTestId("pix-app")).toHaveAttribute("data-theme", "dark");
  const foreground = await panel.evaluate((element) => getComputedStyle(element).color);
  await expect(tabs.last()).toHaveCSS("color", foreground);
  await page.screenshot({
    path: testInfo.outputPath("side-chat-tabs-narrow-dark.png"),
    animations: "disabled",
  });
  await panel.getByTestId("selection-side-chat-close").click();
  await confirmSideClose(page);
  await expect(tabs).toHaveCount(4);
  await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByTestId("selection-side-chat-input")).toHaveValue("草稿 4");
});

test("selected response actions preserve draft, explain, and chat independently", async ({
  page,
  pix,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await startHost(page);
  await sendPrompt(page, "Hello selection");
  const source = page.locator("[data-selection-message] p").first();
  const passage = await source.innerText();
  const transcript = await page
    .getByTestId("timeline")
    .locator('[data-kind="user"], [data-kind="assistant"]')
    .allTextContents();
  const composer = page.getByTestId("prompt-input");
  await composer.fill("保留我的草稿");
  await selectText(page, source);
  await expect(page.getByTestId("text-selection-menu").getByRole("menuitem")).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("selection-menu.png") });
  await page.getByTestId("selection-add").click();
  await expect(composer).toHaveValue(`保留我的草稿\n\n${passage}\n\n`);
  await expect(composer).toBeFocused();
  const savedDraft = await composer.inputValue();

  await selectText(page, source);
  await page.getByTestId("selection-ask").click();
  const panel = page.getByTestId("selection-side-chat");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("selection-side-chat-quote")).toHaveText(passage);
  const input = panel.getByTestId("selection-side-chat-input");
  await expect(input).toBeFocused();
  await input.fill("What does this passage mean?");
  await input.press("Enter");
  await expectSideAnswers(panel, 1);
  await input.fill("Give a concrete example.");
  await input.press("Enter");
  await expectSideAnswers(panel, 2);
  const request = pix.fakeModel.requests.at(-1)!;
  const payload = request.messages?.findLast((message) => message.role === "user")?.content;
  expect(JSON.stringify(payload)).toContain("Give a concrete example.");
  expect(
    request.messages
      ?.filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : (message.content as { text?: string }[]).map((part) => part.text ?? "").join(""),
      ),
  ).toEqual(["What does this passage mean?", "Give a concrete example."]);
  expect(request.messages?.find((message) => message.role === "assistant")?.content).toBe(
    "Pix fake model response.",
  );
  const context = request.messages?.find((message) => message.role === "system")?.content;
  expect(String(context)).toContain(passage);
  expect(String(context)).toContain("Hello selection");
  expect(
    await page
      .getByTestId("timeline")
      .locator('[data-kind="user"], [data-kind="assistant"]')
      .allTextContents(),
  ).toEqual(transcript);
  await expect(composer).toHaveValue(savedDraft);
  await page.screenshot({ path: testInfo.outputPath("side-chat-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.getByTestId("pix-app")).toHaveAttribute("data-theme", "dark");
  await expect(panel).toHaveCSS("background-color", "rgb(33, 33, 33)");
  await page.screenshot({ path: testInfo.outputPath("side-chat-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.getByTestId("pix-app")).toHaveAttribute("data-theme", "light");
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-font-size", "20px"));
  await expect(input).toHaveCSS("font-size", "20px");
  await expect(panel.getByTestId("selection-side-chat-quote")).toHaveCSS("font-size", "20px");
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(page.getByTestId("shell-main")).toHaveAttribute("data-rail-width", "0");
  await expect.poll(async () => (await page.getByTestId("sidebar").boundingBox())!.width).toBe(0);
  await expect(panel).toBeVisible();
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(601);
  await page.screenshot({ path: testInfo.outputPath("side-chat-narrow.png") });
  await page.evaluate(() => document.documentElement.style.removeProperty("--ui-font-size"));
  await input.fill("保留侧边草稿");
  await panel.getByTestId("selection-side-chat-close").click();
  await confirmSideClose(page);
  await expect(panel).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("thread-header-side-chat")).toBeHidden();
  await selectText(page, source);
  await page.getByTestId("selection-ask").click();
  await expect(panel.locator('[data-role="assistant"]')).toHaveCount(0);
  await expect(input).toHaveValue("");

  // Another selection creates a new tab and preserves the existing side chat.
  await input.fill("旧侧边草稿");
  await selectText(page, source);
  const beforeExplain = pix.fakeModel.requests.length;
  await page.getByTestId("selection-explain").click();
  await expect(page.getByTestId("side-chat-close-confirm")).toBeHidden();
  await expect(input).toHaveValue("");
  await expectSideAnswers(panel, 1);
  expect(pix.fakeModel.requests.length).toBe(beforeExplain + 1);
  await expect(panel.getByTestId("side-chat-tab")).toHaveCount(2);
  await expect(panel.locator('[data-role="user"]')).toContainText(/详细解释|Explain the selected/);
  await expect(composer).toHaveValue(savedDraft);
  const sideAnswer = await panel
    .locator('[data-role="assistant"]')
    .getByTestId("markdown-content")
    .innerText();
  await panel
    .locator('[data-role="assistant"]')
    .getByRole("button", { name: "添加到会话" })
    .click();
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("side-chat-close-confirm")).toBeHidden();
  await expect(composer).toHaveValue(`${savedDraft.trimEnd()}\n\n${sideAnswer.trim()}\n\n`);
  expect(errors).toEqual([]);
});

test("side response icons and partial selection add without closing; close can be cancelled", async ({
  page,
}, testInfo) => {
  await startHost(page);
  await sendPrompt(page, "Hello selection");
  const source = page.getByTestId("timeline").locator("[data-selection-message] p").first();
  await selectText(page, source);
  await page.getByTestId("selection-ask").click();
  const panel = page.getByTestId("selection-side-chat");
  const input = panel.getByTestId("selection-side-chat-input");
  await input.fill("Explain this passage");
  await input.press("Enter");
  await expectSideAnswers(panel, 1);
  await input.fill("保留侧边草稿");
  const mainInput = page.getByTestId("prompt-input");
  await mainInput.fill("主会话草稿");

  const add = panel.getByTestId("side-chat-add-response");
  await expect(add).toHaveAccessibleName("添加到会话");
  await expect(add).toHaveAttribute("title", "添加到会话");
  await expect(add).toHaveText("");
  await expect(add.locator("svg")).toBeVisible();
  await add.click();
  const fullDraft = "主会话草稿\n\nPix fake model response.\n\n";
  await expect(mainInput).toHaveValue(fullDraft);
  await expect(mainInput).toBeFocused();
  await expect(panel).toBeVisible();
  await expect(input).toHaveValue("保留侧边草稿");
  const dialog = page.getByTestId("side-chat-close-confirm");
  await expect(dialog).toBeHidden();

  // Select only part of a side response, with the same browser Range used by a mouse drag.
  const sideText = panel.locator("[data-selection-message] p");
  await sideText.evaluate((element) => {
    (document.activeElement as HTMLElement | null)?.blur();
    const node = element.firstChild!;
    const start = node.textContent!.indexOf("fake model");
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + "fake model".length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const menu = page.getByTestId("side-chat-selection-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(1);
  await expect(page.getByTestId("text-selection-menu")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("side-chat-selection-add.png") });
  await menu.getByTestId("selection-add").click();
  await expect(mainInput).toHaveValue(`${fullDraft.trimEnd()}\n\nfake model\n\n`);
  await expect(mainInput).toBeFocused();
  await expect(panel).toBeVisible();
  await expect(input).toHaveValue("保留侧边草稿");
  await expect(dialog).toBeHidden();

  // Escape first dismisses the selection menu; it does not start closing the chat.
  await selectText(page, sideText, "side-chat-selection-menu");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(dialog).toBeHidden();

  await panel.getByTestId("selection-side-chat-close").click();
  await expect(dialog).toBeVisible();
  await expect(menu).toBeHidden();
  await expect(dialog).toContainText("未发送的草稿");
  await page.screenshot({
    path: testInfo.outputPath("side-chat-close-confirm.png"),
    animations: "disabled",
  });
  await dialog.getByTestId("confirm-dialog-cancel").click();
  await expect(dialog).toBeHidden();
  await expect(input).toHaveValue("保留侧边草稿");
  await expectSideAnswers(panel, 1);

  // A second opening must still handle Escape as cancel, with no stale settled state.
  await input.press("Escape");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(panel).toBeVisible();

  await input.press("Enter");
  await expectSideAnswers(panel, 2);

  await page.getByTestId("thread-header-side-chat").click();
  await confirmSideClose(page);
  await expect(panel).toBeHidden();
  await selectText(page, source);
  await page.getByTestId("selection-ask").click();
  await expect(panel.locator('[data-role="assistant"]')).toHaveCount(0);
  await expect(input).toHaveValue("");
  await expect(mainInput).toHaveValue(`${fullDraft.trimEnd()}\n\nfake model\n\n`);

  // Switching panels is navigation, so only the explicit close controls above prompt.
  await page.getByTestId("thread-header-env").click();
  await expect(panel).toBeHidden();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("thread-header-env")).toHaveAttribute("aria-expanded", "true");

  await selectText(page, source);
  await page.getByTestId("selection-ask").click();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(dialog).toBeHidden();
});

test("mouse selection works in prose and code, and ignores user messages and the composer", async ({
  page,
}) => {
  await startHost(page);
  await sendPrompt(page, "Hello selection");
  const source = page.locator("[data-selection-message] p").first();
  const rect = await source.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { x: rect.left, y: rect.top + rect.height / 2, right: rect.right };
  });
  await page.mouse.move(rect.x, rect.y);
  await page.mouse.down();
  await page.mouse.move(rect.right, rect.y, { steps: 10 });
  await expect(page.getByTestId("text-selection-menu")).toBeHidden();
  await page.mouse.up();
  await expect(page.getByTestId("text-selection-menu")).toBeVisible();
  await page.getByTestId("selection-add").click();
  await expect(page.getByTestId("prompt-input")).toHaveValue("Pix fake model response.\n\n");

  await selectText(page, source);
  await page
    .locator('[data-kind="user"]')
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
  await expect(page.getByTestId("text-selection-menu")).toBeHidden();
  await page.getByTestId("prompt-input").focus();
  await page
    .getByTestId("prompt-input")
    .evaluate((element) => (element as HTMLTextAreaElement).select());
  await expect(page.getByTestId("text-selection-menu")).toBeHidden();

  await sendPrompt(page, "Render the rich content fixture.");
  const code = page.locator(
    '[data-selection-message] .content-code-block[data-language="javascript"] code',
  );
  // Let lazy rich-content layout settle, then scroll back as a reader would.
  await expect(page.getByTestId("mermaid-diagram").locator("svg")).toBeVisible();
  await page.locator(".timeline-scroll").hover();
  await page.mouse.wheel(0, -900);
  await selectText(page, code);
  await page.getByTestId("selection-add").click();
  await expect(page.getByTestId("prompt-input")).toHaveValue("const answer = 42;\n\n");

  // A range spanning responses must not attach a misleading single-message context.
  await selectText(page, code);
  await page.evaluate(() => {
    const sources = document.querySelectorAll("[data-selection-message]");
    const range = document.createRange();
    range.setStart(sources[0]!, 0);
    range.setEnd(sources[1]!, sources[1]!.childNodes.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  await expect(page.getByTestId("text-selection-menu")).toBeHidden();
});

test("selection dismissal, keyboard access, errors, and session isolation", async ({ page }) => {
  await startHost(page);
  await sendPrompt(page, "Hello selection");
  const source = page.locator("[data-selection-message] p").first();
  const menu = page.getByTestId("text-selection-menu");
  await selectText(page, source);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await selectText(page, source);
  await page
    .locator(".timeline-scroll")
    .evaluate((element) => element.dispatchEvent(new Event("scroll")));
  await expect(menu).toBeHidden();
  await selectText(page, source);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("selection-add")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByTestId("selection-ask")).toBeFocused();
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("selection-side-chat");
  await expect(panel).toBeVisible();
  // Exercise the production IPC session-identity guard; the main conversation stays healthy.
  await page.evaluate(() => {
    const original = window.pix.agent.sideChat.bind(window.pix.agent);
    let failOnce = true;
    window.pix.agent.sideChat = (request) => {
      if (failOnce) {
        failOnce = false;
        return original({ ...request, sessionId: "stale-session" });
      }
      return original(request);
    };
  });
  const input = panel.getByTestId("selection-side-chat-input");
  await input.fill("Explain this");
  await input.press("Enter");
  await expect(panel.getByRole("alert")).toContainText("no longer active");
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("host-status").first()).toContainText(
    /Agent settled|Agent Host ready/,
  );
  await input.fill("准备好的追问");
  await panel.getByTestId("selection-side-chat-retry").click();
  await expectSideAnswers(panel, 1);
  await expect(input).toHaveValue("准备好的追问");
  await page.getByTestId("start-host").click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId("side-chat-close-confirm")).toBeHidden();
  await expect(menu).toBeHidden();
  await expect(page.getByTestId("thread-header-side-chat")).toBeHidden();
  await sendPrompt(page, "Another conversation");
  await conversationSessionButtons(page).filter({ hasText: "Hello selection" }).click();
  await expect(page.getByTestId("thread-header-side-chat")).toBeVisible();
  await expectSideAnswers(panel, 1);
  await expect(input).toHaveValue("准备好的追问");
  await selectText(page, source);
  await page.getByTestId("selection-ask").click();
  await expect(panel.locator('[data-role="assistant"]')).toHaveCount(0);
  await expect(input).toHaveValue("");
  await input.fill("abort side before switching");
  await input.press("Enter");
  await expect(panel.locator('[data-role="assistant"]')).toContainText("Waiting for abort...");
  await conversationSessionButtons(page).filter({ hasText: "Another conversation" }).click();
  await expect(page.getByTestId("timeline").locator('[data-kind="user"]')).toContainText(
    "Another conversation",
  );
  await expect(panel).toBeHidden();
  await expect(page.getByTestId("side-chat-close-confirm")).toBeHidden();
});

test("side chat streams, stops independently, and is destroyed on close", async ({
  page,
}, testInfo) => {
  await startHost(page);
  await sendPrompt(page, "Hello selection");
  const source = page.locator("[data-selection-message] p").first();
  await selectText(page, source);
  await page.getByTestId("selection-ask").click();
  const panel = page.getByTestId("selection-side-chat");
  const input = panel.getByTestId("selection-side-chat-input");
  await input.fill("abort side chat");
  await input.press("Enter");
  await expect(panel.locator('[data-role="assistant"]')).toContainText("Waiting for abort...");
  await expect(panel.getByTestId("selection-side-chat-stop")).toBeVisible();
  await input.fill("下一条问题");
  await input.press("Enter");
  await expect(input).toHaveValue("下一条问题");
  await expect(panel.locator('[data-role="user"]')).toHaveCount(1);

  // Both can run at once. Stopping the side request must leave the main turn running.
  await page.getByTestId("prompt-input").fill("abort main chat");
  await page.getByTestId("send-prompt").click();
  await expect(page.getByTestId("timeline")).toContainText("Waiting for abort...");
  await expect(input).toHaveValue("下一条问题");
  await expect(panel.locator('[data-role="assistant"]')).toContainText("Waiting for abort...");
  await page.screenshot({ path: testInfo.outputPath("side-chat-streaming.png") });
  await panel.getByTestId("selection-side-chat-stop").click();
  await expect(panel.getByRole("status")).toContainText("已停止生成");
  await expect(page.getByTestId("abort-prompt")).toBeVisible();
  await expect(panel.locator('[data-role="assistant"]')).toContainText("Waiting for abort...");
  await expect(input).toHaveValue("下一条问题");
  await input.press("Enter");
  await expectSideAnswers(panel, 2);
  await expect(page.getByTestId("abort-prompt")).toBeVisible();
  await page.getByTestId("abort-prompt").click();

  await input.fill("abort again");
  await input.press("Enter");
  await expect(panel.locator('[data-role="assistant"]').last()).toContainText(
    "Waiting for abort...",
  );
  await panel.getByTestId("selection-side-chat-close").click();
  await expect(page.getByTestId("side-chat-close-confirm")).toBeVisible();
  await expect(panel.getByTestId("selection-side-chat-stop")).toBeVisible();
  await page.getByTestId("side-chat-close-confirm").getByTestId("confirm-dialog-cancel").click();
  await expect(panel.getByTestId("selection-side-chat-stop")).toBeVisible();
  await panel.getByTestId("selection-side-chat-close").click();
  await confirmSideClose(page);
  await expect(panel).toBeHidden();
  await expect(page.getByTestId("thread-header-side-chat")).toBeHidden();
  await selectText(page, source);
  await page.getByTestId("selection-ask").click();
  await expect(panel.locator('[data-role="user"]')).toHaveCount(0);
  await expect(panel.getByTestId("selection-side-chat-history")).toHaveCount(0);
  await expect(input).toHaveValue("");
});
