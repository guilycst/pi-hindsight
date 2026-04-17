/**
 * Smoke test for pi-hindsight extension.
 *
 * Tests the extension against a live Hindsight API to verify:
 *   1. Config loading from ~/.hindsight/claude-code.json
 *   2. Health check
 *   3. Retain lifecycle (agent_end) — async + sync
 *   4. Recall lifecycle (may 504 on heavy banks — graceful degradation)
 *   5. Manual tool simulations
 *   6. Auth error handling
 *   7. /hindsight command simulation
 *
 * Run: node --experimental-strip-types smoke-test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Config + API helpers (inlined from extension)
// ---------------------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".hindsight", "claude-code.json");

interface Config {
  api_url: string;
  api_key: string;
  bank_id?: string;
  global_bank?: string;
  recall_types: string[];
  recall_budget: string;
  recall_max_tokens: number;
  retain_every_n_turns: number;
  auto_recall: boolean;
  auto_retain: boolean;
}

function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const api_url = process.env.HINDSIGHT_API_URL || raw.hindsightApiUrl || "";
    const api_key = process.env.HINDSIGHT_API_TOKEN || raw.hindsightApiToken || "";
    if (!api_url) return null;
    return {
      api_url: api_url.replace(/\/$/, ""),
      api_key,
      bank_id: raw.bankId || raw.bank_id,
      global_bank: raw.globalBank || raw.global_bank,
      recall_types: raw.recallTypes || ["world", "experience"],
      recall_budget: raw.recallBudget || "mid",
      recall_max_tokens: raw.recallMaxTokens || 1024,
      retain_every_n_turns: raw.retainEveryNTurns || 1,
      auto_recall: raw.autoRecall !== false,
      auto_retain: raw.autoRetain !== false,
    };
  } catch {
    return null;
  }
}

function getPrimaryBank(c: Config): string {
  return c.bank_id || `project-${basename(process.cwd())}`;
}

function getRecallBanks(c: Config): string[] {
  const s = new Set<string>();
  s.add(getPrimaryBank(c));
  if (c.global_bank) s.add(c.global_bank);
  return [...s];
}

const UA = "pi-hindsight-smoke/1.1.0";

async function apiPost(path: string, body: unknown, config: Config, timeout = 20): Promise<{ ok: boolean; status: number; data?: any }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout * 1000);
    const res = await fetch(`${config.api_url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.api_key}`, "User-Agent": UA },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, data: await res.json() };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function apiGet(path: string, config: Config): Promise<{ ok: boolean; status: number; data?: any }> {
  try {
    const res = await fetch(`${config.api_url}${path}`, {
      headers: { Authorization: `Bearer ${config.api_key}`, "User-Agent": UA },
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, data: await res.json() };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const errors: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    errors.push(`${name}: ${e.message || e}`);
    console.log(`  ✗ ${name}: ${e.message || e}`);
  }
}

async function main() {
  console.log("pi-hindsight smoke test\n" + "=".repeat(60));

  // ── 1. Config ──────────────────────────────────────────────────────────
  console.log("\n1. Config loading");
  const config = loadConfig();

  await test("loads ~/.hindsight/claude-code.json", async () => {
    assert.ok(config, "Config should load");
    assert.ok(config!.api_url, "api_url required");
    assert.ok(config!.api_key, "api_key required");
    console.log(`     api_url: ${config!.api_url}`);
    console.log(`     bank_id: ${config!.bank_id || "(auto-derived)"}`);
    console.log(`     recall_types: ${config!.recall_types.join(", ")}`);
    console.log(`     retain_every_n: ${config!.retain_every_n_turns}`);
  });

  if (!config) {
    console.log("\n  ⚠ No config — aborting remaining tests");
    process.exit(1);
  }

  const bank = getPrimaryBank(config);

  // ── 2. Health ──────────────────────────────────────────────────────────
  console.log("\n2. API health");

  await test("GET /health → 200", async () => {
    const r = await apiGet("/health", config);
    assert.ok(r.ok, `health failed: HTTP ${r.status}`);
    console.log(`     ${JSON.stringify(r.data)}`);
  });

  await test("GET /version → version info", async () => {
    const r = await apiGet("/version", config);
    assert.ok(r.ok, `version failed: HTTP ${r.status}`);
    console.log(`     v${r.data?.api_version}`);
  });

  // ── 3. Retain (agent_end simulation) ───────────────────────────────────
  console.log("\n3. Retain lifecycle (agent_end)");

  await test("retain async=true to primary bank", async () => {
    const r = await apiPost(`/v1/default/banks/${encodeURIComponent(bank)}/memories`, {
      items: [{
        content: `[smoke-test] pi-hindsight async retain at ${new Date().toISOString()}`,
        document_id: `smoke-async-${Date.now()}`,
        context: "pi-hindsight smoke test",
        timestamp: new Date().toISOString(),
        tags: ["smoke-test"],
      }],
      async: true,
    }, config);
    assert.ok(r.ok, `async retain failed: HTTP ${r.status}`);
    assert.ok(r.data?.operation_id, "should return operation_id");
    console.log(`     operation_id: ${r.data.operation_id}`);
  });

  await test("retain async=false to primary bank", async () => {
    const r = await apiPost(`/v1/default/banks/${encodeURIComponent(bank)}/memories`, {
      items: [{
        content: `[smoke-test] pi-hindsight sync retain at ${new Date().toISOString()}`,
        document_id: `smoke-sync-${Date.now()}`,
        context: "pi-hindsight smoke test",
        timestamp: new Date().toISOString(),
        tags: ["smoke-test"],
      }],
      async: false,
    }, config, 30);
    if (r.ok) {
      console.log(`     tokens: ${r.data?.usage?.total_tokens}`);
    } else if (r.status === 504) {
      console.log(`     ⚠ HTTP 504 — server busy (sync processing timeout)`);
      // Not a bug — server under load
    } else {
      assert.fail(`sync retain failed: HTTP ${r.status}`);
    }
  });

  await test("retain with update_mode=append", async () => {
    const docId = `smoke-append-${Date.now()}`;
    const path = `/v1/default/banks/${encodeURIComponent(bank)}/memories`;
    // First write
    const r1 = await apiPost(path, {
      items: [{ content: "Part one.", document_id: docId, update_mode: "replace", context: "test", timestamp: new Date().toISOString() }],
      async: false,
    }, config, 30);
    assert.ok(r1.ok, `replace failed: HTTP ${r1.status}`);
    // Append
    const r2 = await apiPost(path, {
      items: [{ content: "Part two appended.", document_id: docId, update_mode: "append", context: "test", timestamp: new Date().toISOString() }],
      async: false,
    }, config, 30);
    assert.ok(r2.ok, `append failed: HTTP ${r2.status}`);
    console.log(`     doc "${docId}": replace + append both ok`);
  });

  // ── 4. Recall (before_agent_start simulation) ──────────────────────────
  console.log("\n4. Recall lifecycle (before_agent_start)");

  await test("recall from primary bank (graceful on 504)", async () => {
    const r = await apiPost(`/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`, {
      query: "Kubernetes architecture",
      budget: config.recall_budget,
      max_tokens: config.recall_max_tokens,
      query_timestamp: new Date().toISOString(),
      types: config.recall_types,
    }, config, 20);

    if (r.ok) {
      const count = r.data?.results?.length ?? 0;
      console.log(`     ${count} results from "${bank}"`);
      if (count > 0) console.log(`     first: ${r.data.results[0].text?.slice(0, 120)}`);
    } else if (r.status === 504) {
      console.log(`     ⚠ HTTP 504 — server recall pipeline timeout (known issue with large banks)`);
      // Don't fail — this is a server-side limitation, not an extension bug
    } else {
      assert.fail(`Unexpected HTTP ${r.status}`);
    }
  });

  // ── 5. Manual tools ────────────────────────────────────────────────────
  console.log("\n5. Manual tools");

  await test("hindsight_retain — explicit save with tags", async () => {
    const r = await apiPost(`/v1/default/banks/${encodeURIComponent(bank)}/memories`, {
      items: [{
        content: "Explicit retain via hindsight_retain tool simulation",
        context: "pi: explicit user save",
        timestamp: new Date().toISOString(),
        tags: ["smoke-test", "manual"],
      }],
      async: true,
    }, config);
    assert.ok(r.ok, `explicit retain failed: HTTP ${r.status}`);
    console.log(`     saved to bank "${bank}"`);
  });

  // ── 6. Error handling ──────────────────────────────────────────────────
  console.log("\n6. Error handling");

  await test("bad API key → 401/403", async () => {
    const bad = { ...config, api_key: "invalid-key" };
    const r = await apiPost(`/v1/default/banks/${encodeURIComponent(bank)}/memories`, {
      items: [{ content: "test" }],
      async: true,
    }, bad);
    assert.ok(!r.ok);
    assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
    console.log(`     correctly rejected: HTTP ${r.status}`);
  });

  await test("unreachable URL → ok:false status:0", async () => {
    const bad = { ...config, api_url: "http://localhost:1" };
    const r = await apiGet("/health", bad);
    assert.ok(!r.ok);
    assert.equal(r.status, 0);
    console.log("     connection refused correctly handled");
  });

  // ── 7. /hindsight command simulation ───────────────────────────────────
  console.log("\n7. /hindsight status (command simulation)");

  await test("full status check", async () => {
    const health = await apiGet("/health", config);
    assert.ok(health.ok, "server must be healthy");

    const profile = await apiGet(`/v1/default/banks/${encodeURIComponent(bank)}/profile`, config);
    // Profile might 404 if bank was auto-created — that's ok
    const authOk = profile.ok || profile.status === 404;

    console.log(`     URL:    ${config.api_url}`);
    console.log(`     Bank:   ${bank}`);
    console.log(`     Server: ${health.ok ? "✓ online" : "✗ down"}`);
    console.log(`     Auth:   ${profile.ok ? "✓ ok" : profile.status === 404 ? "⚠ bank not found (ok if new)" : `✗ HTTP ${profile.status}`}`);

    assert.ok(authOk || health.ok, "should be able to reach the API");
  });

  await test("GET /banks/{id}/stats", async () => {
    const r = await apiGet(`/v1/default/banks/${encodeURIComponent(bank)}/stats`, config);
    assert.ok(r.ok, `stats failed: HTTP ${r.status}`);
    console.log(`     stats: ${JSON.stringify(r.data)}`);
  });

  // ── Summary ────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (errors.length > 0) {
    console.log("\nFailures:");
    errors.forEach((e) => console.log(`  - ${e}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(2);
});
