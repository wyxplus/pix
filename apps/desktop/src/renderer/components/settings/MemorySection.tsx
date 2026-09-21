import { useCallback, useEffect, useState } from "react";
import type { MemoryPreferences, MemoryRecord, MemoryScope, MemoryState } from "@pix/contracts";
import { MemoryDataSettings } from "./MemoryDataSettings.tsx";
import type { Locale } from "../../lib/i18n.ts";
import {
  SettingsButton,
  SettingsInput,
  SettingsPageShell,
  SettingsRow,
  SettingsSectionBlock,
  SettingsSelect,
  SettingsTextarea,
  SettingsToggle,
} from "./SettingsPrimitives.tsx";

export function MemorySection({ locale, cwd }: { locale: Locale; cwd: string | undefined }) {
  const zh = locale === "zh";
  const [state, setState] = useState<MemoryState>();
  const [scope, setScope] = useState<MemoryScope>("user");
  const [projectId, setProjectId] = useState("");
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [query, setQuery] = useState("");
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState<MemoryRecord>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [clearRequested, setClearRequested] = useState(false);
  const refresh = useCallback(async () => {
    const value = await window.pix.memory.state();
    setState(value);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [refresh]);
  useEffect(() => {
    if (!cwd) {
      setProjectId("");
      return;
    }
    let cancelled = false;
    void window.pix.memory
      .project(cwd)
      .then((project) => {
        if (!cancelled) {
          setProjectId(project.id);
          void refresh().catch((e) => setError(String(e)));
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setProjectId("");
          if (!String(e).includes("no_project")) setError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, refresh]);
  useEffect(() => {
    let cancelled = false;
    if (scope === "project" && !projectId) {
      setRecords([]);
      return;
    }
    void window.pix.memory
      .list({ scope, ...(scope === "project" ? { projectId } : {}), query })
      .then((items) => {
        if (!cancelled) setRecords(items);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [scope, projectId, query, state]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void refresh().catch((e) => setError(String(e)));
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const enabled = scope === "user" ? state?.preferences.longTerm : state?.preferences.shortTerm;
  async function action(run: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await run();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function policy(patch: Partial<MemoryPreferences>) {
    if (!state) return;
    void action(() => window.pix.memory.preferences(patch, state.preferences.revision));
  }
  async function save() {
    await action(async () => {
      if (editing)
        await window.pix.memory.update({
          id: editing.id,
          expectedRevision: editing.revision,
          content,
        });
      else
        await window.pix.memory.create({
          scope,
          ...(scope === "project" ? { projectId } : {}),
          content,
          kind: "fact",
        });
      setContent("");
      setEditing(undefined);
    });
  }
  return (
    <SettingsPageShell title={zh ? "记忆" : "Memory"} testId="settings-memory">
      <SettingsSectionBlock label={zh ? "允许记住什么" : "What Pix may remember"}>
        <SettingsRow
          title={zh ? "长期记忆 · 个人" : "Long-term · Personal"}
          description={
            zh
              ? "跨项目和会话使用。关闭停止读取与写入，已保存内容仍保留。"
              : "Across projects and conversations. Turning off stops reads and writes; existing records remain."
          }
          control={
            <SettingsToggle
              testId="memory-long-term"
              checked={state?.preferences.longTerm ?? false}
              disabled={!state || busy}
              onChange={(longTerm) => policy({ longTerm })}
            />
          }
        />
        <SettingsRow
          title={zh ? "短期记忆 · 项目" : "Short-term · Project"}
          description={
            zh
              ? "在同一项目的会话之间保留知识，不会因时间自动删除。"
              : "Knowledge shared across conversations in one project, without automatic expiry."
          }
          control={
            <SettingsToggle
              testId="memory-short-term"
              checked={state?.preferences.shortTerm ?? false}
              disabled={!state || busy}
              onChange={(shortTerm) => policy({ shortTerm })}
            />
          }
          last
        />
      </SettingsSectionBlock>
      <SettingsSectionBlock label={zh ? "自动整理" : "Automatic learning"}>
        <SettingsRow
          title={zh ? "整理个人偏好" : "Learn personal preferences"}
          control={
            <SettingsToggle
              checked={state?.preferences.learnPersonal ?? true}
              disabled={!state?.preferences.longTerm || busy}
              onChange={(learnPersonal) => policy({ learnPersonal })}
            />
          }
        />
        <SettingsRow
          title={zh ? "整理项目知识" : "Learn project knowledge"}
          control={
            <SettingsToggle
              checked={state?.preferences.learnProject ?? true}
              disabled={!state?.preferences.shortTerm || busy}
              onChange={(learnProject) => policy({ learnProject })}
            />
          }
        />
        <SettingsRow
          title={zh ? "每日整理预算（Token 上限）" : "Daily learning budget (token allowance)"}
          description={
            zh
              ? "默认 0，不发起额外模型调用。仅处理开启后新增的用户消息，使用当前模型；按保守上界预占预算，不是实际账单。"
              : "Default 0: no extra model requests. Uses the current model for new user messages only. Reserves a conservative allowance, not measured billing."
          }
          control={
            <SettingsInput
              type="number"
              min={0}
              max={1000000}
              disabled={!state || busy}
              key={state?.preferences.revision}
              defaultValue={state?.preferences.dailyTokenBudget ?? 0}
              onBlur={(event) => {
                const dailyTokenBudget = Number(event.target.value);
                if (dailyTokenBudget !== state?.preferences.dailyTokenBudget)
                  policy({ dailyTokenBudget });
              }}
            />
          }
          last
        />
        {state && (
          <p className="p-3 text-xs opacity-60">
            {zh
              ? `已预占 ${state.learning.reservedTokens} Token · 已整理 ${state.learning.completed} · 待处理 ${state.learning.pending} · 失败 ${state.learning.failed}`
              : `Reserved ${state.learning.reservedTokens} tokens · Completed ${state.learning.completed} · Pending ${state.learning.pending} · Failed ${state.learning.failed}`}
          </p>
        )}
      </SettingsSectionBlock>
      {error && (
        <p role="alert" className="text-sm text-destructive py-2">
          {error}
        </p>
      )}
      <SettingsSectionBlock label={zh ? "管理记忆" : "Manage memories"}>
        <div className="space-y-3 p-3">
          <div className="flex gap-2">
            <SettingsSelect
              value={scope}
              onChange={(value) => {
                setRecords([]);
                setScope(value as MemoryScope);
                setClearRequested(false);
                setEditing(undefined);
                setContent("");
              }}
              options={[
                { value: "user", label: zh ? "个人" : "Personal" },
                { value: "project", label: zh ? "项目" : "Project" },
              ]}
            />
            {scope === "project" && (
              <SettingsSelect
                value={projectId}
                onChange={(value) => {
                  setRecords([]);
                  setProjectId(value);
                  setClearRequested(false);
                  setEditing(undefined);
                  setContent("");
                }}
                options={(state?.projects ?? []).map((project) => ({
                  value: project.id,
                  label: project.name,
                }))}
              />
            )}
          </div>
          <SettingsInput
            aria-label={zh ? "搜索记忆" : "Search memories"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={zh ? "搜索记忆" : "Search memories"}
          />
          <SettingsTextarea
            aria-label={zh ? "记忆内容" : "Memory content"}
            value={content}
            maxLength={4000}
            onChange={(e) => setContent(e.target.value)}
            placeholder={zh ? "写下希望 Pix 记住的内容" : "What should Pix remember?"}
            disabled={!enabled || busy}
          />
          <SettingsButton
            disabled={!enabled || busy || !content.trim() || (scope === "project" && !projectId)}
            onClick={() => void save()}
          >
            {editing ? (zh ? "保存修改" : "Save changes") : zh ? "记住" : "Remember"}
          </SettingsButton>
          {!enabled && (
            <p className="text-sm opacity-60">
              {zh
                ? "此层已关闭，内容仅供管理查看，不会提供给模型。"
                : "This layer is off. These records are visible for management only."}
            </p>
          )}
          {records.length === 0 && (
            <p className="text-sm opacity-60">{zh ? "暂无记忆" : "No memories yet"}</p>
          )}
          {records.map((item) => (
            <article key={item.id} className="rounded-lg border p-3 space-y-2">
              <p className="text-xs opacity-60">
                {item.status === "disputed"
                  ? zh
                    ? "待确认 · 暂不用于回答"
                    : "Needs review · excluded from answers"
                  : item.status === "superseded"
                    ? zh
                      ? "已取代 · 暂不用于回答"
                      : "Superseded · excluded from answers"
                    : item.origin === "explicit"
                      ? zh
                        ? "手动确认"
                        : "User confirmed"
                      : zh
                        ? "自动整理 / 导入"
                        : "Learned / imported"}
                {` · ${item.sources.length} ${zh ? "条来源" : "sources"}`}
              </p>
              <p className="text-sm whitespace-pre-wrap break-words">{item.content}</p>
              {item.conflicts?.length || item.status === "disputed" ? (
                <div className="text-xs space-y-1">
                  <p>{zh ? "与以下记忆存在冲突：" : "Conflicts with:"}</p>
                  {(item.conflicts ?? []).map((id) => (
                    <p key={id}>{records.find((record) => record.id === id)?.content ?? id}</p>
                  ))}
                  <div className="flex gap-2">
                    <SettingsButton
                      disabled={!enabled || busy}
                      onClick={() =>
                        void action(() =>
                          window.pix.memory.resolve({
                            id: item.id,
                            expectedRevision: item.revision,
                            choice: "keep",
                          }),
                        )
                      }
                    >
                      {zh ? "保留此条，取代冲突项" : "Keep this; supersede conflicts"}
                    </SettingsButton>
                    <SettingsButton
                      disabled={!enabled || busy}
                      onClick={() =>
                        void action(() =>
                          window.pix.memory.resolve({
                            id: item.id,
                            expectedRevision: item.revision,
                            choice: "discard",
                          }),
                        )
                      }
                    >
                      {zh ? "舍弃此条" : "Discard this"}
                    </SettingsButton>
                  </div>
                </div>
              ) : null}
              <div className="flex gap-2">
                <SettingsButton
                  disabled={!enabled || busy}
                  onClick={() => {
                    setEditing(item);
                    setContent(item.content);
                  }}
                >
                  {zh ? "编辑" : "Edit"}
                </SettingsButton>
                <SettingsButton
                  disabled={busy}
                  onClick={() => void action(() => window.pix.memory.forget([item.id]))}
                >
                  {zh ? "遗忘" : "Forget"}
                </SettingsButton>
              </div>
            </article>
          ))}
        </div>
      </SettingsSectionBlock>
      <div className="py-3 space-y-2">
        <SettingsButton
          disabled={busy || (scope === "project" && !projectId)}
          onClick={() => {
            if (!clearRequested) {
              setClearRequested(true);
              return;
            }
            void action(async () => {
              await window.pix.memory.clear({
                scope,
                ...(scope === "project" ? { projectId } : {}),
              });
              setClearRequested(false);
              setEditing(undefined);
              setContent("");
            });
          }}
        >
          {clearRequested
            ? zh
              ? "确认清空此范围全部记忆"
              : "Confirm clearing all memories in this scope"
            : zh
              ? "清空此范围记忆"
              : "Clear this memory scope"}
        </SettingsButton>
        {clearRequested && (
          <p className="text-xs opacity-60">
            {zh
              ? "包括搜索结果之外的记录；原始对话仍会保留。"
              : "Includes records outside the search results. Original conversations remain."}
          </p>
        )}
      </div>
      <MemoryDataSettings zh={zh} cwd={projectId ? cwd : undefined} changed={refresh} />
    </SettingsPageShell>
  );
}
