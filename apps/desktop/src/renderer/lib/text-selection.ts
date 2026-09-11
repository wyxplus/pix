export interface MessageSelection {
  messageId: string;
  text: string;
  context: string;
}

export type SelectionAction = "add" | "explain" | "ask";

/** Append the selected text without introducing Markdown quote markers. */
export function appendSelectedText(draft: string, text: string): string {
  const selected = text.trim();
  if (!selected) return draft;
  return `${draft.trimEnd()}${draft.trim() ? "\n\n" : ""}${selected}\n\n`;
}

export function selectionSource(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  if (element?.closest('button, input, textarea, [contenteditable="true"]')) return null;
  return element?.closest<HTMLElement>("[data-selection-message]") ?? null;
}
