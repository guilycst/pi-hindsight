# pi-hindsight

Hindsight memory extension for [Pi](https://github.com/mariozechner/pi-coding-agent). Reads the same `~/.hindsight/claude-code.json` config as the Claude Code Hindsight plugin — one config, two agents.

## Install

```bash
pi install git:github.com/guilycst/pi-hindsight
```

## Setup

Create `~/.hindsight/claude-code.json` (shared with Claude Code plugin):

```json
{
  "hindsightApiUrl": "https://your-hindsight-server.example.com",
  "hindsightApiToken": "your-api-token",
  "bankId": "my-project",
  "recallTypes": ["world", "experience"],
  "retainEveryNTurns": 10
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `hindsightApiUrl` | ✅ | Hindsight API base URL |
| `hindsightApiToken` | ✅ | API bearer token |
| `bankId` | — | Primary bank ID. Falls back to `project-<dirname>` |
| `recallTypes` | — | Memory types to recall. Default: `["world", "experience"]` |
| `retainEveryNTurns` | — | Auto-retain every N turns. Default: `1` |
| `globalBank` | — | Cross-project bank. Used with `#global` / `#me` tags |

Env var overrides: `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN`.

## Features

### Automatic Memory Lifecycle

- **Auto-Recall** (`before_agent_start`): Queries configured banks and injects relevant memories into context. Retries up to 3 times on failure.
- **Auto-Retain** (`agent_end`): Appends conversation transcript to a per-session document. Uses `async: true` for reliability.
- **Compaction reset**: Re-triggers recall after `/compact`.
- **Feedback loop prevention**: Strips `<hindsight_memories>` from retained transcripts.
- **Operational tool filtering**: Drops low-signal tools (bash, read, write, edit) from transcripts.

### Opt-In / Opt-Out

- `#nomem` or `#skip` — skip retain for that turn
- `#global` or `#me` — also retain to the global bank
- Custom `#tags` — extracted and attached for filtering

### Manual Tools

| Tool | Description |
|------|-------------|
| `hindsight_recall` | Search memory explicitly |
| `hindsight_retain` | Force-save an insight (with optional tags) |
| `hindsight_reflect` | Synthesize answers from stored knowledge |

### Commands

- `/hindsight` — Show status (config, health, auth, hook state, debug log)
- `/hindsight stats` — Memory/entity/document counts for active banks

### In-Chat Visibility

| Event | Display |
|-------|---------|
| Recall | `🧠 Hindsight recalled N memories` + snippet |
| Retain | `💾 Hindsight saved turn to memory → bank-name` |
| Retain failed | `💾 Hindsight retain failed — use hindsight_retain to save manually` |

## Debug

Set `HINDSIGHT_DEBUG=1` to enable logging to `~/.hindsight/debug-pi.log`.

## Smoke Test

```bash
node --experimental-strip-types smoke-test.ts
```

Tests config loading, health, retain lifecycle, recall lifecycle (graceful on 504), manual tools, auth error handling, and status commands against a live API.

## Changes from upstream (anh-chu/pi-hindsight)

- **Config**: Reads `~/.hindsight/claude-code.json` (JSON) instead of `~/.hindsight/config` (key=value). Shares config with Claude Code plugin.
- **Bank ID**: Supports explicit `bankId` from config (e.g. `"claude_code"`) with fallback to `project-<dirname>`.
- **Recall types**: Defaults to `["world", "experience"]` matching our Claude Code plugin convention.
- **URL encoding**: Bank IDs are `encodeURIComponent`'d in all API paths.
- **Retain**: Uses `async: true` for reliability under heavy server load.
- **Tags**: Manual retain tool accepts optional `tags` parameter.
- **Aborts**: Recall timeouts handled gracefully (504 treated as non-fatal).
