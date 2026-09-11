import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { BookOpen, MessageSquarePlus, Plus } from "lucide-react";
import { FloatingMenu, type AnchorRect } from "./FloatingMenu.tsx";
import { t, type Locale } from "../lib/i18n.ts";
import {
  selectionSource,
  type MessageSelection,
  type SelectionAction,
} from "../lib/text-selection.ts";
import type { TimelineItem } from "../lib/timeline.ts";

export function TextSelectionMenu(props: {
  rootRef: RefObject<HTMLDivElement | null>;
  items: TimelineItem[];
  locale: Locale;
  onAction: (action: SelectionAction, selection: MessageSelection) => void;
  actions?: readonly SelectionAction[];
  testId?: string;
}) {
  const [selected, setSelected] = useState<{
    selection: MessageSelection;
    anchor: AnchorRect;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setSelected(null), []);
  const itemsRef = useRef(props.items);
  itemsRef.current = props.items;

  useEffect(() => {
    let dragging = false;
    let frame = 0;
    const readSelection = () => {
      if (dragging || menuRef.current?.contains(document.activeElement)) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return dismiss();
      const range = selection.getRangeAt(0);
      const source = selectionSource(range.startContainer);
      if (
        !source ||
        !props.rootRef.current?.contains(source) ||
        source !== selectionSource(range.endContainer)
      )
        return dismiss();
      const text = selection.toString().trim();
      const item = itemsRef.current.find((item) => item.id === source.dataset.selectionMessage);
      if (!text || item?.kind !== "assistant") return dismiss();
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      const rect = rects[0];
      if (!rect) return dismiss();
      const viewport = source
        .closest(".timeline-scroll, .selection-side-chat-messages")
        ?.getBoundingClientRect();
      if (viewport && (rect.bottom < viewport.top || rect.top > viewport.bottom)) return dismiss();
      setSelected({
        selection: { messageId: item.id, text, context: item.text },
        anchor: {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
        },
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(readSelection);
    };
    const down = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      dragging = true;
      dismiss();
    };
    const up = (event: PointerEvent) => {
      dragging = false;
      if (menuRef.current?.contains(event.target as Node)) return;
      const source = selectionSource(event.target as Node);
      // Buttons keep the old browser selection. Only a gesture in response text
      // should reopen its menu after an outside click or Escape dismissed it.
      if (source && props.rootRef.current?.contains(source)) schedule();
      else cancelAnimationFrame(frame);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") return;
      if (
        event.key === "ArrowDown" &&
        !event.shiftKey &&
        menuRef.current &&
        !menuRef.current.contains(document.activeElement)
      ) {
        event.preventDefault();
        menuRef.current.querySelector<HTMLButtonElement>("button")?.focus();
        return;
      }
      if (event.shiftKey && /Arrow|Home|End/.test(event.key)) schedule();
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", dismiss);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", dismiss);
    };
  }, [props.rootRef, dismiss]);

  return (
    <FloatingMenu
      open={selected !== null}
      anchor={selected?.anchor ?? null}
      onClose={dismiss}
      placement="top"
      minWidth={220}
      testId={props.testId ?? "text-selection-menu"}
      ariaLabel={t(props.locale, "selection.menu")}
    >
      <div
        ref={menuRef}
        className="px-1"
        onMouseDown={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          let next: number;
          if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
          else if (event.key === "ArrowUp") next = (index + buttons.length - 1) % buttons.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = buttons.length - 1;
          else return;
          event.preventDefault();
          buttons[next]?.focus();
        }}
      >
        {(
          [
            ["add", Plus, "selection.add"],
            ["explain", BookOpen, "selection.explain"],
            ["ask", MessageSquarePlus, "selection.ask"],
          ] as const
        )
          .filter(([action]) => !props.actions || props.actions.includes(action))
          .map(([action, Icon, label]) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              data-testid={`selection-${action}`}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-[var(--hover-fill)] focus-visible:bg-[var(--hover-fill)] focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                if (!selected) return;
                const value = selected.selection;
                dismiss();
                window.getSelection()?.removeAllRanges();
                props.onAction(action, value);
              }}
            >
              <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
              {t(props.locale, label)}
            </button>
          ))}
      </div>
    </FloatingMenu>
  );
}
