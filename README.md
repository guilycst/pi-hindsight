# Hindsight Self-Hosted Extension for Pi

A fully autonomous Pi coding agent extension for integrating with a self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server. It brings team-shared persistent memory to your AI agent with zero manual tools needed.

## Features

- **Auto-Recall:** Intercepts agent start. Automatically queries API and injects context directly into the prompt stream. Zero agent action needed.
- **Auto-Retain (Background):** Hook triggers when agent finishes generating. Reads session transcript from disk. POSTs to API asynchronously. Agent does nothing.
- **Feedback Loop Prevention:** Native parser strips `<hindsight_memories>` blocks from transcript before retain. Prevents recursive memory bloat.
- **Operational Tool Filtering:** Native parser drops utility tools (Bash, Read, Write) from the transcript. Keeps only the actual conversation and code generations.
- **Direct REST API:** Uses native `fetch()` HTTP endpoints directly (`/v1/default/banks/...`). Fast and clean without CLI dependency.
- **Dynamic Project Tag:** Auto-creates a `project:YOUR_DIR_NAME` tag for context boundaries without any project setup.
- **Global Tag:** Optionally configure a user-specific tag (like `team-lead`) that gets automatically attached and recalled in all conversations.

### Opting in/out of memory
- **Opting out:** Start your prompt with `#nomem` or `#skip` and the agent will NOT retain anything from that turn to memory. Useful for scratch work.
- **Global Opt-in:** Add `#global` or `#me` anywhere in your prompt to simultaneously save the agent's insights from that turn into your `global_bank` (in addition to the project bank). Useful for universal learnings like a new bash trick.
- **Explicit Tagging:** Add hashtags like `#architecture` or `#bug` to your prompt. The extension will automatically extract these and attach them as formal tags in the Hindsight database for easy filtering later.

## Explicit Tools Included

While this extension handles the invisible background memory lifecycle natively (saving transcripts, retrieving context automatically), Pi does not natively support attaching external MCP servers via the CLI. 

To bridge this gap, we've included three manual tools directly into this extension so you can ask your agent to explicitly manage memory when needed:
- `hindsight_recall` (Manually pull additional context)
- `hindsight_retain` (Force-save a specific insight)
- `hindsight_reflect` (Synthesize context from memory)
## Setup
1. Install this extension:
   ```bash
   npm install -g path/to/hindsight-selfhosted
   pi install path/to/hindsight-selfhosted
   ```

2. Configure your Hindsight server credentials in `~/.hindsight/config`:
   ```toml
   api_url = "https://your-hindsight-server.com"
   api_key = "<API_KEY>"
   bank_id = "your-team-bank"
   global_tag = "optional-user-tag"
   ```

3. Type `/hindsight` in Pi to verify your configuration.

No further setup needed! Your agent will automatically remember project conventions across sessions without being explicitly told to use memory tools.
