// Experimental request translations for the pinned SDK. No dependency files are patched.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CONTENT_LANGUAGE_INSTRUCTIONS as policy } from "../src/content-language.ts";
import { translateDefault } from "./content-language-probe-translations.mjs";

const skillGuidance = new Map([
  [
    "The following skills provide specialized instructions for specific tasks.",
    "以下技能为特定任务提供专门说明。",
  ],
  [
    "Use the read tool to load a skill's file when the task matches its description.",
    "任务与技能描述匹配时，使用 read 工具加载该技能文件。",
  ],
  [
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "技能文件引用相对路径时，以技能目录（SKILL.md 的父目录，即该路径的 dirname）为基准解析，并在工具命令中使用该绝对路径。",
  ],
]);

const descriptions = new Map([
  [
    "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
    "读取文件内容。支持文本文件和图片（jpg、png、gif、webp、bmp）。图片作为附件发送。文本输出在达到 2000 行或 50KB 时截断，以先达到者为准。大文件请使用 offset/limit。需要完整文件时，继续使用 offset 读取，直到读完。",
  ],
  ["Path to the file to read (relative or absolute)", "要读取的文件路径（相对或绝对路径）"],
  ["Line number to start reading from (1-indexed)", "开始读取的行号（从 1 开始）"],
  ["Maximum number of lines to read", "最多读取的行数"],
  [
    "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
    "在当前工作目录执行 bash 命令。返回标准输出和标准错误。输出最多保留最后 2000 行或 50KB，以先达到者为准。发生截断时，完整输出保存到临时文件。可以指定以秒为单位的超时时间。",
  ],
  ["Shell command to execute", "要执行的命令行命令"],
  ["Timeout in seconds (optional, no default timeout)", "超时时间，单位为秒（可选，默认不设超时）"],
  [
    "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    "通过精确文本替换修改单个文件。每个 edits[].oldText 必须匹配原文件中唯一且互不重叠的区域。如果两项修改影响同一区块或相邻行，请合并成一项修改，不要生成重叠修改。不要仅为连接相距较远的修改而包含大量未改变的区域。",
  ],
  ["Path to the file to edit (relative or absolute)", "要修改的文件路径（相对或绝对路径）"],
  [
    "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    "一项或多项目标替换。每项修改都匹配原始文件，而非逐步修改后的文件。不要包含重叠或嵌套修改。如果两项修改涉及同一区块或相邻行，请将它们合并为一项。",
  ],
  [
    "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
    "一项目标替换需要精确匹配的文本。它必须在原始文件中唯一，并且不得与同次调用的其他 edits[].oldText 重叠。",
  ],
  ["Replacement text for this targeted edit.", "本项目标修改要替换成的文本。"],
  [
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    "将内容写入文件。文件不存在时创建，已存在时覆盖。自动创建父目录。",
  ],
  ["Path to the file to write (relative or absolute)", "要写入的文件路径（相对或绝对路径）"],
  ["Content to write to the file", "要写入文件的内容"],
]);

export function translateSdkSystem(system) {
  let translated = translateDefault(system);
  for (const [english, chinese] of skillGuidance) {
    assert(translated.includes(english), `Missing expected SDK guidance: ${english}`);
    translated = translated.replace(english, chinese);
  }
  return translated;
}

function withoutDescriptions(value) {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description")
      .map(([key, child]) => [key, withoutDescriptions(child)]),
  );
}

export function translateTools(tools) {
  let count = 0;
  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key !== "description") return [key, visit(child)];
        assert(descriptions.has(child), `Untranslated tool description: ${child}`);
        count++;
        return [key, descriptions.get(child)];
      }),
    );
  }
  const originals = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const translated = visit(originals);
  assert.deepEqual(withoutDescriptions(translated), withoutDescriptions(originals));
  assert.equal(
    count,
    descriptions.size,
    "All four tools and their parameter descriptions must be covered.",
  );
  return { tools: translated, descriptionCount: count };
}

const languageLines = [
  "内容语言：",
  "所有面向用户的自然语言，包括回答、计划、进度说明，以及模型支持控制语言时的可见思考文字或推理摘要，都使用用户的语言。这不要求披露隐藏推理。",
  "遵循用户明确的语言要求，包括持续偏好和特定任务的输出语言。否则，遵循 AGENTS.md 等项目指令中适用的语言偏好，再根据用户自己的对话文字确定语言。遇到简短确认、只有代码的输入或附件时，沿用此前用户消息确立的语言。",
  "不要因为引用文档、选中文段、代码、日志、工具结果或应用生成的任务模板使用另一种语言就切换语言。保留代码标识符、命令、文件路径、API 名称和精确引文的原始形式。",
  policy.split("\n").at(-1),
];
export const chinesePolicy = languageLines.join("\n");

const skillDescriptions = {
  impeccable:
    "当用户希望设计、重新设计、塑造、批评、审计、打磨、澄清、提炼、加固、优化、适配、添加动画、配色、提取或以其他方式改善前端界面时使用。覆盖网站、落地页、仪表盘、产品界面、应用框架、组件、表单、设置、入门引导和空状态。处理用户体验审查、视觉层级、信息架构、认知负荷、无障碍、性能、响应式行为、主题、反模式、排版、字体、间距、布局、对齐、颜色、动效、微交互、用户体验文案、错误状态、边界情况、国际化，以及可复用的设计系统或设计变量。也适用于让平淡设计更大胆或更愉悦、让喧闹设计更安静、在浏览器中实时迭代界面元素，或实现应当体现卓越技术的复杂视觉效果。不适用于纯后端或非界面任务。",
  "lark-event":
    "飞书实时事件监听、订阅和消费：通过 `lark-cli event consume <EventKey>` 以 NDJSON 流式输出事件，覆盖即时消息、表情回应、会话变更、视频会议结束、妙记生成等。用于飞书机器人、实时消息处理、长期运行的订阅程序、流式网络回调及推送处理器。支持通过 `--max-events` / `--timeout` 限制运行范围，并约定在标准错误输出就绪标记，面向以子进程运行的 AI 代理设计。",
  "lark-shared":
    "首次配置 lark-cli、执行 auth login、通过 --as 切换用户或机器人身份、处理权限不足或授权范围错误、需要更新 lark-cli，或在 JSON 输出中看到 _notice 时使用。",
};

function xmlEscape(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function translateEntireRequestSystem(system) {
  let translated = translateSdkSystem(system).replace(policy, chinesePolicy);
  translated = translated.replace(
    /(<skill>\s*<name>([^<]+)<\/name>\s*<description>)([\s\S]*?)(<\/description>)/g,
    (_match, before, name, description, after) => {
      let target = skillDescriptions[name] ? xmlEscape(skillDescriptions[name]) : description;
      if (name === "lark-mail") {
        target = target
          .replace(
            "draft, compose, send, reply, forward, read, and search emails; manage drafts, folders, labels, contacts, attachments, and mail rules. Use when user mentions",
            "起草、撰写、发送、回复、转发、阅读和搜索邮件；管理草稿、文件夹、标签、联系人、附件和邮件规则。当用户提到以下内容时使用：",
          )
          .replace(
            "draft, compose, send email, reply, forward, inbox, mail thread, mail rules.",
            "英文中的起草、撰写、发送邮件、回复、转发、收件箱、邮件会话和邮件规则等表达。",
          );
      }
      target = target.replaceAll("Web demo", "网页演示");
      return before + target + after;
    },
  );
  return translated;
}

// The summary templates are read from the pinned SDK, not retyped as English controls.
// Updating a template changes the exact-match check and requires reviewing its translation.
export async function summaryTemplates() {
  const core = new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/",
    import.meta.url,
  );
  const [source, branch, utils] = await Promise.all(
    ["compaction.js", "branch-summarization.js", "utils.js"].map((file) =>
      readFile(new URL(file, core), "utf8"),
    ),
  );
  function constant(text, name) {
    const value = text.match(new RegExp("(?:export )?const " + name + " = `([\\s\\S]*?)`;"))?.[1];
    assert(value, `Missing SDK prompt ${name}`);
    return value;
  }
  const englishSystem = constant(utils, "SUMMARIZATION_SYSTEM_PROMPT");
  const chineseSystem =
    "你是上下文摘要助手。你的任务是阅读用户与 AI 助手之间的对话，然后严格按照指定格式生成结构化摘要。\n\n不要继续对话。不要回答对话中的任何问题。只输出结构化摘要。";
  const replacements = new Map([
    [
      "The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.",
      "以上消息是需要总结的对话。生成结构化的上下文检查点摘要，供另一个大语言模型继续工作。",
    ],
    [
      "Create a structured summary of this conversation branch for context when returning later.",
      "为这个对话分支生成结构化摘要，以便以后返回时获得上下文。",
    ],
    [
      "Update the existing structured summary with new information. RULES:",
      "使用新信息更新现有结构化摘要。规则：",
    ],
    [
      "- PRESERVE all existing information from the previous summary",
      "- 保留此前摘要中的所有现有信息",
    ],
    [
      "- ADD new progress, decisions, and context from the new messages",
      "- 加入新消息中的进展、决策和上下文",
    ],
    [
      '- UPDATE the Progress section: move items from "In Progress" to "Done" when completed',
      "- 更新进展部分：将已完成的条目从“进行中”移至“已完成”",
    ],
    ['- UPDATE "Next Steps" based on what was accomplished', "- 根据已完成的工作更新“后续步骤”"],
    [
      "- PRESERVE exact file paths, function names, and error messages",
      "- 原样保留文件路径、函数名称和错误消息",
    ],
    ["- If something is no longer relevant, you may remove it", "- 可以删除不再相关的内容"],
    [
      "This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.",
      "这是一轮过长而无法完整保留的对话的前半部分。后半部分（最近的工作）已保留。",
    ],
    [
      "Summarize the prefix to provide context for the retained suffix:",
      "总结前半部分，为保留的后半部分提供上下文：",
    ],
    ["Use this EXACT format:", "严格使用以下格式："],
    ["## Original Request", "## 原始请求"],
    ["## Early Progress", "## 前期进展"],
    ["## Context for Suffix", "## 后续部分所需上下文"],
    ["## Goal", "## 目标"],
    ["## Constraints & Preferences", "## 约束与偏好"],
    ["## Progress", "## 进展"],
    ["### Done", "### 已完成"],
    ["### In Progress", "### 进行中"],
    ["### Blocked", "### 受阻事项"],
    ["## Key Decisions", "## 关键决策"],
    ["## Next Steps", "## 后续步骤"],
    ["## Critical Context", "## 关键上下文"],
    [
      "[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]",
      "[用户希望完成什么？会话涉及不同任务时可以列出多项。]",
    ],
    [
      "[What was the user trying to accomplish in this branch?]",
      "[用户在这个分支中希望完成什么？]",
    ],
    [
      "[Any constraints, preferences, or requirements mentioned by user]",
      "[用户提到的约束、偏好或要求]",
    ],
    ["[Any constraints, preferences, or requirements mentioned]", "[提到的约束、偏好或要求]"],
    ['[Or "(none)" if none were mentioned]', "[未提到时写“（无）”]"],
    ["[Completed tasks/changes]", "[已完成的任务或修改]"],
    ["[Current work]", "[当前工作]"],
    ["[Work that was started but not finished]", "[已开始但尚未完成的工作]"],
    ["[Issues preventing progress, if any]", "[阻碍进展的问题，如有]"],
    ["[Decision]", "[决策]"],
    ["[Brief rationale]", "[简要理由]"],
    ["[Ordered list of what should happen next]", "[按顺序列出接下来应开展的工作]"],
    ["[What should happen next to continue this work]", "[继续这项工作所需的下一步]"],
    [
      "[Any data, examples, or references needed to continue]",
      "[继续工作所需的数据、示例或参考资料]",
    ],
    ['[Or "(none)" if not applicable]', "[不适用时写“（无）”]"],
    [
      "[Preserve existing goals, add new ones if the task expanded]",
      "[保留现有目标；任务扩展时增加新目标]",
    ],
    ["[Preserve existing, add new ones discovered]", "[保留现有内容，加入新发现的内容]"],
    ["[Include previously done items AND newly completed items]", "[包含此前已完成和新完成的条目]"],
    ["[Current work - update based on progress]", "[当前工作，根据进展更新]"],
    ["[Current blockers - remove if resolved]", "[当前障碍，解决后移除]"],
    ["(preserve all previous, add new)", "（保留所有已有内容，加入新内容）"],
    ["[Update based on current state]", "[根据当前状态更新]"],
    ["[Preserve important context, add new if needed]", "[保留重要上下文，必要时补充新内容]"],
    ["[What did the user ask for in this turn?]", "[用户在本轮提出了什么请求？]"],
    ["[Key decisions and work done in the prefix]", "[前半部分的关键决策和已完成工作]"],
    [
      "[Information needed to understand the retained recent work]",
      "[理解保留的最近工作所需的信息]",
    ],
    [
      "Keep each section concise. Preserve exact file paths, function names, and error messages.",
      "每个部分保持简洁。原样保留文件路径、函数名称和错误消息。",
    ],
    [
      "Be concise. Focus on what's needed to understand the kept suffix.",
      "保持简洁。重点关注理解保留的后半部分所需的信息。",
    ],
  ]);
  const templates = [
    ["compact", constant(source, "SUMMARIZATION_PROMPT")],
    [
      "update",
      constant(source, "UPDATE_SUMMARIZATION_PROMPT").replace(
        "${UPDATE_SUMMARIZATION_INSTRUCTIONS}",
        constant(source, "UPDATE_SUMMARIZATION_INSTRUCTIONS"),
      ),
    ],
    ["branch", constant(branch, "BRANCH_SUMMARY_PROMPT")],
    ["turn-prefix", constant(source, "TURN_PREFIX_SUMMARIZATION_PROMPT")],
  ];
  return templates.map(([id, english]) => {
    let chinese = english.replace(
      "The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.",
      "以上消息是需要合并进 <previous-summary> 标签内现有摘要的新对话消息。",
    );
    for (const [from, to] of replacements) chinese = chinese.replaceAll(from, to);
    assert(!/[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(chinese), `Untranslated summary prose in ${id}`);
    return { id, english, chinese, englishSystem, chineseSystem };
  });
}
