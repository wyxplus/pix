/** A browsing pass keeps the unsent draft and edits separate from sent messages. */
export class PromptHistory<Draft extends { text: string }> {
  private entries: readonly string[] | undefined;
  private index = 0;
  private drafts = new Map<number, Draft>();

  constructor(private readonly fromText: (text: string) => Draft) {}

  reset(): void {
    this.entries = undefined;
    this.index = 0;
    this.drafts.clear();
  }

  isUneditedEntry(text: string): boolean {
    return (
      this.entries !== undefined &&
      this.index < this.entries.length &&
      text === this.entries[this.index]
    );
  }

  navigate(
    direction: "previous" | "next",
    current: Draft,
    available: readonly string[],
  ): Draft | undefined {
    if (!this.entries) {
      if (direction === "next" || available.length === 0) return undefined;
      // Freeze this pass so incoming queued messages cannot move the draft's slot.
      this.entries = [...available];
      this.index = this.entries.length;
    }
    const next = Math.max(
      0,
      Math.min(this.entries.length, this.index + (direction === "previous" ? -1 : 1)),
    );
    if (next === this.index) return undefined;
    this.drafts.set(this.index, current);
    this.index = next;
    const draft = this.drafts.get(next) ?? this.fromText(this.entries[next]!);
    if (next === this.entries.length) this.reset();
    return draft;
  }
}

/** Check visual lines, including soft wraps, without moving the textarea's caret. */
export function isTextareaBoundaryLine(
  el: HTMLTextAreaElement,
  direction: "previous" | "next",
): boolean {
  const position = el.selectionStart;
  const boundary = direction === "previous" ? 0 : el.value.length;
  if (position === boundary) return true;
  if (
    direction === "previous"
      ? el.value.slice(0, position).includes("\n")
      : el.value.slice(position).includes("\n")
  )
    return false;

  const doc = el.ownerDocument;
  const style = doc.defaultView!.getComputedStyle(el);
  const mirror = doc.createElement("div");
  mirror.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;box-sizing:border-box;border:0;margin:0;";
  for (const property of [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "font-variant",
    "line-height",
    "letter-spacing",
    "word-spacing",
    "text-indent",
    "text-transform",
    "tab-size",
    "white-space",
    "overflow-wrap",
    "word-break",
    "direction",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
  ])
    mirror.style.setProperty(property, style.getPropertyValue(property));
  // clientWidth excludes the vertical scrollbar and includes textarea padding.
  mirror.style.width = `${el.clientWidth}px`;
  const text = doc.createTextNode(`${el.value}\u200b`);
  mirror.append(text);
  doc.body.append(mirror);
  try {
    const range = doc.createRange();
    const topAt = (offset: number) => {
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      return range.getBoundingClientRect().top;
    };
    return Math.abs(topAt(position) - topAt(boundary)) < 1;
  } finally {
    mirror.remove();
  }
}
