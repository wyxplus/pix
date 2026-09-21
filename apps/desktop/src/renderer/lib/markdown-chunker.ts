/**
 * High-confidence block splitter for streaming Markdown.
 *
 * Streamed replies re-render on every token. Running the full remark/rehype
 * pipeline over the whole text each time is O(n²) and is the main cause of the
 * UI freezing on long answers. Splitting the text at *certain* block boundaries
 * lets closed blocks be memoized, so only the tail block is re-parsed.
 *
 * Safety rule: a boundary is only committed when the following line cannot
 * change the meaning of the previous block. Anything ambiguous (lists,
 * blockquotes, tables, link/footnote definitions, indented continuations, HTML)
 * stays inside the tail block, even if that makes the tail slightly longer.
 *
 * Two constructs cannot be split at all and disable chunking for the whole
 * document when present:
 *   - link reference / footnote definitions, whose scope is the document (a
 *     reference in one chunk cannot see a definition that landed in another);
 *   - raw HTML blocks, which swallow every following line up to a blank line.
 */
export type MarkdownBlock = {
  /** Start offset in the source text. Stable across growth, so safe as a React key. */
  offset: number;
  content: string;
  /** False for the single trailing block that may still grow. */
  isStable: boolean;
};

/** Opening code fence: ``` or ~~~ (three or more). */
const OPENING_FENCE = /^(`{3,}|~{3,})/;

/**
 * Line starts that may still belong to the previous block, so a preceding blank
 * line is not a safe split point. Covers list bullets and ordered markers,
 * blockquotes, tables, link/footnote definitions and raw HTML blocks.
 */
const AMBIGUOUS_CONTINUATION = /^(?:[-*+]|\d+[.)]|>|\||\[\^?[^\]]+\]:|<)/;

/**
 * Document-level definitions: `[label]: url` and `[^note]: text` at up to three
 * spaces of indentation.
 */
const DEFINITION_LINE = /^ {0,3}\[\^?[^\]\n]+\]:/m;

/**
 * Start of a raw HTML block that ends at a blank line. Only *block-level* tags
 * qualify: inline markup like `<span>` stays inside its paragraph and must not
 * swallow the lines that follow it.
 */
const HTML_BLOCK_TAG =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_BLOCK_START = new RegExp(`^ {0,3}<\\/?(?:${HTML_BLOCK_TAG})(?=[\\s/>]|$)`, "i");

/**
 * Raw HTML blocks that only end at their own terminator (`</script>`, `-->`,
 * `?>`), so a blank line does not close them. They are rare in model output and
 * cannot be chunked safely, so their presence disables chunking.
 */
const HTML_TERMINATED_BLOCK_START =
  /^ {0,3}<(?:script|pre|style|textarea)(?=[\s/>]|$)|^ {0,3}<[!?]/im;

/**
 * True when `line` may be a continuation of the block above it, making a blank
 * line above it an unsafe split point.
 */
export function isAmbiguousContinuation(line: string): boolean {
  if (!line) return false;
  // Indented code blocks and list continuations.
  if (line.startsWith("    ") || line.startsWith("\t")) return true;
  const trimmed = line.trimStart();
  if (!trimmed) return false;
  return AMBIGUOUS_CONTINUATION.test(trimmed);
}

/** True when the document contains a reference/footnote definition. */
export function hasDocumentDefinition(text: string): boolean {
  return DEFINITION_LINE.test(text);
}

/** True when the document opens an HTML block that never closes at a blank line. */
export function hasTerminatedHtmlBlock(text: string): boolean {
  return HTML_TERMINATED_BLOCK_START.test(text);
}

/**
 * Split `text` into closed blocks plus one trailing block. Never throws and
 * never reorders content. Blank separators at a committed boundary are dropped,
 * but every other character appears exactly once, in order.
 */
export function splitSafeMarkdownBlocks(text: string): MarkdownBlock[] {
  if (!text) return [];

  // Document-scoped definitions can be referenced from any later block, so a
  // chunk boundary would silently demote those references to plain text.
  if (hasDocumentDefinition(text) || hasTerminatedHtmlBlock(text)) {
    return [{ offset: 0, content: text, isStable: false }];
  }

  const blocks: MarkdownBlock[] = [];
  const lines = text.split("\n");
  let current: string[] = [];
  let blockStart = 0;
  /** Offset of the line currently being scanned. */
  let offset = 0;
  /** Opening fence marker while inside a fenced code block. */
  let fence: string | null = null;
  let inMathBlock = false;
  let inHtmlBlock = false;

  const commit = (isStable: boolean): void => {
    if (current.length === 0) return;
    blocks.push({ offset: blockStart, content: current.join("\n"), isStable });
    current = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineLength = line.length + 1; // include the consumed "\n"

    // 1. Inside a fenced code block — only a matching fence closes it.
    if (fence !== null) {
      current.push(line);
      offset += lineLength;
      if (line.trimStart().startsWith(fence)) {
        commit(true);
        fence = null;
        blockStart = offset;
      }
      continue;
    }

    // 2. Inside a raw HTML block — everything up to a blank line is HTML. The
    //    blank line itself terminates the block and is a safe boundary.
    if (inHtmlBlock) {
      if (line.trim() !== "") {
        current.push(line);
        offset += lineLength;
        continue;
      }
      inHtmlBlock = false;
    }

    // 3. Opening fence — a closed fence is a 100% certain boundary.
    const opening = OPENING_FENCE.exec(line.trimStart());
    if (opening) {
      commit(true);
      blockStart = offset;
      fence = opening[1] ?? "```";
      current.push(line);
      offset += lineLength;
      continue;
    }

    // 4. Raw HTML block start — must swallow following lines, fences included.
    if (HTML_BLOCK_START.test(line)) {
      inHtmlBlock = true;
      current.push(line);
      offset += lineLength;
      continue;
    }

    // 5. A blank line right after a committed boundary belongs to no block;
    //    skipping it keeps block content starting at a real line.
    if (line.trim() === "" && current.length === 0) {
      offset += lineLength;
      blockStart = offset;
      continue;
    }

    // 6. Display math ($$ … $$) — same certainty as a closed fence.
    if (line.trim() === "$$") {
      if (inMathBlock) {
        current.push(line);
        offset += lineLength;
        commit(true);
        blockStart = offset;
        inMathBlock = false;
      } else {
        commit(true);
        blockStart = offset;
        inMathBlock = true;
        current.push(line);
        offset += lineLength;
      }
      continue;
    }
    if (inMathBlock) {
      current.push(line);
      offset += lineLength;
      continue;
    }

    // 7. Blank line — only a boundary when the next line cannot continue this block.
    if (line.trim() === "" && current.length > 0) {
      const next = lines[index + 1];
      if (next !== undefined && !isAmbiguousContinuation(next)) {
        commit(true);
        offset += lineLength;
        blockStart = offset;
        continue;
      }
    }

    current.push(line);
    offset += lineLength;
  }

  // Whatever is left is still growing.
  commit(false);
  return blocks;
}
