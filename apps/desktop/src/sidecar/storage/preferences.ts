import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export class DesktopPreferences {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  async read(): Promise<Record<string, string> | null> {
    await this.queue;
    return this.load();
  }
  private async load(): Promise<Record<string, string> | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      this.validate(value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private validate(value: unknown): asserts value is Record<string, string> {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.entries(value).some(
        ([key, item]) =>
          !key.startsWith("pix.") ||
          key.length > 200 ||
          typeof item !== "string" ||
          item.length > 2_000_000,
      ) ||
      JSON.stringify(value).length > 8_000_000
    )
      throw new Error("invalid_desktop_preferences");
  }
  patch(patch: Record<string, string | null>, initialize = false): Promise<Record<string, string>> {
    const work = this.queue.then(async () => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new Error("invalid_desktop_preferences");
      const previous = await this.load();
      if (initialize && previous) return previous;
      const next = { ...previous };
      for (const [key, value] of Object.entries(patch)) {
        if (!key.startsWith("pix.")) throw new Error("invalid_preference_key");
        if (value === null) delete next[key];
        else next[key] = value;
      }
      this.validate(next);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const staging = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(staging, JSON.stringify(next), { flag: "wx", mode: 0o600, flush: true });
      await rename(staging, this.path);
      return next;
    });
    this.queue = work.catch(() => {});
    return work;
  }
}
