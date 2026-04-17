# pi-hindsight

Hindsight memory extension for [Pi](https://github.com/mariozechner/pi-coding-agent). Autonomous memory via lifecycle hooks — recall before each turn, retain after each turn.

## Install

```bash
pi install git:github.com/guilycst/pi-hindsight
```

## Setup

Create `~/.hindsight/config`:

```ini
api_url = "https://your-hindsight-server.example.com"
api_key = "your-api-token"
bank_id = "my-project"
recall_types = "world,experience"
retain_every_n_turns = 10
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_url` | ✅ | — | Hindsight API base URL |
| `api_key` | ✅ | — | API bearer token |
| `bank_id` | — | `project-<dirname>` | Primary bank ID |
| `global_bank` | — | — | Cross-project bank (used with `#global` / `#me`) |
| `recall_types` | — | `world,experience` | Comma-separated memory types to search |
| `recall_budget` | — | `mid` | Recall budget |
| `recall_max_tokens` | — | `1024` | Max tokens per recall response |
| `recall_max_query_chars` | — | `800` | Max query length sent to recall |
| `retain_every_n_turns` | — | `1` | Auto-retain every N turns |
| `auto_recall` | — | `true` | Enable auto-recall |
| `auto_retain` | — | `true` | Enable auto-retain |

**Project override:** Place `.hindsight/config` in your project root. Local values override global.

**Env var overrides:** `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN`.

## Features

### Automatic Memory Lifecycle

- **Auto-Recall** (`before_agent_start`): Queries configured banks, injects relevant memories into context. Retries up to 3 times on failure.
- **Auto-Retain** (`agent_end`): Appends conversation transcript to a per-session document (`async: true`).
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

## Banks

- **Primary bank** — `bank_id` from config, or auto-derived as `project-<dirname>`. All turns retained here.
- **Global bank** — optional, configured via `global_bank`. Receives turns tagged `#global` or `#me`.

## Changes from upstream (anh-chu/pi-hindsight)

- **Bank ID**: Configurable via `bank_id` with project-derived fallback.
- **URL encoding**: Bank IDs are `encodeURIComponent`'d in all API paths.
- **Retain reliability**: Uses `async: true` for auto-retain under heavy server load.
- **Manual retain tags**: Accepts optional `tags` parameter.
- **Graceful degradation**: Recall 504 timeouts are non-fatal with retry logic.
