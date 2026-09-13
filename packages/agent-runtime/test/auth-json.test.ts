import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authJsonPath, deleteProviderCredential, persistProviderApiKey } from "../src/auth-json.ts";
import { createPixRuntime } from "../src/index.ts";

describe("auth.json persistence", () => {
  it("keeps a shared credential when one model moves to another provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pix-auth-move-"));
    const handle = await createPixRuntime({ cwd: dir, agentDir: dir });
    try {
      const input = {
        provider: "source",
        baseUrl: "https://gateway.invalid/v1",
        api: "openai-completions" as const,
      };
      await handle.upsertCustomProvider({ ...input, modelId: "first", apiKey: "fixture-source" });
      await handle.upsertCustomProvider({ ...input, modelId: "second" });
      await handle.upsertCustomProvider({
        ...input,
        provider: "destination",
        previousProvider: "source",
        previousModelId: "first",
        modelId: "first",
        apiKey: "fixture-destination",
      });
      const data = JSON.parse(await readFile(authJsonPath(dir), "utf8"));
      expect(data.source).toEqual({ type: "api_key", key: "fixture-source" });
      expect(data.destination).toEqual({ type: "api_key", key: "fixture-destination" });
      expect(
        (await handle.getModelsJsonConfig()).providers
          .find((row) => row.provider === "source")
          ?.models.map((row) => row.id),
      ).toEqual(["second"]);
      expect(handle.listProviders().find((row) => row.provider === "source")?.configured).toBe(
        true,
      );
    } finally {
      await handle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves BOM-prefixed credentials when another provider is saved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pix-auth-bom-"));
    try {
      await writeFile(authJsonPath(dir), '\uFEFF{"original":{"type":"api_key","key":"fixture"}}');
      await persistProviderApiKey(dir, "added", "fixture-new");
      expect(JSON.parse(await readFile(authJsonPath(dir), "utf8"))).toEqual({
        original: { type: "api_key", key: "fixture" },
        added: { type: "api_key", key: "fixture-new" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['{"secret":"fixture"', "[]", "null", '"fixture"', ""])(
    "refuses to overwrite an unreadable credential document (%j)",
    async (raw) => {
      const dir = await mkdtemp(join(tmpdir(), "pix-auth-invalid-"));
      try {
        await writeFile(authJsonPath(dir), raw);
        await expect(persistProviderApiKey(dir, "added", "fixture")).rejects.toThrow();
        await expect(deleteProviderCredential(dir, "original")).rejects.toThrow();
        expect(await readFile(authJsonPath(dir), "utf8")).toBe(raw);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("preserves all providers across concurrent saves and deletion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pix-auth-concurrent-"));
    try {
      await persistProviderApiKey(dir, "removed", "fixture");
      await Promise.all([
        ...Array.from({ length: 8 }, (_, i) =>
          persistProviderApiKey(dir, `provider-${i}`, "fixture"),
        ),
        deleteProviderCredential(dir, "removed"),
      ]);
      const data = JSON.parse(await readFile(authJsonPath(dir), "utf8"));
      expect(Object.keys(data).sort()).toEqual(
        Array.from({ length: 8 }, (_, i) => `provider-${i}`),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("waits for the SDK credential lock and merges its completed update", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pix-auth-sdk-lock-"));
    const sdkModule = new URL(
      "./core/auth-storage.js",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    const { FileAuthStorageBackend } = await import(sdkModule.href);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let sdkWrite: Promise<void> | undefined;
    let pixWrite: Promise<void> | undefined;
    try {
      await persistProviderApiKey(dir, "original", "fixture");
      sdkWrite = new FileAuthStorageBackend(authJsonPath(dir)).withLockAsync(
        async (raw: string) => {
          const data = JSON.parse(raw);
          entered();
          await gate;
          return {
            result: undefined,
            next: JSON.stringify({ ...data, refreshed: { type: "api_key", key: "fixture" } }),
          };
        },
      );
      await ready;
      pixWrite = persistProviderApiKey(dir, "added", "fixture");
      // The Pix write must not finish while the SDK holds its cross-process lock.
      const early = await Promise.race([
        pixWrite.then(() => "written"),
        new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
      ]);
      expect(early).toBe("waiting");
      release();
      await Promise.all([sdkWrite, pixWrite]);
      expect(Object.keys(JSON.parse(await readFile(authJsonPath(dir), "utf8"))).sort()).toEqual([
        "added",
        "original",
        "refreshed",
      ]);
    } finally {
      release();
      await Promise.allSettled([sdkWrite, pixWrite]);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes durable api_key credentials and can delete them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pix-auth-json-"));
    try {
      await persistProviderApiKey(dir, "XTJ", "sk-test-key");
      const raw = await readFile(authJsonPath(dir), "utf8");
      const data = JSON.parse(raw) as Record<string, { type: string; key: string }>;
      expect(data.XTJ).toEqual({ type: "api_key", key: "sk-test-key" });

      await persistProviderApiKey(dir, "other", "sk-2");
      await deleteProviderCredential(dir, "XTJ");
      const next = JSON.parse(await readFile(authJsonPath(dir), "utf8")) as Record<string, unknown>;
      expect(next.XTJ).toBeUndefined();
      expect(next.other).toEqual({ type: "api_key", key: "sk-2" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
