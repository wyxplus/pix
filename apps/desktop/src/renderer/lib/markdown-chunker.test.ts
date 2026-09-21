import { describe, expect, it } from "vite-plus/test";
import {
  hasDocumentDefinition,
  isAmbiguousContinuation,
  splitSafeMarkdownBlocks,
} from "./markdown-chunker.ts";

/** Every source character must survive, in order. */
function concat(blocks: ReturnType<typeof splitSafeMarkdownBlocks>): string {
  return blocks.map((block) => block.content).join("\n");
}

describe("isAmbiguousContinuation", () => {
  it("treats indented lines as continuations", () => {
    expect(isAmbiguousContinuation("    indented code")).toBe(true);
    expect(isAmbiguousContinuation("\ttabbed")).toBe(true);
  });

  it("treats list, quote, table and definition starts as continuations", () => {
    expect(isAmbiguousContinuation("- item")).toBe(true);
    expect(isAmbiguousContinuation("* item")).toBe(true);
    expect(isAmbiguousContinuation("+ item")).toBe(true);
    expect(isAmbiguousContinuation("1. item")).toBe(true);
    expect(isAmbiguousContinuation("1) item")).toBe(true);
    expect(isAmbiguousContinuation("> quote")).toBe(true);
    expect(isAmbiguousContinuation("| a | b |")).toBe(true);
    expect(isAmbiguousContinuation("[link]: https://example.com")).toBe(true);
    expect(isAmbiguousContinuation("[^1]: footnote")).toBe(true);
    expect(isAmbiguousContinuation("<div>")).toBe(true);
  });

  it("treats plain prose and blank lines as safe boundaries", () => {
    expect(isAmbiguousContinuation("plain paragraph")).toBe(false);
    expect(isAmbiguousContinuation("")).toBe(false);
    expect(isAmbiguousContinuation("   ")).toBe(false);
  });
});

describe("splitSafeMarkdownBlocks", () => {
  it("returns nothing for empty text", () => {
    expect(splitSafeMarkdownBlocks("")).toEqual([]);
  });

  it("keeps a growing paragraph as a single unstable block", () => {
    const blocks = splitSafeMarkdownBlocks("still typing");
    expect(blocks).toEqual([{ offset: 0, content: "still typing", isStable: false }]);
  });

  it("splits on a blank line followed by plain prose", () => {
    const blocks = splitSafeMarkdownBlocks("first\n\nsecond");
    expect(blocks).toEqual([
      { offset: 0, content: "first", isStable: true },
      { offset: 7, content: "second", isStable: false },
    ]);
  });

  it("records offsets that point at the real source position", () => {
    const text = "alpha\n\nbravo\n\ncharlie";
    const blocks = splitSafeMarkdownBlocks(text);
    for (const block of blocks) {
      expect(text.startsWith(block.content, block.offset)).toBe(true);
    }
  });

  it("treats a closed code fence as a stable block", () => {
    const blocks = splitSafeMarkdownBlocks("before\n\n```ts\nconst a = 1;\n```\n\nafter");
    expect(blocks.map((block) => block.isStable)).toEqual([true, true, false]);
    expect(blocks[1]?.content).toBe("```ts\nconst a = 1;\n```");
  });

  it("keeps an unclosed fence in the unstable tail", () => {
    const blocks = splitSafeMarkdownBlocks("text\n\n```ts\nconst a = 1;");
    expect(blocks.map((block) => block.isStable)).toEqual([true, false]);
    expect(blocks[1]?.content).toBe("```ts\nconst a = 1;");
  });

  it("does not split a loose list", () => {
    const blocks = splitSafeMarkdownBlocks("- one\n\n- two");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.isStable).toBe(false);
  });

  it("does not split a list from its continuation line", () => {
    const blocks = splitSafeMarkdownBlocks("- one\n\n    continued");
    expect(blocks).toHaveLength(1);
  });

  it("does not split a link reference from its definition", () => {
    const blocks = splitSafeMarkdownBlocks("[docs][ref]\n\n[ref]: https://example.com");
    expect(blocks).toHaveLength(1);
  });

  it("does not split a paragraph from an indented code block", () => {
    const blocks = splitSafeMarkdownBlocks("para\n\n    indented code");
    expect(blocks).toHaveLength(1);
  });

  it("splits around a closed display-math block", () => {
    const blocks = splitSafeMarkdownBlocks("intro\n\n$$\nx = 1\n$$\n\noutro");
    expect(blocks.map((block) => block.isStable)).toEqual([true, true, false]);
    expect(blocks[1]?.content).toBe("$$\nx = 1\n$$");
  });

  it("keeps an unclosed display-math block in the tail", () => {
    const blocks = splitSafeMarkdownBlocks("intro\n\n$$\nx = 1");
    expect(blocks.map((block) => block.isStable)).toEqual([true, false]);
  });

  it("preserves every character in order across a mixed document", () => {
    const text = [
      "# Title",
      "",
      "Some prose with `code`.",
      "",
      "```bash",
      "echo hi",
      "```",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "- item",
      "",
      "- second",
      "",
      "final line",
    ].join("\n");
    const blocks = splitSafeMarkdownBlocks(text);
    // Content survives, ignoring the blank separators dropped at boundaries.
    expect(concat(blocks).replace(/\n+/g, "\n")).toBe(text.replace(/\n+/g, "\n"));
  });

  it("keeps closed blocks byte-identical while the tail grows", () => {
    const prefix = "lead\n\n```ts\nlet x = 0;\n```\n\n";
    const settled = splitSafeMarkdownBlocks(`${prefix}partial`);
    const grown = splitSafeMarkdownBlocks(`${prefix}partial answer`);

    const settledStable = settled.filter((block) => block.isStable);
    const grownStable = grown.filter((block) => block.isStable);
    expect(grownStable.slice(0, settledStable.length)).toEqual(settledStable);
    expect(grown.at(-1)?.isStable).toBe(false);
  });

  it("keeps a stable block offset identical as the tail grows", () => {
    const first = splitSafeMarkdownBlocks("alpha\n\nbeta");
    const later = splitSafeMarkdownBlocks("alpha\n\nbeta gamma");
    expect(first[0]).toEqual(later[0]);
    expect(first[1]?.offset).toBe(later[1]?.offset);
  });

  it("does not chunk documents with a footnote definition", () => {
    const text = "[^1]: the note\n\na claim[^1]";
    const blocks = splitSafeMarkdownBlocks(text);
    expect(blocks).toEqual([{ offset: 0, content: text, isStable: false }]);
  });

  it("does not chunk documents with a link reference definition", () => {
    const text = "[docs]: https://example.com\n\nsee [docs]";
    expect(splitSafeMarkdownBlocks(text)).toEqual([{ offset: 0, content: text, isStable: false }]);
  });

  it("keeps a reference definition usable when it precedes prose", () => {
    const blocks = splitSafeMarkdownBlocks("intro\n\n[^1]: note\n\nlater[^1]");
    expect(blocks).toHaveLength(1);
  });

  it("treats an indented reference definition as document-scoped", () => {
    expect(hasDocumentDefinition("   [1]: https://example.com")).toBe(true);
  });

  it("ignores bracketed prose that is not a definition", () => {
    expect(hasDocumentDefinition("see [the docs] for details")).toBe(false);
    expect(hasDocumentDefinition("a [1] b")).toBe(false);
  });

  it("swallows lines after a raw HTML block until a blank line", () => {
    // CommonMark keeps the fence inside the HTML block; splitting it would
    // render a code block that the full-document render never produces.
    const text = "<div>hi</div>\n```ts\nlet a = 1;\n```\n\nafter";
    const blocks = splitSafeMarkdownBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.content).toBe("<div>hi</div>\n```ts\nlet a = 1;\n```");
    expect(blocks[0]?.isStable).toBe(true);
    expect(blocks[1]?.content).toBe("after");
  });

  it("does not start an HTML block from an inline comparison", () => {
    const blocks = splitSafeMarkdownBlocks("3 < 5 is true\n\nnext paragraph");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.content).toBe("3 < 5 is true");
  });

  it("does not treat inline tags as an HTML block", () => {
    // `<span>` is inline markup; it must not swallow the fence after it.
    const text = "<span>inline</span>\ntext with **bold**\n```ts\nlet a = 1;\n```";
    const blocks = splitSafeMarkdownBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.content).toBe("<span>inline</span>\ntext with **bold**");
    expect(blocks[1]?.content).toBe("```ts\nlet a = 1;\n```");
  });

  it("does not treat a short tag as a prefix of a longer block tag", () => {
    // `<p>` is block level, `<picture>` is not in the block list.
    const inline = splitSafeMarkdownBlocks("<picture>x</picture>\n\nafter");
    expect(inline).toHaveLength(2);
    const block = splitSafeMarkdownBlocks("<p>x</p>\n\nafter");
    expect(block[0]?.content).toBe("<p>x</p>");
  });

  it("keeps a fence inside a fenced code block from closing it early", () => {
    const blocks = splitSafeMarkdownBlocks("````md\n```\n````\n\nafter");
    expect(blocks[0]?.content).toBe("````md\n```\n````");
    expect(blocks[0]?.isStable).toBe(true);
  });

  it("closes a fence when the closing fence is at least as long", () => {
    const blocks = splitSafeMarkdownBlocks("```md\n```\n\nafter");
    expect(blocks[0]?.content).toBe("```md\n```");
    expect(blocks[0]?.isStable).toBe(true);
    expect(blocks[1]?.content).toBe("after");
  });
});
