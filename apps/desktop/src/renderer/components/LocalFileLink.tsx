import { useId, useRef, useState } from "react";
import { Ellipsis, ExternalLink, FileCode2, FolderOpen } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ContentLinkTarget } from "../lib/content-rendering.ts";
import { t, type Locale } from "../lib/i18n.ts";
import { cn } from "../lib/utils.ts";

/** A local reference stays inline with prose; native actions only run on user input. */
export function LocalFileLink(props: {
  target: Extract<ContentLinkTarget, { kind: "file" }>;
  href: string;
  label: string;
  locale: Locale;
  className?: string | undefined;
  id?: string | undefined;
}) {
  const { target, locale } = props;
  const fullPath = `${target.path}${target.line ? `:${target.line}${target.column ? `:${target.column}` : ""}` : ""}`;
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const errorId = useId();

  async function run(action: "open" | "reveal") {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const workspace = window.pix?.workspace;
      if (action === "open") {
        if (!workspace?.openFile) throw new Error(t(locale, "fileLink.desktopOnly"));
        await workspace.openFile(target.path, {
          ...(target.line ? { line: target.line } : {}),
          ...(target.column ? { column: target.column } : {}),
        });
      } else {
        if (!workspace?.revealInFolder) throw new Error(t(locale, "fileLink.desktopOnly"));
        await workspace.revealInFolder(target.path);
      }
    } catch (cause) {
      // IPC errors can carry sidecar stderr. Show the operation's reason, not logs.
      let detail = (cause instanceof Error ? cause.message : String(cause))
        .split(/\r?\n|\s+\(node:\d+\)/, 1)[0]!
        .replace(/^pix:workspace:(?:open-file|reveal-in-folder):\s*/, "")
        .trim();
      if (/ENOENT|no such file/i.test(detail)) detail = t(locale, "fileLink.missing");
      else if (/not authorized/i.test(detail)) detail = t(locale, "fileLink.outsideWorkspace");
      else if (/no associated application/i.test(detail))
        detail = t(locale, "fileLink.noApplication");
      else if (detail.length > 240) detail = `${detail.slice(0, 240)}…`;
      setError(
        `${t(locale, action === "open" ? "fileLink.openFailed" : "fileLink.revealFailed")}: ${detail}`,
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <span className="content-file-reference">
      <span className="content-file-actions" aria-busy={busy}>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={props.href}
                id={props.id}
                title={fullPath}
                aria-disabled={busy || undefined}
                aria-describedby={error ? errorId : undefined}
                className={cn("content-file-link content-source-cite", props.className)}
                onClick={(event) => {
                  event.preventDefault();
                  void run("open");
                }}
              >
                <FileCode2 className="content-source-cite-icon" aria-hidden strokeWidth={1.75} />
                <span className="content-source-cite-label">{props.label}</span>
                {target.line != null ? (
                  <span className="content-source-line" aria-hidden>
                    :{target.line}
                    {target.column != null ? `:${target.column}` : ""}
                  </span>
                ) : null}
              </a>
            </TooltipTrigger>
            <TooltipContent className="content-file-path-tooltip" showArrow={false}>
              {fullPath}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="content-file-menu-trigger"
              aria-label={`${t(locale, "fileLink.actions")}: ${props.label}`}
              title={t(locale, "fileLink.actions")}
              disabled={busy}
            >
              <Ellipsis aria-hidden strokeWidth={1.75} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="content-file-menu">
            <DropdownMenuItem disabled={busy} onSelect={() => void run("open")}>
              <ExternalLink aria-hidden />
              {t(locale, "fileLink.open")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => void run("reveal")}>
              <FolderOpen aria-hidden />
              {t(locale, "fileLink.reveal")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      {error ? (
        <span id={errorId} role="alert" className="content-file-error">
          {error}
        </span>
      ) : null}
    </span>
  );
}
