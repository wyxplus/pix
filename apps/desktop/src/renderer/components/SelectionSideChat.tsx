import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ChevronDown,
  MessageSquareText,
  MessageSquarePlus,
  Quote,
  RotateCcw,
  X,
} from "lucide-react";
import type { HostSnapshot, PackageSummary } from "@pix/contracts";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs.tsx";
import { Button } from "./ui/button.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { Composer, type ComposerModelOption, type AccessVisibility } from "./Composer.tsx";
import { ComposerAttachmentList } from "./ComposerAttachmentList.tsx";
import { TextSelectionMenu } from "./TextSelectionMenu.tsx";
import { t, type Locale } from "../lib/i18n.ts";
import { isImeCompositionEvent } from "../lib/composer-keyboard.ts";
import { useSideChatStore } from "../store/side-chat-store.ts";
import { useShellStore } from "../store/shell-store.ts";
import {
  clampToAvailableThinkingLevel,
  resolveDisplayThinkingLevels,
} from "../lib/thinking-levels.ts";
import { resolveDisplayServiceTiers } from "../lib/service-tier.ts";

export function SelectionSideChat(props: {
  locale: Locale;
  chatId: string;
  snapshot: HostSnapshot;
  modelOptions: ComposerModelOption[];
  accessVisibility: AccessVisibility;
  packages: PackageSummary[];
  workspacePath?: string | undefined;
  onClose: (id: string) => void;
  onAdd: (text: string) => void;
}) {
  const chat = useSideChatStore((state) => state.chats[props.chatId]!);
  const allChats = useSideChatStore((state) => state.chats);
  const tabs = Object.values(allChats).filter((item) => item.sessionKey === chat.sessionKey);
  const store = useSideChatStore.getState;
  const [expanded, setExpanded] = useState(false);
  const [following, setFollowing] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectionItems = useMemo(
    () =>
      chat.messages.map((message) => ({
        id: message.id,
        kind: message.role,
        text: message.text,
      })),
    [chat.messages],
  );
  const pending = chat.status === "streaming";
  const tr = (key: Parameters<typeof t>[1]) => t(props.locale, key);
  const model = chat.settings.model;
  const modelOption = props.modelOptions.find(
    (option) => option.provider === model?.provider && option.id === model?.id,
  );
  const isSourceModel =
    model?.provider === props.snapshot.model?.provider && model?.id === props.snapshot.model?.id;
  const thinkingLevels = resolveDisplayThinkingLevels(
    modelOption?.availableThinkingLevels ??
      (isSourceModel ? props.snapshot.availableThinkingLevels : undefined),
  );
  const serviceTiers = resolveDisplayServiceTiers(
    modelOption?.availableServiceTiers ??
      (isSourceModel ? props.snapshot.availableServiceTiers : undefined),
  );

  useEffect(() => {
    setExpanded(false);
    setFollowing(true);
    if (!document.activeElement?.closest('[role="tablist"]')) inputRef.current?.focus();
    document
      .getElementById(`side-chat-tab-${chat.id}`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [chat.id]);
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (following && viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [chat.messages, chat.status, following]);

  function send() {
    if (pending || (!chat.draft.trim() && !chat.attachments.length)) return;
    setFollowing(true);
    void store().send(chat.id);
  }
  function addAttachments(paths: string[]) {
    const current = store().chats[props.chatId];
    if (current) store().setAttachments(current.id, [...current.attachments, ...paths]);
  }

  return (
    <Tabs value={chat.id} onValueChange={(id) => store().activate(id)} asChild>
      <aside
        className="selection-side-chat"
        aria-label={tr("selection.sideChat")}
        data-testid="selection-side-chat"
        onKeyDown={(event) => {
          // Composer menus consume Escape first; closing a menu must not delete the chat.
          if (
            event.key === "Escape" &&
            !event.defaultPrevented &&
            !isImeCompositionEvent(event.nativeEvent)
          ) {
            event.stopPropagation();
            props.onClose(chat.id);
          }
        }}
      >
        <header className="flex shrink-0 items-center gap-2 px-4 py-3">
          <MessageSquareText className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
          <h2 className="min-w-0 flex-1 text-sm font-medium">{tr("selection.sideChat")}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={tr("selection.close")}
            title={tr("selection.close")}
            data-testid="selection-side-chat-close"
            onClick={() => props.onClose(chat.id)}
          >
            <X className="size-4" />
          </Button>
        </header>
        <TabsList
          variant="line"
          className="selection-side-chat-tabs"
          aria-label={tr("selection.tabs")}
          data-testid="side-chat-tabs"
        >
          {tabs.map((tab) => {
            const title = (
              tab.messages.find((message) => message.role === "user")?.text || tab.selection.text
            )
              .replace(/\s+/g, " ")
              .trim();
            return (
              <div
                key={tab.id}
                className="selection-side-chat-tab"
                data-active={tab.id === chat.id}
              >
                <TabsTrigger
                  value={tab.id}
                  id={`side-chat-tab-${tab.id}`}
                  data-testid="side-chat-tab"
                  title={title}
                >
                  <span className="truncate">{title.slice(0, 36)}</span>
                  {tab.status === "streaming" ? (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-current"
                      aria-label={tr("selection.loading")}
                    />
                  ) : null}
                </TabsTrigger>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="selection-side-chat-tab-close"
                  data-testid="side-chat-tab-close"
                  title={t(props.locale, "selection.closeTab", { title: title.slice(0, 36) })}
                  aria-label={t(props.locale, "selection.closeTab", { title: title.slice(0, 36) })}
                  onClick={() => props.onClose(tab.id)}
                >
                  <X className="size-3" />
                </Button>
              </div>
            );
          })}
        </TabsList>
        <TabsContent
          value={chat.id}
          aria-labelledby={`side-chat-tab-${chat.id}`}
          className="selection-side-chat-content"
        >
          <div className="relative min-h-0 flex-1">
            <div
              ref={scrollRef}
              className="selection-side-chat-messages"
              data-testid="selection-side-chat-messages"
              role="log"
              aria-label={tr("selection.sideChat")}
              aria-busy={pending}
              onScroll={() => {
                const el = scrollRef.current;
                if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
              }}
            >
              {!chat.messages.length ? (
                <p className="py-5 text-sm text-muted-foreground">{tr("selection.hint")}</p>
              ) : null}
              {chat.messages.map((message) => (
                <div
                  key={message.id}
                  className={`selection-side-chat-message ${message.role}`}
                  data-role={message.role}
                >
                  {message.role === "user" ? (
                    <>
                      {message.attachments?.length ? (
                        <ComposerAttachmentList locale={props.locale} paths={message.attachments} />
                      ) : null}
                      <p className="whitespace-pre-wrap break-words">{message.text}</p>
                    </>
                  ) : (
                    <>
                      <div data-selection-message={message.id}>
                        <MarkdownContent locale={props.locale} workspacePath={props.workspacePath}>
                          {message.text}
                        </MarkdownContent>
                      </div>
                      {message.text && message.id !== chat.requestId ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="timeline-meta-btn mt-2"
                          title={tr("selection.add")}
                          aria-label={tr("selection.add")}
                          data-testid="side-chat-add-response"
                          onClick={() => props.onAdd(message.text)}
                        >
                          <MessageSquarePlus className="size-3.5" strokeWidth={1.6} aria-hidden />
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              ))}
              {pending ? (
                <p role="status" className="py-3 text-sm text-muted-foreground">
                  {tr("selection.loading")}
                </p>
              ) : null}
              {chat.error ? (
                <p role="alert" className="py-3 text-sm text-destructive">
                  {tr("selection.failed")} {chat.error}
                </p>
              ) : null}
              {chat.status === "stopped" ? (
                <p role="status" className="py-3 text-sm text-muted-foreground">
                  {tr("selection.stopped")}
                </p>
              ) : null}
              {chat.status === "failed" || chat.status === "stopped" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="selection-side-chat-retry"
                  onClick={() => {
                    setFollowing(true);
                    void store().send(chat.id, undefined, true);
                  }}
                >
                  <RotateCcw className="size-3.5" />
                  {tr("selection.retry")}
                </Button>
              ) : null}
            </div>
            {!following ? (
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="selection-side-chat-latest"
                aria-label={tr("selection.latest")}
                onClick={() => setFollowing(true)}
              >
                <ArrowDown className="size-4" />
              </Button>
            ) : null}
          </div>
          <TextSelectionMenu
            rootRef={scrollRef}
            items={selectionItems}
            locale={props.locale}
            actions={["add"]}
            testId="side-chat-selection-menu"
            onAction={(_action, selection) => props.onAdd(selection.text)}
          />
          <div className="selection-side-chat-composer">
            <Composer
              key={chat.id}
              surface="side"
              locale={props.locale}
              prompt={chat.draft}
              composerRef={inputRef}
              running={pending}
              onPromptChange={(text) => store().setDraft(chat.id, text)}
              onSubmit={(event) => {
                event?.preventDefault();
                send();
              }}
              onAbort={() => void store().stop(chat.id)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !isImeCompositionEvent(event.nativeEvent)
                ) {
                  event.preventDefault();
                  send();
                }
              }}
              workspacePath={props.workspacePath}
              showProjectBar={false}
              recentWorkspaces={[]}
              onOpenProject={() => {}}
              onAddProject={() => {}}
              accessMode={chat.settings.accessMode}
              accessVisibility={props.accessVisibility}
              onAccessMode={(accessMode) =>
                store().setSettings(chat.id, { ...chat.settings, accessMode })
              }
              modelOptions={props.modelOptions}
              modelValue={model ? `${model.provider}/${model.id}` : ""}
              onModelChange={(provider, id) => {
                const target = props.modelOptions.find(
                  (option) => option.provider === provider && option.id === id,
                );
                store().setSettings(chat.id, {
                  ...chat.settings,
                  model: { provider, id },
                  thinkingLevel: clampToAvailableThinkingLevel(
                    chat.settings.thinkingLevel,
                    target?.availableThinkingLevels ?? ["off"],
                  ),
                  serviceTier: "default",
                });
              }}
              thinkingLevel={chat.settings.thinkingLevel}
              thinkingLevels={thinkingLevels}
              onThinkingChange={(thinkingLevel) =>
                store().setSettings(chat.id, { ...chat.settings, thinkingLevel })
              }
              serviceTier={chat.settings.serviceTier}
              serviceTiers={serviceTiers}
              onServiceTierChange={(serviceTier) =>
                store().setSettings(chat.id, { ...chat.settings, serviceTier })
              }
              contextPercent={undefined}
              contextTokens={undefined}
              showContextUsage={false}
              projectTrusted={props.snapshot.projectTrusted}
              runState={chat.status}
              piThemeLabel=""
              attachments={chat.attachments}
              onPickAttachments={async (mode = "files") => {
                try {
                  addAttachments(await window.pix.workspace.pickAttachments({ mode }));
                } catch (error) {
                  useShellStore
                    .getState()
                    .showAppError(error instanceof Error ? error.message : String(error));
                }
              }}
              onRemoveAttachment={(path) =>
                store().setAttachments(
                  chat.id,
                  chat.attachments.filter((item) => item !== path),
                )
              }
              onAddAttachments={addAttachments}
              packages={props.packages}
              slashCommands={props.snapshot.slashCommands ?? []}
              queuedMessages={{ steering: [], followUp: [] }}
              onClearQueue={() => {}}
              contextHeader={
                <div className="selection-side-chat-reference">
                  <button
                    type="button"
                    className="selection-side-chat-reference-toggle"
                    aria-expanded={expanded}
                    onClick={() => setExpanded(!expanded)}
                  >
                    <Quote className="size-3.5 shrink-0" />
                    <span className="flex-1 text-left">{tr("selection.reference")}</span>
                    <ChevronDown className={`size-3.5 ${expanded ? "rotate-180" : ""}`} />
                  </button>
                  <blockquote
                    className="selection-side-chat-quote"
                    data-expanded={expanded}
                    data-testid="selection-side-chat-quote"
                  >
                    {chat.selection.text}
                  </blockquote>
                </div>
              }
            />
          </div>
        </TabsContent>
      </aside>
    </Tabs>
  );
}
