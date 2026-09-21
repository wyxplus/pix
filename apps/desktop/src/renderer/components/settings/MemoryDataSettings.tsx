import { useEffect, useState } from "react";
import type { ArchiveSummary, StorageProfileView, NativeTransferPreview } from "@pix/contracts";
import { useSideChatStore } from "../../store/side-chat-store.ts";
import {
  SettingsButton,
  SettingsRow,
  SettingsSectionBlock,
  SettingsToggle,
} from "./SettingsPrimitives.tsx";

export function MemoryDataSettings({
  zh,
  cwd,
  changed,
}: {
  zh: boolean;
  cwd: string | undefined;
  changed: () => Promise<void>;
}) {
  const [storage, setStorage] = useState<StorageProfileView>();
  const [archives, setArchives] = useState<ArchiveSummary[]>([]);
  const [personal, setPersonal] = useState(true);
  const [project, setProject] = useState(false);
  const [sessions, setSessions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [transfer, setTransfer] = useState<NativeTransferPreview>();
  async function refresh() {
    const [next, imported] = await Promise.all([
      window.pix.data.storage.state(),
      window.pix.data.archives.list(),
    ]);
    setStorage(next);
    setArchives(imported);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);
  async function run(action: () => Promise<string | undefined>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const message = await action();
      if (message) setMessage(message);
      await refresh();
      await changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function exportData(format: "pix" | "markdown") {
    void run(async () => {
      const result = await window.pix.data.archives.exportPick({
        personal,
        project,
        sessions,
        ...(cwd ? { cwd } : {}),
        format,
      });
      return result ? [result.path, ...result.warnings].join("\n") : undefined;
    });
  }
  return (
    <>
      <SettingsSectionBlock label={zh ? "导出与导入" : "Export and import"}>
        <SettingsRow
          title={zh ? "个人记忆" : "Personal memories"}
          control={<SettingsToggle checked={personal} onChange={setPersonal} disabled={busy} />}
        />
        <SettingsRow
          title={zh ? "当前项目记忆" : "Current project memories"}
          control={
            <SettingsToggle checked={project} onChange={setProject} disabled={!cwd || busy} />
          }
        />
        <SettingsRow
          title={zh ? "当前项目全部会话" : "All current project conversations"}
          description={
            zh
              ? "包括所有分支、已归档会话、旁聊及可读取的附件。缺失或未授权附件会单独列出；原始对话可能仍包含已遗忘内容。"
              : "Includes all branches, archived conversations, side chats and readable attachments. Missing or unauthorized attachments are listed; original messages may contain forgotten facts."
          }
          control={
            <SettingsToggle checked={sessions} onChange={setSessions} disabled={!cwd || busy} />
          }
          last
        />
        <div className="p-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            <SettingsButton
              disabled={busy || !(personal || project || sessions)}
              onClick={() => exportData("pix")}
            >
              {zh ? "导出 Pix 归档" : "Export Pix archive"}
            </SettingsButton>
            <SettingsButton
              disabled={busy || !(personal || project || sessions)}
              onClick={() => exportData("markdown")}
            >
              {zh ? "导出 Markdown" : "Export Markdown"}
            </SettingsButton>
            <SettingsButton
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const imported = await window.pix.data.archives.importPick();
                  return imported
                    ? zh
                      ? "归档已导入，尚未写入记忆或执行任何会话。"
                      : "Archive imported. No memories adopted or conversations executed."
                    : undefined;
                })
              }
            >
              {zh ? "导入 Pix 归档" : "Import Pix archive"}
            </SettingsButton>
          </div>
          <p className="text-xs opacity-60">
            {zh
              ? "Markdown 可供 Claude Code / Codex 阅读。此导出不会进入对方原生会话列表。"
              : "Claude Code / Codex can read Markdown as context. This export does not create a native conversation in either app."}
          </p>
          {archives.map((archive) => (
            <div className="rounded-lg border p-3 space-y-2" key={archive.id}>
              <p className="text-sm">
                {archive.createdAt.slice(0, 19).replace("T", " ")} · {archive.memoryCount}{" "}
                {zh ? "条记忆" : "memories"} · {archive.sessions.length}{" "}
                {zh ? "个会话" : "conversations"}
                {` · ${archive.attachmentCount ?? 0} ${zh ? "个附件" : "attachments"} · ${archive.sideChatCount ?? 0} ${zh ? "个旁聊" : "side chats"}`}
              </p>
              {archive.warnings.map((warning, index) => (
                <p key={index} className="text-xs opacity-70 break-words">
                  {warning}
                </p>
              ))}
              <SettingsButton
                disabled={busy || !(personal || project) || (project && !cwd)}
                onClick={() =>
                  void run(async () => {
                    const result = await window.pix.data.archives.restoreMemories({
                      archiveId: archive.id,
                      personal,
                      project,
                      ...(cwd ? { cwd } : {}),
                    });
                    return zh
                      ? `已采纳 ${result.imported} 条，跳过重复、已遗忘或未选范围 ${result.skipped} 条。`
                      : `Adopted ${result.imported}; skipped ${result.skipped} duplicate, forgotten, or unselected records.`;
                  })
                }
              >
                {zh ? "采纳已选范围的记忆" : "Adopt selected memory scopes"}
              </SettingsButton>
              {archive.sessions.map((session) => (
                <div className="flex items-center justify-between gap-2" key={session.id}>
                  <span className="truncate text-sm">{session.title}</span>
                  <SettingsButton
                    disabled={busy || !cwd}
                    onClick={() =>
                      void run(async () => {
                        await useSideChatStore.getState().hydrate();
                        await useSideChatStore.getState().flush();
                        const restored = await window.pix.data.archives.continueSession({
                          archiveId: archive.id,
                          sessionId: session.id,
                          cwd: cwd!,
                        });
                        await useSideChatStore.getState().mergeImported(restored.sideChats);
                        return zh
                          ? "会话已在当前项目打开。"
                          : "Conversation opened in the current project.";
                      })
                    }
                  >
                    {zh ? "在当前项目继续" : "Continue here"}
                  </SettingsButton>
                </div>
              ))}
              {archive.sessions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {(["claude", "codex"] as const).map((target) => (
                    <SettingsButton
                      key={target}
                      disabled={busy || !cwd}
                      onClick={() =>
                        void run(async () => {
                          setTransfer(
                            await window.pix.data.archives.previewNative({
                              archiveId: archive.id,
                              target,
                              cwd: cwd!,
                            }),
                          );
                          return undefined;
                        })
                      }
                    >
                      {zh
                        ? `预览迁出到 ${target === "claude" ? "Claude Code" : "Codex CLI"}`
                        : `Preview transfer to ${target === "claude" ? "Claude Code" : "Codex CLI"}`}
                    </SettingsButton>
                  ))}
                </div>
              )}
            </div>
          ))}
          {transfer && (
            <div className="border rounded-lg p-3 space-y-2" data-testid="native-transfer-preview">
              <p className="text-sm">
                {transfer.target} {transfer.version} · {transfer.sessions.length}{" "}
                {zh ? "个新会话" : "new conversations"}
              </p>
              <p className="text-xs break-all">{transfer.directory}</p>
              <p className="text-xs break-all">
                {zh ? "目标项目：" : "Target project: "}
                {transfer.cwd}
              </p>
              {transfer.warnings.map((warning, index) => (
                <p key={index} className="text-xs opacity-70">
                  {warning}
                </p>
              ))}
              <div className="flex gap-2">
                <SettingsButton
                  disabled={busy || transfer.delivered}
                  onClick={() =>
                    void run(async () => {
                      const result = await window.pix.data.archives.deliverNative(transfer.id);
                      setTransfer(result);
                      return zh
                        ? "已写入新会话。请在目标客户端刷新列表核验；未执行模型轮次。"
                        : "New conversations delivered. Refresh the target client to verify; no model turn was executed.";
                    })
                  }
                >
                  {transfer.delivered
                    ? zh
                      ? "已交付"
                      : "Delivered"
                    : zh
                      ? "确认写入目标目录"
                      : "Confirm delivery"}
                </SettingsButton>
                <SettingsButton disabled={busy} onClick={() => setTransfer(undefined)}>
                  {zh ? "关闭预览" : "Close preview"}
                </SettingsButton>
              </div>
            </div>
          )}
        </div>
      </SettingsSectionBlock>
      <SettingsSectionBlock label={zh ? "数据存储位置" : "Data storage"}>
        <div className="p-3 space-y-3 text-sm">
          {storage && (
            <>
              <p className="break-all">
                {zh ? "数据目录：" : "Data: "}
                {storage.root}
              </p>
              <p className="break-all">
                {zh ? "Agent 配置：" : "Agent configuration: "}
                {storage.agent}
                {storage.externalAgent
                  ? zh
                    ? "（由环境变量指定，迁移时保留）"
                    : " (environment override, preserved during migration)"
                  : ""}
              </p>
              <p className="text-xs opacity-60">
                {zh
                  ? "选择新目录后，下次启动先复制并校验，再切换路径。旧目录保留。系统配置目录只保留路径定位文件；macOS 便携数据位于应用包之外。含符号链接的旧目录需要手动处理。"
                  : "On next launch, Pix copies and verifies data before switching. Original files remain. A small locator stays in the system config directory; macOS portable data stays outside the app bundle. Symlinks require manual migration."}
              </p>
              {storage.migrationError && (
                <p role="alert" className="text-destructive break-all">
                  {storage.migrationError}
                </p>
              )}
              {storage.pendingRoot && (
                <p className="break-all">
                  {zh ? "重启后迁移到：" : "Migration on restart: "}
                  {storage.pendingRoot}
                </p>
              )}
              <div className="flex gap-2">
                <SettingsButton
                  disabled={
                    busy ||
                    storage.mode === "environment" ||
                    storage.mode === "portable" ||
                    Boolean(storage.pendingRoot)
                  }
                  onClick={() =>
                    void run(async () => {
                      const result = await window.pix.data.storage.choose();
                      return result
                        ? zh
                          ? "迁移已安排，请正常退出 Pix 后重新启动。"
                          : "Migration scheduled. Quit and restart Pix normally."
                        : undefined;
                    })
                  }
                >
                  {zh ? "选择新目录" : "Choose new location"}
                </SettingsButton>
                {storage.pendingRoot && (
                  <SettingsButton
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await window.pix.data.storage.cancel();
                        return zh ? "已取消待执行迁移。" : "Pending migration cancelled.";
                      })
                    }
                  >
                    {zh ? "取消迁移" : "Cancel migration"}
                  </SettingsButton>
                )}
              </div>
            </>
          )}
        </div>
      </SettingsSectionBlock>
      {message && (
        <p role="status" className="text-sm whitespace-pre-wrap break-words p-3">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive p-3">
          {error}
        </p>
      )}
    </>
  );
}
