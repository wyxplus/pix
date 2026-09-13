import { describe, expect, it } from "vite-plus/test";
import { normalizePathKey } from "../src/path-key.ts";

describe("path equality", () => {
  it.each(["linux", "darwin"] as const)("preserves case-distinct paths on %s", (platform) => {
    expect(normalizePathKey("/home/Project", platform)).not.toBe(
      normalizePathKey("/home/project", platform),
    );
    expect(normalizePathKey("/home/Project/", platform)).toBe(
      normalizePathKey("/home/Project", platform),
    );
    expect(normalizePathKey("/home/back\\slash", platform)).not.toBe(
      normalizePathKey("/home/back/slash", platform),
    );
  });
  it("matches Windows drive/UNC paths across case and separators", () => {
    expect(normalizePathKey("D:\\Project\\", "win32")).toBe(
      normalizePathKey("d:/project", "win32"),
    );
    expect(normalizePathKey("\\\\Server\\Share\\Project", "win32")).toBe("//server/share/project");
  });
  it("collapses only macOS system aliases", () => {
    expect(normalizePathKey("/private/var/a", "darwin")).toBe("/var/a");
    expect(normalizePathKey("/private/var/a", "linux")).toBe("/private/var/a");
    expect(normalizePathKey("/private/project", "darwin")).toBe("/private/project");
    expect(normalizePathKey("/", "linux")).toBe("/");
  });
});
