// Manual, opt-in provider experiment. Never run from the automated test suite.
// Run: node packages/agent-runtime/test/content-language-probe.mjs /tmp/results.json
// Add --full for all active SDK prose/tools plus a fully Chinese context group and summaries.
// Uses the existing DeepSeek credential, but never executes tools or saves raw thinking.
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createPixRuntime } from "../src/index.ts";
import { CONTENT_LANGUAGE_INSTRUCTIONS as policy } from "../src/content-language.ts";
import { translateDefault } from "./content-language-probe-translations.mjs";
import {
  chinesePolicy,
  translateSdkSystem,
  translateEntireRequestSystem,
  translateTools,
  summaryTemplates,
} from "./content-language-full-translations.mjs";

const output = process.argv[2];
if (!output) throw new Error("Provide a JSON result path; this script makes live API requests.");
const full = process.argv.includes("--full");
const dryRun = process.argv.includes("--dry-run");
const repetitions = full ? 4 : 2;

function atStart(system) {
  return (
    policy +
    "\n\n" +
    system
      .replace(policy, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function languageCounts(text) {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  // A reproducible, coarse script measure, not a semantic language classifier.
  return {
    chars: text.length,
    han,
    latin,
    hanShare: han + latin ? han / (han + latin) : null,
    script: han + latin === 0 ? "empty" : han >= latin ? "han-dominant" : "latin-dominant",
  };
}

const root = await mkdtemp(join(tmpdir(), "pix-language-factorial-"));
let handle;
const results = [];
const summaryResults = [];
try {
  const auth = JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8"));
  if (!auth.deepseek) throw new Error("No configured DeepSeek credential.");
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ deepseek: auth.deepseek }), {
    mode: 0o600,
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ compaction: { enabled: false } }),
  );
  handle = await createPixRuntime({
    cwd,
    agentDir,
    model: { provider: "deepseek", id: "deepseek-v4-flash" },
    tools: ["read", "bash", "edit", "write"],
    projectTrusted: true,
  });
  const session = handle.runtime.session;
  const baseline = session.systemPrompt;
  const chinese = translateDefault(baseline);
  const translatedTools = full ? translateTools(session.agent.state.tools) : undefined;
  const summaries = full ? await summaryTemplates() : [];
  const variants = full
    ? [
        { id: "en-original", system: baseline },
        { id: "zh-original", system: chinese },
        { id: "zh-sdk-all", system: translateSdkSystem(baseline), tools: translatedTools.tools },
        {
          id: "zh-context-all",
          system: translateEntireRequestSystem(baseline),
          tools: translatedTools.tools,
        },
      ]
    : [
        { id: "en-original", system: baseline },
        { id: "zh-original", system: chinese },
        { id: "en-start", system: atStart(baseline) },
        { id: "zh-start", system: atStart(chinese) },
      ];
  const prompts = [
    { id: "internet-zh", text: "你可以互联网搜索吗", language: "zh" },
    {
      id: "mixed-zh",
      text: '请说明你能否联网搜索。以下只是一段英文文档引用："A web search tool retrieves current information from the internet."',
      language: "zh",
    },
    { id: "project-zh", text: "这个项目的默认地址是什么", language: "zh" },
    { id: "internet-en", text: "Can you search the internet?", language: "en" },
  ];
  const metadata = {
    startedAt: new Date().toISOString(),
    model: session.model.id,
    provider: session.model.provider,
    reasoning: "high",
    maxTokens: 2048,
    repetitions,
    mode: full ? "full-translation" : "position-factorial",
    dryRun,
    translationCoverage: full
      ? {
          toolDescriptions: translatedTools.descriptionCount,
          summaryTemplates: summaries.map((s) => s.id),
        }
      : undefined,
    scope:
      "Fresh single-turn requests, empty project, no conversation history. Proposed tools are never executed. No raw thinking is saved. Full mode translates SDK tool descriptions and skill guidance; context-all also translates application language rules and English skill prose. Skill names/paths and tool schema structure stay unchanged.",
    sharedContext: {
      skills: session.resourceLoader.getSkills().skills.map((skill) => skill.name),
      visibleSkills: [...baseline.matchAll(/<name>([^<]+)<\/name>/g)].map((match) => match[1]),
      projectInstructionPaths: session.resourceLoader
        .getAgentsFiles()
        .agentsFiles.map((file) => file.path),
    },
    classification:
      "han-dominant means Han character count >= Latin letter count; identifiers and commands can affect this coarse measure.",
    prompts,
    variants: variants.map((v) => ({
      id: v.id,
      systemSha256: createHash("sha256").update(v.system.replaceAll(cwd, "<cwd>")).digest("hex"),
      languageRuleOffset: v.system.indexOf(v.id === "zh-context-all" ? chinesePolicy : policy),
      toolsSha256: createHash("sha256")
        .update(
          JSON.stringify(
            (v.tools ?? session.agent.state.tools).map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          ),
        )
        .digest("hex"),
      ...languageCounts(v.system),
    })),
  };
  async function save() {
    await writeFile(
      output,
      JSON.stringify({ ...metadata, results, summaryResults }, null, 2) + "\n",
      {
        mode: 0o600,
      },
    );
  }
  if (dryRun && full) {
    const system = variants.find((variant) => variant.id === "zh-context-all").system;
    // Ignore structural identifiers and exact command/path quotations in this audit.
    const prose = system.replace(
      /<location>[\s\S]*?<\/location>|<name>[\s\S]*?<\/name>|`[^`]*`/g,
      "",
    );
    metadata.remainingEnglishPhrases = [
      ...new Set(prose.match(/\b[A-Za-z]{3,}(?: [A-Za-z]{3,}){1,}\b/g) ?? []),
    ];
  }
  await save();
  // Rotate order to avoid always measuring one condition first. Requests are
  // sequential so provider throttling or shared runtime state cannot race.
  for (let rep = 0; rep < (dryRun ? 0 : repetitions); rep++) {
    for (let p = 0; p < prompts.length; p++) {
      for (let offset = 0; offset < variants.length; offset++) {
        const variant = variants[(offset + rep + p) % variants.length];
        const prompt = prompts[p];
        const started = Date.now();
        const response = await handle.runtime.services.modelRuntime
          .streamSimple(
            session.model,
            {
              systemPrompt: variant.system,
              messages: [{ role: "user", content: prompt.text, timestamp: Date.now() }],
              tools: variant.tools ?? session.agent.state.tools,
            },
            { reasoning: "high", maxTokens: 2048, signal: AbortSignal.timeout(45000) },
          )
          .result();
        const thinking = response.content
          .filter((b) => b.type === "thinking")
          .map((b) => b.thinking)
          .join("");
        const answer = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        const result = {
          variant: variant.id,
          prompt: prompt.id,
          repetition: rep + 1,
          stopReason: response.stopReason,
          durationMs: Date.now() - started,
          thinking: languageCounts(thinking),
          answer: languageCounts(answer),
          tools: response.content.filter((b) => b.type === "toolCall").map((b) => b.name),
          usage: response.usage,
        };
        results.push(result);
        await save();
        console.log(JSON.stringify(result));
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          throw new Error(
            "Provider request failed; stopping the experiment. Credentials and raw error body are not printed.",
          );
        }
      }
    }
  }
  // Exercise each standalone SDK summary template on the same synthetic Chinese
  // conversation. Nothing from the user's session is submitted or persisted here.
  for (let rep = 0; rep < (dryRun ? 0 : 2); rep++) {
    for (const template of summaries) {
      for (const language of rep === 0 ? ["en", "zh"] : ["zh", "en"]) {
        const chinese = language === "zh";
        const transcript = chinese
          ? "[用户]: 请用中文帮我查项目的默认开发地址，保留代码和路径原样。\n\n[助手]: 已读取 README.md，开发地址是 http://127.0.0.1:1420；下一步核对 vite.config.ts。\n\n[用户]: 好，继续核对配置。"
          : "[User]: 请用中文帮我查项目的默认开发地址，保留代码和路径原样。\n\n[Assistant]: 已读取 README.md，开发地址是 http://127.0.0.1:1420；下一步核对 vite.config.ts。\n\n[User]: 好，继续核对配置。";
        const previous =
          template.id === "update"
            ? "\n\n<previous-summary>\n## 目标\n核实项目默认开发地址。\n## 进展\n### 已完成\n- [x] 已读取 README.md。\n### 进行中\n- [ ] 核对 vite.config.ts。\n</previous-summary>"
            : "";
        const systemPrompt = `${chinese ? template.chineseSystem : template.englishSystem}\n\n${chinese ? chinesePolicy : policy}`;
        const response = await handle.runtime.services.modelRuntime
          .streamSimple(
            session.model,
            {
              systemPrompt,
              messages: [
                {
                  role: "user",
                  timestamp: Date.now(),
                  content: `<conversation>\n${transcript}\n</conversation>${previous}\n\n${chinese ? template.chinese : template.english}`,
                },
              ],
            },
            { reasoning: "high", maxTokens: 2048, signal: AbortSignal.timeout(45000) },
          )
          .result();
        const thinking = response.content
          .filter((b) => b.type === "thinking")
          .map((b) => b.thinking)
          .join("");
        const answer = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        summaryResults.push({
          template: template.id,
          language,
          repetition: rep + 1,
          stopReason: response.stopReason,
          thinking: languageCounts(thinking),
          answer: languageCounts(answer),
          headings: answer.split("\n").filter((line) => /^#{1,3} /.test(line)),
          preservesPaths: answer.includes("README.md") && answer.includes("vite.config.ts"),
          preservesAddress: answer.includes("http://127.0.0.1:1420"),
          usage: response.usage,
        });
        await save();
        console.log(JSON.stringify(summaryResults.at(-1)));
        if (["error", "aborted"].includes(response.stopReason))
          throw new Error("Summary request failed; raw provider error is not printed.");
      }
    }
  }
} finally {
  try {
    await handle?.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
