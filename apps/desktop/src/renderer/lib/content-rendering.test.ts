import { describe, expect, it } from "vite-plus/test";
import {
  contentMediaKind,
  contentSourceUrl,
  formatFileLinkLabel,
  formatWorkspaceRelativePath,
  isInlineImagePath,
  parseContentLink,
} from "./content-rendering.ts";

describe("conversation content targets", () => {
  it("classifies video sources independently from images", () => {
    expect(contentMediaKind("/tmp/demo.mp4?download=1")).toBe("video");
    expect(contentMediaKind("/tmp/screenshot.webp")).toBe("image");
    expect(isInlineImagePath("output/v10.gif")).toBe(true);
    expect(isInlineImagePath("player.tscn")).toBe(false);
  });

  it("parses local file line links and safe external URLs", () => {
    expect(parseContentLink("/tmp/app.ts:42:7")).toEqual({
      kind: "file",
      path: "/tmp/app.ts",
      line: 42,
      column: 7,
    });
    expect(parseContentLink("src/app.ts#L12", "/work/project")).toEqual({
      kind: "file",
      path: "/work/project/src/app.ts",
      line: 12,
    });
    expect(parseContentLink("app.ts:12:3", "/work/project")).toEqual({
      kind: "file",
      path: "/work/project/app.ts",
      line: 12,
      column: 3,
    });
    expect(parseContentLink("https://example.com/docs")).toEqual({
      kind: "external",
      href: "https://example.com/docs",
    });
    expect(parseContentLink("javascript:alert(1)")).toEqual({ kind: "blocked" });
  });

  it("converts local media paths to encoded file URLs", () => {
    expect(contentSourceUrl("/tmp/design preview.png")).toBe("file:///tmp/design%20preview.png");
  });

  it("preserves Windows drives, UNC hosts and Unicode file names", () => {
    expect(parseContentLink("C:\\Users\\Alice\\报告 folder\\app.ts:20:3")).toEqual({
      kind: "file",
      path: "C:\\Users\\Alice\\报告 folder\\app.ts",
      line: 20,
      column: 3,
    });
    expect(parseContentLink("output/report.xlsx", "C:\\work")).toEqual({
      kind: "file",
      path: "C:\\work\\output\\report.xlsx",
    });
    expect(parseContentLink("file://server/share/%E6%8A%A5%E5%91%8A%20v2.xlsx")).toEqual({
      kind: "file",
      path: "//server/share/报告 v2.xlsx",
    });
    expect(parseContentLink("file:///C:/work/app.ts#L20C3")).toEqual({
      kind: "file",
      path: "C:/work/app.ts",
      line: 20,
      column: 3,
    });
  });

  it("shortens absolute paths under the workspace for session display", () => {
    expect(formatWorkspaceRelativePath("/work/project/src/app.ts", "/work/project")).toBe(
      "src/app.ts",
    );
    expect(formatWorkspaceRelativePath("src/app.ts", "/work/project")).toBe("src/app.ts");
    expect(formatWorkspaceRelativePath("/tmp/outside.ts", "/work/project")).toBe("outside.ts");
    expect(formatFileLinkLabel("app.ts", "/work/project/src/app.ts", "/work/project")).toBe(
      "src/app.ts",
    );
    expect(formatFileLinkLabel("Fixture file", "/work/project/fixture.txt", "/work/project")).toBe(
      "Fixture file",
    );
  });
});
