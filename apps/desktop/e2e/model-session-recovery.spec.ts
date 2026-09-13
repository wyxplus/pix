import { createServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { test, expect, startHost, sendPrompt, selectWorkspace } from "./fixtures.ts";

test("changing model after a new project session hits a cooldown keeps its identity and content", async ({
  page,
  pix,
}) => {
  const server = createServer((_request, response) => {
    response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
    response.end(
      JSON.stringify({ error: { message: "model_cooldown", type: "rate_limit_error" } }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  try {
    await startHost(page);
    const project = await selectWorkspace(pix, page, resolve(import.meta.dirname, ".."));
    await page.evaluate((cwd) => window.pix.workspace.openPath(cwd), project);
    const trust = page.getByTestId("project-trust-dialog");
    if (await trust.isVisible()) await page.getByTestId("project-trust-dialog-later").click();
    await page.getByTestId("workspace-current").click();
    const previous = await page.evaluate(() => window.pix.host.snapshot());
    // A disk scan started for the old session can finish after navigation/model recovery.
    await page.evaluate((previousId) => {
      const original = window.pix.session.list.bind(window.pix.session);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      window.pix.session.list = async () => {
        const result = await original();
        if (result.activeSessionId === previousId) await gate;
        return result;
      };
      (window as Window & { __releaseOldLists?: () => void }).__releaseOldLists = release;
    }, previous.sessionId);
    await sendPrompt(page, "Original project session");
    await page.getByTestId("start-host").click();
    await expect
      .poll(
        async () =>
          JSON.parse((await page.getByTestId("runtime-snapshot").first().textContent()) || "{}")
            .sessionId,
      )
      .not.toBe(previous.sessionId);
    const current = await page.evaluate(() => window.pix.host.snapshot());
    await page.evaluate(async (baseUrl) => {
      await window.pix.models.upsertCustomProvider({
        provider: "pix-cooldown",
        modelId: "cooldown",
        baseUrl,
        api: "openai-completions",
        apiKey: "test-key-not-secret",
      });
      await window.pix.models.set("pix-cooldown", "cooldown");
    }, `http://127.0.0.1:${address.port}/v1`);
    await page.getByTestId("prompt-input").fill("New failed project session");
    await page.getByTestId("send-prompt").click();
    await expect(page.getByTestId("timeline")).toContainText("model_cooldown");
    const stop = page.getByTestId("abort-prompt");
    if (await stop.isVisible()) await stop.click();
    await expect(page.getByTestId("model-select")).toBeEnabled();
    await page.getByTestId("model-select").selectOption("pix-fake/pix-fake", { force: true });
    await expect(page.getByTestId("model-select")).toHaveValue("pix-fake/pix-fake");
    expect((await page.evaluate(() => window.pix.host.snapshot())).sessionId).toBe(
      current.sessionId,
    );
    await expect(page.getByTestId("timeline").locator('[data-kind="user"]')).toContainText([
      "New failed project session",
    ]);
    await expect(page.locator('[data-testid="thread-header"]')).toContainText(
      "New failed project session",
    );
    await page.evaluate(async () => {
      (window as Window & { __releaseOldLists?: () => void }).__releaseOldLists?.();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    await expect(page.getByTestId("thread-header")).toContainText("New failed project session");
    await expect(
      page.getByTestId("thread-list").locator('button[data-active="true"]'),
    ).toContainText("New failed project session");
    await sendPrompt(page, "Continue the new session");
    expect((await page.evaluate(() => window.pix.host.snapshot())).sessionId).toBe(
      current.sessionId,
    );
    await expect(page.getByTestId("timeline")).not.toContainText("Original project session");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
