import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { chatCandidates, chatCompletion, gitStatus } from "./git-service";

const execFileAsync = promisify(execFile);

/**
 * Prompt enhancement for the composer: on demand, gathers a bounded snapshot
 * of the project (branch, uncommitted changes, repo guide files) and asks a
 * lightweight model to restructure the user's request into a well-formed
 * prompt. Returns null (renderer then sends the original text) whenever no
 * direct chat endpoint is available — sending must never be blocked.
 */

export interface EnhancePromptResult {
  /** Restructured prompt, ready to send. */
  prompt: string;
  /** Short human-readable summary of the project context that was used. */
  contextUsed: string;
}

const CTX_FILE_CAP = 1500; // chars of README/AGENTS.md per file
const CTX_TOTAL_CAP = 3000; // chars of the whole context block
const FILE_LIST_CAP = 20;

const GUIDE_FILES = ["README.md", "README", "readme.md", "AGENTS.md", "CLAUDE.md"];

async function gitHeadSubject(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "log", "-1", "--format=%s"], {
      timeout: 3000,
      windowsHide: true,
    });
    return stdout.trim().slice(0, 120) || null;
  } catch {
    return null;
  }
}

function headOf(file: string, cap = CTX_FILE_CAP): string | null {
  try {
    const text = readFileSync(file, "utf8");
    return text.slice(0, cap).trim() || null;
  } catch {
    return null;
  }
}

/** Bounded project snapshot fed to the rewriting model. */
async function gatherProjectContext(cwd: string): Promise<{ block: string; summary: string }> {
  const parts: string[] = [];
  const flags: string[] = [];

  const status = await gitStatus(cwd);
  if (status.repo) {
    if (status.branch) {
      parts.push(`当前分支: ${status.branch}`);
      flags.push(`分支 ${status.branch}`);
    }
    const head = await gitHeadSubject(cwd);
    if (head) parts.push(`最近提交: ${head}`);

    const changed: string[] = [];
    for (const f of [...status.staged, ...status.unstaged].slice(0, FILE_LIST_CAP)) {
      changed.push(`${f.path} (${f.status})`);
    }
    for (const f of status.untracked.slice(0, FILE_LIST_CAP)) {
      changed.push(`${f} (untracked)`);
    }
    if (changed.length) {
      parts.push("未提交改动:\n" + changed.map((c) => `- ${c}`).join("\n"));
      flags.push(`${changed.length} 个改动文件`);
    }
  }

  // Guide files tell the model what the repo expects of agents; only the
  // first existing one is included to bound tokens.
  for (const name of GUIDE_FILES) {
    const full = join(status.root || cwd, name);
    if (existsSync(full)) {
      const text = headOf(full);
      if (text) {
        parts.push(`${name} 摘录:\n${text}`);
        flags.push(name);
        break;
      }
    }
  }

  let block = parts.join("\n\n");
  if (block.length > CTX_TOTAL_CAP) block = block.slice(0, CTX_TOTAL_CAP) + "\n…(已截断)";
  return { block: block || "(无项目上下文)", summary: flags.join(" · ") || status.root || cwd };
}

const ENHANCE_SYSTEM =
  "你是提示词优化助手。用户会把「发给 AI 编程助手的请求」和「项目上下文」一起发给你。" +
  "请把请求重写为结构清晰、表达准确、可直接执行的提示词。规则：\n" +
  "1) 保留用户全部意图，不得添加用户未提及的需求或臆造事实；\n" +
  "2) 结合项目上下文（分支、未提交改动、仓库说明文件）补充必要的背景信息，让 AI 能针对项目现状行动；\n" +
  "3) 用 Markdown 结构化表达，按内容需要选用「背景 / 目标 / 约束 / 期望结果 / 验证方式」等小节，短请求保持简洁，不要为了分节而分节；\n" +
  "4) 输出语言与用户请求一致；\n" +
  "5) 只输出重写后的提示词本身，不要解释、不要前后缀、不要用代码块包裹。";

export async function enhancePrompt(cwd: string, text: string): Promise<EnhancePromptResult | null> {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  const started = Date.now();
  const { block, summary } = await gatherProjectContext(cwd);
  const userPrompt = `项目上下文:\n${block}\n\n用户请求:\n${trimmed}`;

  const candidates = await chatCandidates();
  if (!candidates.length) {
    console.log("[prompt] no direct chat endpoints available; enhancement skipped");
    return null;
  }
  for (const endpoint of candidates) {
    try {
      const out = await chatCompletion(endpoint, userPrompt, {
        system: ENHANCE_SYSTEM,
        maxTokens: 700,
        temperature: 0.3,
      });
      if (!out) continue;
      const prompt = out.replace(/^```(?:markdown|md)?\s*|```$/g, "").trim();
      console.log(
        `[prompt] enhance via=${endpoint.provider}/${endpoint.model} ms=${Date.now() - started} in=${trimmed.length}b out=${prompt.length}b`,
      );
      return { prompt, contextUsed: summary };
    } catch (e: any) {
      console.log(`[prompt] enhance ${endpoint.provider}/${endpoint.model} failed: ${e?.message || e}`);
    }
  }
  return null;
}
