import { describe, expect, it } from "vite-plus/test";
import { MEMORY_EXTRACTION_PROMPT, parseModelJsonArray } from "../src/memory-extraction.ts";

describe("parseModelJsonArray", () => {
  it("parses bare JSON arrays", () => {
    expect(parseModelJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(parseModelJsonArray("  []  ")).toEqual([]);
  });

  it("parses JSON wrapped in markdown code fences", () => {
    expect(parseModelJsonArray('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
    expect(parseModelJsonArray("```\n[]\n```")).toEqual([]);
    expect(parseModelJsonArray('```JSON\n[{"a":1},]\n```'.replace(",]", "]"))).toEqual([{ a: 1 }]);
  });

  it("tolerates surrounding prose-free whitespace and nested fences content", () => {
    expect(parseModelJsonArray('```json\n[{"text":"has ``` inside"}]\n```')).toEqual([
      { text: "has ``` inside" },
    ]);
  });

  it("still rejects malformed JSON", () => {
    expect(() => parseModelJsonArray("not json")).toThrow();
    expect(() => parseModelJsonArray("```json\n[{broken]\n```")).toThrow();
  });
});

describe("MEMORY_EXTRACTION_PROMPT", () => {
  it("requires verbatim entryId copying", () => {
    expect(MEMORY_EXTRACTION_PROMPT).toContain("entryId must be copied verbatim");
  });
});
