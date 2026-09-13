import { describe, expect, it } from "vite-plus/test";
import { PromptHistory } from "./prompt-history.ts";

const draft = (text: string) => ({ text });

describe("PromptHistory", () => {
  it("leaves content alone when there is no previous or next prompt", () => {
    const history = new PromptHistory(draft);
    expect(history.navigate("previous", draft("unsent"), [])).toBeUndefined();
    expect(history.navigate("next", draft("unsent"), ["sent"])).toBeUndefined();
  });

  it("browses both directions without wrapping and restores the unsent draft", () => {
    const history = new PromptHistory(draft);
    const entries = ["first", "second\nline"];
    expect(history.navigate("previous", draft("unsent"), entries)).toEqual(draft(entries[1]!));
    expect(history.isUneditedEntry(entries[1]!)).toBe(true);
    expect(history.navigate("previous", draft(entries[1]!), entries)).toEqual(draft("first"));
    expect(history.navigate("previous", draft("first"), entries)).toBeUndefined();
    expect(history.navigate("next", draft("first"), entries)).toEqual(draft(entries[1]!));
    expect(history.navigate("next", draft(entries[1]!), entries)).toEqual(draft("unsent"));
    expect(history.isUneditedEntry("unsent")).toBe(false);
    expect(history.navigate("next", draft("unsent"), entries)).toBeUndefined();
  });

  it("keeps recalled edits and draft metadata without mutating the sent prompts", () => {
    const history = new PromptHistory((text: string) => ({ text, refs: [] as string[] }));
    const original = { text: "skill draft", refs: ["/skill:review"] };
    const entries = ["first", "second"];
    history.navigate("previous", original, entries);
    expect(history.isUneditedEntry("edited second")).toBe(false);
    history.navigate("previous", { text: "edited second", refs: [] }, entries);
    expect(history.navigate("next", { text: "first", refs: [] }, entries)?.text).toBe(
      "edited second",
    );
    expect(history.navigate("next", { text: "edited second", refs: [] }, entries)).toEqual(
      original,
    );
    expect(entries).toEqual(["first", "second"]);
  });

  it("keeps duplicate prompts as separate turns and restores an empty draft", () => {
    const history = new PromptHistory(draft);
    const entries = ["same", "same"];
    expect(history.navigate("previous", draft(""), entries)).toEqual(draft("same"));
    expect(history.navigate("previous", draft("same"), entries)).toEqual(draft("same"));
    expect(history.navigate("next", draft("same"), entries)).toEqual(draft("same"));
    expect(history.navigate("next", draft("same"), entries)).toEqual(draft(""));
  });

  it("preserves the draft when messages arrive during a pass and reads them on the next pass", () => {
    const history = new PromptHistory(draft);
    history.navigate("previous", draft("unsent"), ["first"]);
    expect(history.navigate("next", draft("first"), ["first", "queued"])).toEqual(draft("unsent"));
    expect(history.navigate("previous", draft("unsent"), ["first", "queued"])).toEqual(
      draft("queued"),
    );
  });

  it("drops the previous browsing pass when sending or changing conversations", () => {
    const history = new PromptHistory(draft);
    history.navigate("previous", draft("old draft"), ["old prompt"]);
    history.reset();
    expect(history.navigate("previous", draft(""), [])).toBeUndefined();
    expect(history.navigate("previous", draft("new draft"), ["new prompt"])).toEqual(
      draft("new prompt"),
    );
    expect(history.navigate("next", draft("new prompt"), ["new prompt"])).toEqual(
      draft("new draft"),
    );
  });
});
