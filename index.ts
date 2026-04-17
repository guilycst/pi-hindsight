/**
 * Hindsight Self-Hosted Extension for Pi
 *
 * Fully autonomous memory via lifecycle hooks. Adapted for the TKS monorepo
 * Hindsight deployment — reads from the same ~/.hindsight/claude-code.json
 * config used by the Claude Code plugin, with env var overrides.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
  existsSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Debug Logging
// ---------------------------------------------------------------------------

const DEBUG = process.env.HINDSIGHT_DEBUG === "1";
const LOG_DIR = join(homedir(), ".hindsight");
const LOG_PATH = join(LOG_DIR, "debug-pi.log");

function log(msg: string) {
  if (!DEBUG) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, line);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Config — reads the same JSON config as the Claude Code plugin
// ---------------------------------------------------------------------------

interface HindsightConfig {
  api_url: string;
  api_key: string;
  /** Explicit bank ID from config (e.g. "totvs-work"). Overrides project-based derivation. */
  bank_id?: string;
  /** Optional global/cross-project bank */
  global_bank?: string;
  recall_types: string[];
  recall_budget: string;
  recall_max_tokens: number;
  recall_max_query_chars: number;
  retain_every_n_turns: number;
  auto_recall: boolean;
  auto_retain: boolean;
}

const CONFIG_DEFAULTS: Omit<HindsightConfig, "api_url" | "api_key"> = {
  bank_id: undefined,
  global_bank: undefined,
  recall_types: ["world", "experience"],
  recall_budget: "mid",
  recall_max_tokens: 1024,
  recall_max_query_chars: 800,
  retain_every_n_turns: 1,
  auto_recall: true,
  auto_retain: true,
};

/**
 * Load config from ~/.hindsight/claude-code.json (same as Claude Code plugin)
 * with env var overrides.
 */
function loadConfig(): HindsightConfig | null {
  const configPath = join(homedir(), ".hindsight", "claude-code.json");
  if (!existsSync(configPath)) {
    log(`config: ${configPath} not found`);
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const api_url =
      process.env.HINDSIGHT_API_URL || raw.hindsightApiUrl || "";
    const api_key =
      process.env.HINDSIGHT_API_TOKEN || raw.hindsightApiToken || "";

    if (!api_url) {
      log("config: no api_url configured");
      return null;
    }

    return {
      api_url: api_url.replace(/\/$/, ""),
      api_key,
      bank_id: raw.bankId || raw.bank_id,
      global_bank: raw.globalBank || raw.global_bank,
      recall_types: raw.recallTypes || CONFIG_DEFAULTS.recall_types,
      recall_budget: raw.recallBudget || CONFIG_DEFAULTS.recall_budget,
      recall_max_tokens:
        raw.recallMaxTokens || CONFIG_DEFAULTS.recall_max_tokens,
      recall_max_query_chars:
        raw.recallMaxQueryChars || CONFIG_DEFAULTS.recall_max_query_chars,
      retain_every_n_turns:
        raw.retainEveryNTurns || CONFIG_DEFAULTS.retain_every_n_turns,
      auto_recall: raw.autoRecall !== false,
      auto_retain: raw.autoRetain !== false,
    };
  } catch (e) {
    log(`config: failed to parse ${configPath}: ${e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bank derivation
// ---------------------------------------------------------------------------

function getProjectBank(): string {
  return `project-${basename(process.cwd())}`;
}

/** The primary bank for recall and retain — config bank_id or project-derived */
function getPrimaryBank(config: HindsightConfig): string {
  return config.bank_id || getProjectBank();
}

/** All banks to query during recall */
function getRecallBanks(config: HindsightConfig): string[] {
  const banks = new Set<string>();
  banks.add(getPrimaryBank(config));
  if (config.global_bank) banks.add(config.global_bank);
  return Array.from(banks);
}

/** Banks to retain to (project bank always; global bank only with #global/#me) */
function getRetainBanks(
  config: HindsightConfig,
  prompt: string
): string[] {
  const banks = new Set<string>();
  banks.add(getPrimaryBank(config));
  if (
    config.global_bank &&
    (prompt.includes("#global") || prompt.includes("#me"))
  ) {
    banks.add(config.global_bank);
  }
  return Array.from(banks);
}

// ---------------------------------------------------------------------------
// API client helpers
// ---------------------------------------------------------------------------

function apiHeaders(config: HindsightConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.api_key}`,
    "User-Agent": "pi-hindsight/1.0.0",
  };
}

async function apiGet<T = any>(
  config: HindsightConfig,
  path: string
): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  try {
    const res = await fetch(`${config.api_url}${path}`, {
      headers: apiHeaders(config),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (_) {
    return { ok: false, status: 0 };
  }
}

async function apiPost<T = any>(
  config: HindsightConfig,
  path: string,
  body: unknown
): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  try {
    const res = await fetch(`${config.api_url}${path}`, {
      method: "POST",
      headers: apiHeaders(config),
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (_) {
    return { ok: false, status: 0 };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLastUserMessage(ctx: any, fallback: string): string {
  try {
    const entries = ctx.sessionManager?.getEntries() || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "message" && e.message?.role === "user") {
        const content = e.message.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          const textBlock = content.find(
            (b: any) => b.type === "text"
          );
          if (textBlock) return textBlock.text;
        }
        return JSON.stringify(content);
      }
    }
  } catch (_) {}
  return fallback;
}

function truncateQuery(query: string, maxChars: number): string {
  if (query.length <= maxChars) return query;
  return query.slice(0, maxChars);
}

interface HookRecord {
  firedAt?: string;
  result?: "ok" | "failed" | "skipped" | "none";
  detail?: string;
}

const hookStats: {
  sessionStart: HookRecord;
  recall: HookRecord;
  retain: HookRecord;
} = {
  sessionStart: {},
  recall: {},
  retain: {},
};

const OPERATIONAL_TOOLS = new Set([
  "bash",
  "nu",
  "process",
  "read",
  "write",
  "edit",
  "grep",
  "ast_grep_search",
  "ast_grep_replace",
  "lsp_navigation",
]);

function readRecentLogLines(maxLines = 20): string[] {
  try {
    if (!existsSync(LOG_PATH)) return [];
    return readFileSync(LOG_PATH, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .slice(-maxLines);
  } catch (_) {
    return [];
  }
}

const MAX_RECALL_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function hindsightExtension(pi: ExtensionAPI) {
  let recallDone = false;
  let recallAttempts = 0;
  let currentPrompt = "";
  let turnCounter = 0;

  // Track user input for fallback
  pi.on("input", async (event: any) => {
    if (event.text) currentPrompt = event.text;
  });

  // ── Session lifecycle ──────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    recallDone = false;
    recallAttempts = 0;
    turnCounter = 0;
    hookStats.sessionStart = {
      firedAt: new Date().toISOString(),
      result: "ok",
    };
    hookStats.recall = {};
    hookStats.retain = {};
    ctx.ui.setStatus("hindsight", undefined);
    log("session_start: state reset");
  });

  pi.on("session_compact", async (_event, ctx) => {
    recallDone = false;
    recallAttempts = 0;
    ctx.ui.setStatus("hindsight", undefined);
    log("session_compact: state reset");
  });

  // ── Message renderers ──────────────────────────────────────────────────
  pi.registerMessageRenderer(
    "hindsight-recall",
    (message, _options, theme) => {
      const count: number = (message.details as any)?.count ?? 0;
      const snippet: string = (message.details as any)?.snippet ?? "";
      let text = theme.fg("accent", "🧠 Hindsight");
      text += theme.fg(
        "muted",
        ` recalled ${count} ${count === 1 ? "memory" : "memories"}`
      );
      if (snippet) {
        text += "\n" + theme.fg("dim", snippet);
      }
      return new Text(text, 0, 0);
    }
  );

  pi.registerMessageRenderer(
    "hindsight-retain",
    (message, _options, theme) => {
      const banks: string[] = (message.details as any)?.banks ?? [];
      let text = theme.fg("accent", "💾 Hindsight");
      text += theme.fg("muted", " saved turn to memory");
      if (banks.length > 0) {
        text += theme.fg("dim", ` → ${banks.join(", ")}`);
      }
      return new Text(text, 0, 0);
    }
  );

  pi.registerMessageRenderer(
    "hindsight-retain-failed",
    (_message, _options, theme) => {
      let text = theme.fg("error", "💾 Hindsight");
      text += theme.fg("muted", " retain failed — use ");
      text += theme.fg("accent", "hindsight_retain");
      text += theme.fg("muted", " to save manually");
      return new Text(text, 0, 0);
    }
  );

  // ── Auto-Recall (before_agent_start) ───────────────────────────────────
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!loadConfig()?.auto_recall) {
      log("before_agent_start: auto-recall disabled");
      return;
    }

    if (recallDone) {
      log("before_agent_start: skip (recallDone=true)");
      return;
    }
    if (recallAttempts >= MAX_RECALL_ATTEMPTS) {
      log(
        `before_agent_start: skip (max attempts ${MAX_RECALL_ATTEMPTS} reached)`
      );
      return;
    }

    recallAttempts++;
    log(
      `before_agent_start: attempt ${recallAttempts}/${MAX_RECALL_ATTEMPTS}`
    );

    const config = loadConfig();
    if (!config) {
      log("before_agent_start: no config, giving up");
      recallAttempts = MAX_RECALL_ATTEMPTS;
      ctx.ui.setStatus("hindsight", "⚠ not configured");
      return;
    }

    const userPrompt = getLastUserMessage(ctx, currentPrompt) || "";
    const query = truncateQuery(userPrompt, config.recall_max_query_chars);
    if (query.length < 5) {
      log("before_agent_start: query too short, skipping");
      return;
    }

    const banks = getRecallBanks(config);
    log(
      `before_agent_start: querying banks=${banks.join(",")} query="${query.slice(0, 80)}"`
    );

    try {
      let authFailed = false;
      let anySucceeded = false;

      const recallPromises = banks.map(async (bank) => {
        const bankPath = encodeURIComponent(bank);
        const result = await apiPost(config, `/v1/default/banks/${bankPath}/memories/recall`, {
          query,
          budget: config.recall_budget,
          max_tokens: config.recall_max_tokens,
          query_timestamp: new Date().toISOString(),
          types: config.recall_types,
        });

        if (!result.ok) {
          log(`before_agent_start: bank=${bank} HTTP ${result.status}`);
          if (result.status === 401 || result.status === 403)
            authFailed = true;
          return [];
        }

        anySucceeded = true;
        const results = (result.data as any).results || [];
        log(`before_agent_start: bank=${bank} got ${results.length} results`);
        return results.map((r: any) => `[Bank: ${bank}] - ${r.text}`);
      });

      const allResults = (await Promise.all(recallPromises)).flat();

      if (authFailed) {
        hookStats.recall = {
          firedAt: new Date().toISOString(),
          result: "failed",
          detail: "auth error",
        };
        recallAttempts = MAX_RECALL_ATTEMPTS;
        ctx.ui.setStatus("hindsight", "✗ auth error — check api_key");
        log("before_agent_start: auth error, giving up");
        return;
      }

      if (anySucceeded) {
        recallDone = true;
        ctx.ui.setStatus("hindsight", undefined);

        if (allResults.length > 0) {
          hookStats.recall = {
            firedAt: new Date().toISOString(),
            result: "ok",
            detail: `${allResults.length} memories`,
          };
          log(
            `before_agent_start: injecting ${allResults.length} memories into context`
          );
          const memoriesStr = allResults.join("\n\n");
          const content = `<hindsight_memories>\nRelevant memories from past conversations:\n\n${memoriesStr}\n</hindsight_memories>`;
          const snippet = allResults
            .slice(0, 3)
            .map((r: string) => r.replace(/^\[Bank: [^\]]+\] - /, ""))
            .join(" · ")
            .slice(0, 200);

          return {
            message: {
              customType: "hindsight-recall",
              content,
              display: true,
              details: { count: allResults.length, snippet },
            },
          };
        } else {
          hookStats.recall = {
            firedAt: new Date().toISOString(),
            result: "ok",
            detail: "empty vault",
          };
          log("before_agent_start: no memories found (empty vault)");
        }
      } else {
        const isLast = recallAttempts >= MAX_RECALL_ATTEMPTS;
        hookStats.recall = {
          firedAt: new Date().toISOString(),
          result: "failed",
          detail: isLast ? "unreachable" : "retrying",
        };
        ctx.ui.setStatus(
          "hindsight",
          isLast
            ? "✗ recall unavailable"
            : "⚠ recall failed (retrying)"
        );
      }
    } catch (e) {
      const isLast = recallAttempts >= MAX_RECALL_ATTEMPTS;
      ctx.ui.setStatus(
        "hindsight",
        isLast
          ? "✗ recall unavailable"
          : "⚠ recall failed (retrying)"
      );
      log(`before_agent_start: error ${e}`);
    }
  });

  // ── Auto-Retain (agent_end) ────────────────────────────────────────────
  pi.on("agent_end", async (event: any, ctx) => {
    log("agent_end: fired");

    const config = loadConfig();
    if (!config || !config.auto_retain) {
      log("agent_end: auto-retain disabled or no config");
      return;
    }

    turnCounter++;
    if (turnCounter % config.retain_every_n_turns !== 0) {
      log(
        `agent_end: turn ${turnCounter}, skipping (retain every ${config.retain_every_n_turns})`
      );
      return;
    }

    const userPrompt = getLastUserMessage(ctx, currentPrompt);
    if (!userPrompt || userPrompt.length < 5) {
      log("agent_end: no user prompt found, skipping");
      return;
    }

    // Skip trivial interactions
    if (
      /^(ok|yes|no|thanks|continue|next|done|sure|stop)$/i.test(
        userPrompt.trim()
      )
    ) {
      log("agent_end: trivial prompt, skipping");
      return;
    }

    // Opt-out
    if (
      userPrompt.trim().startsWith("#nomem") ||
      userPrompt.trim().startsWith("#skip")
    ) {
      log("agent_end: opt-out tag, skipping");
      return;
    }

    // Build transcript
    let transcript = `[role: user]\n${userPrompt}\n\n[role: assistant]\n`;

    const messages = event.messages || [];
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const content = msg.content;
      if (typeof content === "string") {
        transcript += `${content}\n`;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") {
            transcript += `${block.text}\n`;
          } else if (block.type === "tool_use") {
            if (!OPERATIONAL_TOOLS.has(block.name)) {
              transcript += `[Tool: ${block.name}] ${JSON.stringify(block.input || {})}\n`;
            }
          }
        }
      }
    }

    // Strip feedback loop
    transcript = transcript.replace(
      /<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g,
      ""
    );

    // Extract user #tags (excluding reserved)
    const reservedTags = new Set(["nomem", "skip", "global", "me"]);
    const extractedTags = Array.from(
      userPrompt.matchAll(/(?<=^|\s)#([a-zA-Z0-9_-]+)/g)
    )
      .map((m) => m[1].toLowerCase())
      .filter((t) => !reservedTags.has(t));

    transcript = transcript.trim();
    if (transcript.length < 20) return;
    if (transcript.length > 50_000) {
      transcript = transcript.slice(0, 50_000) + "\n...[TRUNCATED]";
    }

    const sessionId =
      ctx.sessionManager?.getSessionId?.() || `pi-${Date.now()}`;
    const banks = getRetainBanks(config, userPrompt);

    log(
      `agent_end: retaining to banks=${banks.join(",")} len=${transcript.length} tags=${extractedTags.join(",")}`
    );

    try {
      const results = await Promise.allSettled(
        banks.map(async (bank) => {
          const result = await apiPost(config, `/v1/default/banks/${encodeURIComponent(bank)}/memories`, {
            items: [
              {
                content: transcript,
                document_id: `pi-session-${sessionId}`,
                update_mode: "append",
                context: `pi coding session: ${userPrompt.slice(0, 100)}`,
                timestamp: new Date().toISOString(),
                ...(extractedTags.length > 0 && { tags: extractedTags }),
              },
            ],
            async: true,
          });
          if (!result.ok) throw new Error(`HTTP ${result.status}`);
          return bank;
        })
      );

      const succeededBanks = results
        .filter((r) => r.status === "fulfilled")
        .map((r) => (r as PromiseFulfilledResult<string>).value);

      const allFailed = succeededBanks.length === 0;

      hookStats.retain = {
        firedAt: new Date().toISOString(),
        result: allFailed ? "failed" : "ok",
        detail: allFailed
          ? "all banks unreachable"
          : succeededBanks.join(", "),
      };

      if (allFailed) {
        log("agent_end: all banks failed");
        ctx.ui.setStatus("hindsight", "⚠ retain failed");
        pi.sendMessage(
          {
            customType: "hindsight-retain-failed",
            content: "",
            display: true,
          },
          { deliverAs: "nextTurn" }
        );
      } else {
        ctx.ui.setStatus("hindsight", undefined);
        pi.sendMessage(
          {
            customType: "hindsight-retain",
            content: "",
            display: true,
            details: { banks: succeededBanks },
          },
          { deliverAs: "nextTurn" }
        );
      }
    } catch (e) {
      log(`agent_end: error ${e}`);
    }
  });

  // ── Manual Tools ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "hindsight_recall",
    label: "Hindsight Recall",
    description:
      "Recall relevant context, conventions, or past solutions from team memory. Use when the user explicitly asks to search memory.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_id, params) {
      const config = loadConfig();
      if (!config)
        return {
          content: [
            {
              type: "text" as const,
              text: "Hindsight not configured. Create ~/.hindsight/claude-code.json",
            },
          ],
          details: {},
          isError: true,
        };

      const banks = getRecallBanks(config);
      try {
        const allResults: string[] = [];

        for (const bank of banks) {
          const result = await apiPost(config, `/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`, {
            query: params.query,
            budget: config.recall_budget,
            max_tokens: config.recall_max_tokens,
            query_timestamp: new Date().toISOString(),
            types: config.recall_types,
          });

          if (result.ok) {
            const results = (result.data as any).results || [];
            for (const r of results) {
              allResults.push(`[${bank}] ${r.text}`);
            }
          }
        }

        if (allResults.length > 0) {
          return {
            content: [
              { type: "text" as const, text: allResults.join("\n\n") },
            ],
            details: { count: allResults.length },
          };
        }
        return {
          content: [{ type: "text" as const, text: "No memories found." }],
          details: {},
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "hindsight_retain",
    label: "Hindsight Retain",
    description:
      "Force-save an explicit insight to memory. Only use when explicitly requested.",
    parameters: Type.Object({
      content: Type.String({ description: "The rich context to save" }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional tags for categorization",
        })
      ),
    }),
    async execute(_id, params) {
      const config = loadConfig();
      if (!config)
        return {
          content: [
            {
              type: "text" as const,
              text: "Hindsight not configured. Create ~/.hindsight/claude-code.json",
            },
          ],
          details: {},
          isError: true,
        };

      const bank = getPrimaryBank(config);
      try {
        const result = await apiPost(config, `/v1/default/banks/${encodeURIComponent(bank)}/memories`, {
          items: [
            {
              content: params.content,
              context: "pi: explicit user save",
              timestamp: new Date().toISOString(),
              ...(params.tags && params.tags.length > 0
                ? { tags: params.tags }
                : {}),
            },
          ],
          async: true,
        });

        if (result.ok) {
          log(`hindsight_retain: saved to bank=${bank}`);
          return {
            content: [
              {
                type: "text" as const,
                text: `Memory retained to bank "${bank}".`,
              },
            ],
            details: { bank },
          };
        }
        return {
          content: [
            { type: "text" as const, text: `Failed to retain (HTTP ${result.status}).` },
          ],
          details: {},
          isError: true,
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "hindsight_reflect",
    label: "Hindsight Reflect",
    description:
      "Synthesize context from memory to answer a question. Use when the user wants a summary or analysis of stored knowledge.",
    parameters: Type.Object({
      query: Type.String({ description: "Question to reflect on" }),
    }),
    async execute(_id, params) {
      const config = loadConfig();
      if (!config)
        return {
          content: [
            {
              type: "text" as const,
              text: "Hindsight not configured. Create ~/.hindsight/claude-code.json",
            },
          ],
          details: {},
          isError: true,
        };

      const bank = getPrimaryBank(config);
      try {
        const result = await apiPost(config, `/v1/default/banks/${encodeURIComponent(bank)}/memories/reflect`, {
          query: params.query,
        });

        if (result.ok) {
          const data = result.data as any;
          return {
            content: [
              {
                type: "text" as const,
                text: data.synthesis || data.answer || JSON.stringify(data),
              },
            ],
            details: {},
          };
        }
        return {
          content: [
            { type: "text" as const, text: `Failed to reflect (HTTP ${result.status}).` },
          ],
          details: {},
          isError: true,
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ── Commands ───────────────────────────────────────────────────────────
  pi.registerCommand("hindsight", {
    description: "Hindsight memory status. Usage: /hindsight [status | stats]",
    handler: async (args, ctx) => {
      const config = loadConfig();
      if (!config) {
        ctx.ui.notify(
          "Hindsight not configured. Create ~/.hindsight/claude-code.json with hindsightApiUrl and hindsightApiToken.",
          "error"
        );
        return;
      }

      const sub = (typeof args === "string" ? args : "").trim();

      if (sub === "stats") {
        const banks = getRecallBanks(config);
        const lines: string[] = [];

        for (const bank of banks) {
          const result = await apiGet(config, `/v1/default/banks/${encodeURIComponent(bank)}/stats`);
          if (result.ok) {
            const stats = result.data as Record<string, number>;
            const entries = Object.entries(stats)
              .map(([k, v]) => `  ${k}: ${v}`)
              .join("\n");
            lines.push(`${bank}:\n${entries}`);
          } else {
            lines.push(`${bank}: unavailable (HTTP ${result.status})`);
          }
        }

        ctx.ui.notify(lines.join("\n\n"), "info");
        return;
      }

      // Default + status: full health check
      const lines: string[] = [];
      let hasError = false;

      // Config
      lines.push(`URL:    ${config.api_url}`);
      if (!config.api_key) {
        lines.push("  ⚠ api_key not set");
      }

      // Primary bank
      const primaryBank = getPrimaryBank(config);
      lines.push(`Bank:   ${primaryBank}${config.bank_id ? " (configured)" : " (auto-derived)"}`);

      // Health
      const health = await apiGet(config, "/health");
      if (!health.ok) {
        lines.push(`Server: ✗ unreachable${health.status ? ` (HTTP ${health.status})` : ""}`);
        hasError = true;
      } else {
        lines.push("Server: ✓ online");
      }

      // Auth check via bank profile
      const profile = await apiGet(config, `/v1/default/banks/${encodeURIComponent(primaryBank)}/profile`);
      if (!profile.ok) {
        if (profile.status === 401 || profile.status === 403) {
          lines.push("  ✗ auth invalid — check api_key");
          hasError = true;
        } else if (profile.status === 404) {
          lines.push("  ⚠ bank not found yet (will be created on first retain)");
        } else {
          lines.push(`  ⚠ could not verify (HTTP ${profile.status})`);
        }
      } else {
        lines.push("  ✓ auth ok");
      }

      if (config.global_bank) {
        lines.push(`Global: ${config.global_bank}`);
      }

      // Recall config
      lines.push("");
      lines.push(`Recall: types=${config.recall_types.join(",")} budget=${config.recall_budget} maxTokens=${config.recall_max_tokens}`);
      lines.push(`Retain: every ${config.retain_every_n_turns} turn(s)`);

      // Hook state
      lines.push("");
      lines.push("Hooks this session:");
      const hookIcon = (r?: string) =>
        r === "ok" ? "✓" : r === "failed" ? "✗" : r === "skipped" ? "−" : "…";
      const fmtHook = (h: HookRecord) =>
        h.firedAt
          ? `${hookIcon(h.result)} ${h.result}${h.detail ? ` (${h.detail})` : ""}`
          : "not fired";
      lines.push(`  session_start: ${fmtHook(hookStats.sessionStart)}`);
      lines.push(`  recall:        ${fmtHook(hookStats.recall)}`);
      lines.push(`  retain:        ${fmtHook(hookStats.retain)}`);

      // Debug
      lines.push("");
      if (DEBUG) {
        const logLines = readRecentLogLines(10);
        lines.push(`Debug log (last ${logLines.length} lines):`);
        logLines.forEach((l) => lines.push(`  ${l}`));
      } else {
        lines.push("Debug: disabled (set HINDSIGHT_DEBUG=1)");
      }

      ctx.ui.notify(lines.join("\n"), hasError ? "error" : "info");
    },
  });
}
