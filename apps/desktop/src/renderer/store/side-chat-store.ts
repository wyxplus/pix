import { create } from "zustand";
import type { SavedSideChat, SideChatArchive, PixDesktopApi } from "@pix/contracts";
import type { MessageSelection } from "../lib/text-selection.ts";
import { unwrapRemoteIpcError } from "../../shared/ipc-error.ts";
import { isPromptImagePath, promptWithAttachedPaths } from "../lib/composer-suggestions.ts";

export type SideChat = SavedSideChat;
export type SideChatMessage = SideChat["messages"][number];
export type SideChatSettings = SideChat["settings"];
type SideChatStorage = Pick<PixDesktopApi["sideChats"], "load" | "save">;

type SideChatState = {
  chats: Record<string, SideChat>;
  activeBySession: Record<string, string>;
  hydrated: boolean;
  persistenceError: string;
  hydrate: () => Promise<void>;
  flush: () => Promise<void>;
  activate: (id: string) => void;
  bindSession: (sessionKey: string, sessionId: string) => void;
  open: (
    sessionKey: string,
    sessionId: string,
    selection: MessageSelection,
    sourceMessages: SideChat["sourceMessages"],
    settings?: SideChatSettings,
  ) => string;
  close: (id: string) => void;
  setSettings: (id: string, settings: SideChatSettings) => void;
  setAttachments: (id: string, paths: string[]) => void;
  setDraft: (id: string, draft: string) => void;
  delta: (requestId: string, delta: string) => void;
  send: (id: string, question?: string, retry?: boolean) => Promise<void>;
  stop: (id: string) => Promise<void>;
};

export function createSideChatStore(storage: SideChatStorage) {
  let hydration: Promise<void> | undefined;
  let pending: SideChatArchive | undefined;
  let writing: Promise<void> | undefined;
  const store = create<SideChatState>((set, get) => {
    function update(id: string, fn: (chat: SideChat) => SideChat) {
      set((state) => {
        const chat = state.chats[id];
        return chat ? { chats: { ...state.chats, [id]: fn(chat) } } : state;
      });
    }
    return {
      chats: {},
      activeBySession: {},
      hydrated: false,
      persistenceError: "",
      hydrate() {
        hydration ??= storage
          .load()
          .then((archive) => {
            const chats = Object.fromEntries(
              Object.entries(archive.chats).map(([id, chat]) => [
                id,
                {
                  ...chat,
                  status: chat.status === "streaming" ? ("stopped" as const) : chat.status,
                  requestId: undefined,
                },
              ]),
            );
            const activeBySession = { ...archive.activeBySession };
            for (const chat of Object.values(chats)) activeBySession[chat.sessionKey] ??= chat.id;
            set({ chats, activeBySession, hydrated: true, persistenceError: "" });
          })
          .catch((error: unknown) => {
            hydration = undefined;
            set({ persistenceError: String(error) });
            throw error;
          });
        return hydration;
      },
      async flush() {
        while (writing) await writing;
        if (get().persistenceError) throw new Error(get().persistenceError);
      },
      activate(id) {
        const chat = get().chats[id];
        if (chat)
          set((state) => ({
            activeBySession: { ...state.activeBySession, [chat.sessionKey]: id },
          }));
      },
      bindSession(sessionKey, sessionId) {
        for (const chat of Object.values(get().chats)) {
          if (chat.sessionKey === sessionKey && chat.sessionId !== sessionId)
            update(chat.id, (current) => ({ ...current, sessionId }));
        }
      },
      open(
        sessionKey,
        sessionId,
        selection,
        sourceMessages,
        settings = { thinkingLevel: "off", serviceTier: "default", accessMode: "default" },
      ) {
        if (!get().hydrated) throw new Error("Side chats have not loaded yet");
        const id = crypto.randomUUID();
        set((state) => ({
          activeBySession: { ...state.activeBySession, [sessionKey]: id },
          chats: {
            ...state.chats,
            [id]: {
              id,
              sessionKey,
              sessionId,
              selection,
              sourceMessages,
              messages: [],
              draft: "",
              attachments: [],
              settings,
              status: "idle",
              error: "",
            },
          },
        }));
        return id;
      },
      close(id) {
        const chat = get().chats[id];
        if (!chat) return;
        set((state) => {
          const chats = { ...state.chats };
          const activeBySession = { ...state.activeBySession };
          delete chats[id];
          if (activeBySession[chat.sessionKey] === id) {
            const siblings = Object.values(state.chats).filter(
              (item) => item.sessionKey === chat.sessionKey,
            );
            const index = siblings.findIndex((item) => item.id === id);
            const next = siblings[index + 1] ?? siblings[index - 1];
            if (next) activeBySession[chat.sessionKey] = next.id;
            else delete activeBySession[chat.sessionKey];
          }
          return { chats, activeBySession };
        });
        if (chat.requestId)
          void window.pix.agent.cancelSideChat(chat.requestId).catch(() => undefined);
      },
      setSettings(id, settings) {
        update(id, (chat) => ({ ...chat, settings }));
      },
      setAttachments(id, paths) {
        update(id, (chat) => ({ ...chat, attachments: [...new Set(paths)].slice(0, 12) }));
      },
      setDraft(id, draft) {
        update(id, (chat) => ({ ...chat, draft }));
      },
      delta(requestId, delta) {
        const chat = Object.values(get().chats).find((item) => item.requestId === requestId);
        if (!chat) return;
        update(chat.id, (current) => ({
          ...current,
          messages: current.messages.map((message) =>
            message.id === requestId ? { ...message, text: message.text + delta } : message,
          ),
        }));
      },
      async send(id, question, retry = false) {
        const chat = get().chats[id];
        if (!chat || chat.requestId) return;
        const lastUser = chat.messages.findLastIndex((message) => message.role === "user");
        const text = (retry ? chat.messages[lastUser]?.text : (question ?? chat.draft))?.trim();
        const attachments = retry
          ? (chat.messages[lastUser]?.attachments ?? [])
          : question === undefined
            ? chat.attachments
            : [];
        if (!text && !attachments.length) return;
        const history = retry ? chat.messages.slice(0, lastUser) : chat.messages;
        const messages: SideChatMessage[] = [
          ...history,
          { id: crypto.randomUUID(), role: "user", text: text ?? "", attachments },
        ];
        const requestId = crypto.randomUUID();
        update(id, (current) => ({
          ...current,
          messages: [...messages, { id: requestId, role: "assistant", text: "" }],
          draft: retry || question !== undefined ? current.draft : "",
          attachments: retry || question !== undefined ? current.attachments : [],
          status: "streaming",
          error: "",
          requestId,
        }));
        try {
          const answer = await window.pix.agent.sideChat({
            requestId,
            sessionId: chat.sessionId,
            selection: chat.selection.text,
            context: chat.selection.context,
            sourceMessages: chat.sourceMessages,
            ...chat.settings,
            messages: messages
              .filter((message) => message.text.trim() || message.attachments?.length)
              .map(({ role, text, attachments }) => ({
                role,
                text: promptWithAttachedPaths(text, attachments ?? []),
                ...(attachments?.some(isPromptImagePath)
                  ? { imagePaths: attachments.filter(isPromptImagePath) }
                  : {}),
              })),
          });
          update(id, (current) =>
            current.requestId !== requestId
              ? current
              : {
                  ...current,
                  messages: current.messages.map((message) =>
                    message.id === requestId ? { ...message, text: answer } : message,
                  ),
                  status: "idle",
                  requestId: undefined,
                },
          );
        } catch (cause) {
          update(id, (current) =>
            current.requestId !== requestId
              ? current
              : {
                  ...current,
                  status: "failed",
                  requestId: undefined,
                  error: unwrapRemoteIpcError(
                    cause instanceof Error ? cause.message : String(cause),
                  ),
                },
          );
        }
      },
      async stop(id) {
        const requestId = get().chats[id]?.requestId;
        if (!requestId) return;
        update(id, (chat) => ({ ...chat, requestId: undefined, status: "stopped" }));
        try {
          await window.pix.agent.cancelSideChat(requestId);
        } catch (cause) {
          update(id, (chat) =>
            chat.status !== "stopped"
              ? chat
              : {
                  ...chat,
                  error: unwrapRemoteIpcError(
                    cause instanceof Error ? cause.message : String(cause),
                  ),
                },
          );
        }
      },
    };
  });
  function savePending() {
    if (writing) return;
    writing = (async () => {
      while (pending) {
        const archive = pending;
        pending = undefined;
        await storage.save(archive);
      }
      store.setState({ persistenceError: "" });
    })()
      .catch((error: unknown) => {
        store.setState({ persistenceError: String(error) });
      })
      .finally(() => {
        writing = undefined;
        if (pending) savePending();
      });
  }
  store.subscribe((state, previous) => {
    if (
      !state.hydrated ||
      (state.chats === previous.chats && state.activeBySession === previous.activeBySession)
    )
      return;
    pending = { version: 1, chats: state.chats, activeBySession: state.activeBySession };
    savePending();
  });
  return store;
}

export const useSideChatStore = createSideChatStore({
  load: () => window.pix.sideChats.load(),
  save: (archive) => window.pix.sideChats.save(archive),
});
