# Riemann Agent

Riemann Agent is a persistent, IPython-first agentic system built on the Pi coding-agent runtime.

The model sees one tool: `ipython`. Workspace I/O, shell processes, web access, MCP tools, artifacts, and child agents are typed asynchronous Python functions installed into the persistent kernel. This keeps intermediate results in variables instead of repeatedly serializing them through model context.

## Runtime properties

- One durable IPython kernel per agent, with top-level `await`.
- Atomic post-cell Python-state snapshots and automatic restoration after kernel restart; external side effects are not rolled back.
- Snapshot/CAS file edits, atomic replacement, workspace boundary checks, and symlink escape rejection.
- SQLite-backed runs, agents, messages, artifacts, and revision capabilities.
- Content-addressed large-result artifacts.
- Lazy MCP activation; discovered tools use a Python/catalog namespace derived from the configured server name, with collision-safe fallback.
- Asynchronous reusable child Agents with durable handles, automatic completion delivery, steering, default-model selection, bounded run slots, shared/worktree topology, and host/workspace permissions.
- A `pi-subagents`-style Fleet below the editor plus an `/agents` hub for standard live transcripts, messaging, scrolling, stop, and slot-release controls.
- Strictly configured context compaction: subscription-backed OpenAI Codex, OMP snapshot archives, or Riemann semantic checkpoints.
- Pi's TUI, session management, model providers, authentication, settings, RPC mode, and extension ecosystem.

## Quick start

Requirements: Node.js 22.19 or newer, Python 3, either `uv` or Python `venv` plus `pip`, and Linux or macOS. Linux additionally requires Bubblewrap (`bwrap`).

```bash
npm install
npm run build
node packages/coding-agent/dist/cli.js
```

For source development:

```bash
./pi-test.sh
```

Riemann provisions a hash-pinned Python environment on first IPython use. User state defaults to `~/.riemann/agent`; override it with `RIEMANN_CODING_AGENT_DIR`. Set `RIEMANN_PYTHON` to an explicit host Python executable when `python3` is not the desired interpreter.

## Subagent UI

The Fleet appears automatically below the editor while Subagents are running or within their settled-row linger window, with up to five Subagent rows and no root-Agent row. Active rows use a hollow `○` until selected, when they become `●`; settled rows retain their lifecycle outcome icon (`✓`, `✗`, or `■`), linger for four seconds, then disappear. Running rows show the Agent name, latest response preview or current task, elapsed time, and tokens. With an empty editor, press `Left` or `Down` to focus the Fleet, use `Up`/`Down` to select a Subagent, and press `Enter` to open its conversation viewer.

Run `/agents` to inspect every current-run Agent. The Hub keeps settled Agents visible and uses the standard assistant, thinking, and tool renderers in its viewer. Default controls: `Enter` opens or messages, `x` twice stops an active turn, `r` twice releases a settled slot, `Ctrl+T` expands thinking, `Ctrl+O` expands tools, and `Esc` closes only the overlay. These actions are configurable keybindings. `Esc` during the Main Agent's active IPython cell interrupts the cell instead.

## System sandbox

Every IPython kernel and `shell.*` process runs inside a mandatory OS sandbox. Linux uses Bubblewrap as a filesystem boundary: workspace/state mounts remain capability-scoped, while commands share the host network, process/IPC namespaces, devices, `/proc`, and read-only `/sys`. macOS uses a deny-by-default Seatbelt profile through `/usr/bin/sandbox-exec`. Riemann fails closed when the native sandbox is unavailable; Windows is not supported.

The kernel communicates with the host through ZeroMQ IPC. Filesystem access follows a per-agent `FileAccessPolicy`: the main Agent defaults to unrestricted read and write of `/` with no built-in exclusions, configurable through `agents.main.filesystem` (`read`, `readExclude`, `write`, `writeExclude`, each a path list or `inherit`). Subagents independently use `shared` or `worktree` topology, defaulting to `shared`; shared children inherit every filesystem field from their calling Agent, and worktree children inherit reads while defaulting writes to their own worktree. Exclusions exist only where configured. Linux hardware and system inventory commands can access host devices and system interfaces without bypassing the filesystem mount policy. Managed Python and system executables are read-only, command lookup honors an explicit `env.PATH`, and host credentials remain filtered from the process environment.

Large-result artifacts, kernel snapshots, and isolated worktrees belonging to closed runs are garbage-collected by fixed age and size budgets. Active runs are never selected.

## Configuration

Global configuration: `~/.riemann/agent/config.yaml`. Trusted project configuration: `<workspace>/.riemann/config.yaml`; project values may lower the global slot cap and override trusted settings. Copy `examples/riemann-config.yaml` as a starting point.

The settings panel exposes the two routine Agent choices: reusable run slots and the default child model. The equivalent version-one YAML is:

```yaml
version: 1
agents:
  maxAgents: 4 # Main Agent excluded; 0 disables delegation
  main:
    filesystem:
      read: ["/"] # omit for the default unrestricted read root
      write: ["/"] # omit for the default unrestricted write root
  defaults:
    model: anthropic/claude-sonnet-4-5 # omit to inherit the Main Agent model
    workspace: shared # shared | worktree
    filesystem:
      read: inherit # inherit the calling Agent's read policy
      write: inherit # shared inherits; worktree defaults to its own worktree
```

Named profiles remain optional for specialist prompts, model overrides, or narrower capabilities. `await agents.run()` returns an `AgentResult` whose final response is `output`. `await agents.spawn()` returns a handle after admission while the child continues in the background. Completion reminders are progress signals, not batch barriers: retain every expected handle and retrieve each durable result with `await handle.wait()` before synthesis.

```bash
mkdir -p ~/.riemann/agent
cp packages/coding-agent/examples/riemann-config.yaml ~/.riemann/agent/config.yaml
```

Remove or disable the example Exa and MCP entries until their credentials and commands are configured. Secrets support `${ENVIRONMENT_VARIABLE}` expansion. Every enabled MCP server is listed to the model by default using only its configured name and required non-empty `description`; set `exposeToModel: false` to hide one. Commands, URLs, headers, environment variables, and discovered tool schemas remain hidden until activation. Activation remains lazy, and there is no redundant `mcp.list()` model operation.

Context compaction is selected in Riemann configuration:

```yaml
compaction:
  strategy: default # default | openai | snapshot
```

`default` is used when the setting is omitted and creates a model-generated semantic checkpoint.

`openai` strictly uses Codex Responses V2 cloud compaction. It requires the active model to use the `openai-codex` ChatGPT Plus/Pro OAuth provider, sends the discarded context to `https://chatgpt.com/backend-api/codex/responses`, validates exactly one opaque encrypted compaction item, persists it unchanged, and replays it on later matching Codex requests. It does not create a local snapshot or semantic backup and never switches strategy after an auth, model, request, or protocol failure.

The Codex subscription endpoint is a private first-party ChatGPT backend, not the documented public OpenAI API contract. Data handling follows the active ChatGPT workspace policy. `openai` does not use an `OPENAI_API_KEY`; start Riemann, run `/login`, and select OpenAI Codex (ChatGPT Plus/Pro).

Strategy selection is literal: `snapshot` requires an image-capable model and always uses OMP bitmap archives; `default` always uses Riemann's approved semantic compaction prompt. Custom `/compact <instructions>` is supported only by `default`. An incompatible strategy or failed compaction is reported as an error; Riemann does not hide a strategy switch in control flow.

## Python operations

The system prompt identifies the current date, working directory, OS, Linux distribution (for example NixOS or Debian), kernel, architecture, and shell so the model can select commands compatible with the actual host. It also lists every built-in async Python operation available to the current agent, filtered by its capability allowlist. These namespaces are preinstalled globals in the persistent IPython environment: bind results to variables and compose multiple operations with normal Python and top-level `await`. Use `help(fs.edit)` or `await catalog.describe(name="fs.edit")` only when the compact signature and description are insufficient. `await catalog.search(query="...")` remains available for task-based discovery.

```python
import asyncio

snap = await fs.read(path=\"src/main.ts\")
display(snap.lines(1, 80))

result = await shell.run(command=\"npm\", args=[\"test\"], timeout=300)
display((result.exit_code, result.stderr[-2000:]))

docs = await mcp.activate(name=\"filesystem_docs\")
matches = await catalog.search(query=\"filesystem documentation\")
display(matches)
handle = await agents.spawn(
    task=\"Review the changed API and report concrete defects.\",
    name=\"reviewer\",
)
review = await handle.wait(timeout=600)
display(review.output)

parallel_handles = await asyncio.gather(
    agents.spawn(task="Review parser behavior.", name="parser-review"),
    agents.spawn(task="Review API compatibility.", name="api-review"),
)
parallel_results = await asyncio.gather(*(handle.wait() for handle in parallel_handles))
display([result.output for result in parallel_results])

sync_result = await agents.run(
    task="Check the focused regression and return the failure trace.",
    name="test-reviewer",
    timeout=600,
)
display(sync_result.output)

```

Without a profile, `agents.run()` and `agents.spawn()` use `agents.defaults`. Select a configured profile for a different model, workspace topology, permissions, prompt, or capability set; model calls cannot supply filesystem paths or elevate a child beyond its parent. Capability overrides accept exact operations such as `web.search` and namespace shorthand such as `web`, which is normalized to `web.*`. Configured profile names and descriptions are listed directly in the system prompt.

Large values should remain in variables or artifacts; display only the slice needed for the next decision. A cancelled cell can have completed an external side effect, so inspect durable state before retrying.

## Architecture

`src/riemann/` contains the Riemann-specific runtime:

- `kernel/`: Jupyter Wire Protocol, kernel lifecycle, cancellation, checkpoint and restore.
- `functions/`: typed host-function registry plus workspace, shell, and web capabilities.
- `mcp/`: lazy stdio/Streamable HTTP clients and dynamic Python namespace installation.
- `agents/`: durable child admission, lifecycle, messaging, sessions, model roles, and worktrees.
- `state/`: SQLite metadata and content-addressed artifacts.
- `python/`: pinned managed runtime and the kernel bridge.
- `prompts/`: approved main, child, and compaction prompts.

Riemann remains based on Pi. The remaining sections document inherited provider, TUI, session, settings, extension, and SDK behavior.

---

## Inherited Pi documentation

- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Pi Packages](#pi-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)


## Providers & Models

For each built-in provider, pi maintains a list of tool-capable models. Configured provider catalogs refresh automatically; run `riemann update --models` to force an immediate refresh. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L).

**Subscriptions:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API keys:**
- Anthropic
- Ant Ling
- OpenAI
- Azure OpenAI
- DeepSeek
- NVIDIA NIM
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI Coding Plan (Global)
- ZAI Coding Plan (China)
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Baseten
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)

Pi also supports the llama.cpp router server. Configure it with `/login llama.cpp`, manage downloads and loaded models with `/llama`, then select a loaded model with `/model`. See [docs/llama-cpp.md](docs/llama-cpp.md) for setup and usage.

See [docs/providers.md](docs/providers.md) for other provider setup instructions.

**Custom providers & models:** Add providers via `~/.riemann/agent/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, session name, total token/cache usage (`↑` input, `↓` output, `R` cache read, `W` cache write, `CH` latest cache hit rate), cost, context usage, current model. Totals include assistant responses, usage reported by tools, and summary generation.

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| External editor | Ctrl+G opens `externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere |
| Clipboard | Ctrl+V to paste an image or text (Alt+V on Windows), or drag images onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage provider credentials |
| [`/llama`](docs/llama-cpp.md) | Download, load, and unload llama.cpp router models |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (file, ID, messages, tokens, cost) |
| `/tree` | Jump to any point in the session and continue from there |
| `/trust` | Save project trust decision for future sessions (restart required) |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML or JSONL file |
| `/import <file>` | Import and resume a session from a JSONL file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, themes, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit pi |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.riemann/agent/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |
| Ctrl+X | Copy the last assistant message |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so pi can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session-format.md](docs/session-format.md) for file format.

### Management

Sessions auto-save to `~/.riemann/agent/sessions/` organized by working directory.

```bash
riemann -c                  # Continue most recent session
riemann -r                  # Browse and select from past sessions
riemann --no-session        # Ephemeral mode (don't save)
riemann --name "my task"    # Set session display name at startup
riemann --session <path|id> # Use specific session file or ID
riemann --fork <path|id>    # Fork specific session file or ID into a new session
```

Use `/session` in interactive mode to see the current session ID before reusing it with `--session <id>` or `--fork <id>`.

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press Ctrl+X to copy the selected message
- Press Shift+L to label entries as bookmarks and Shift+T to toggle label timestamps

**`/fork`** - Create a new session file from a previous user message on the active branch. Opens a selector, copies the active path up to that point, and places the selected prompt in the editor for modification.

**`/clone`** - Duplicate the current active branch into a new session file at the current position. The new session keeps the full active-path history and opens with an empty editor.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Configure exactly one `compaction.strategy`: `openai` for subscription-backed Codex cloud compaction, `snapshot` for OMP bitmap archives, or `default` for Riemann's model-generated semantic checkpoint. Strategies never fall through to one another.

**Manual:** `/compact` uses the configured strategy. `/compact <custom instructions>` requires `strategy: default`; other strategies return an explicit error.

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy: OpenAI artifacts are opaque, snapshot archives have bounded frame and payload budgets, and semantic checkpoints summarize. The append-only JSONL history remains available; use `/tree` to revisit it. See [docs/compaction.md](docs/compaction.md) for inherited internals.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.riemann/agent/settings.json` | Global (all projects) |
| `.riemann/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

### Project Trust

On interactive startup, pi asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.riemann/agent/trust.json`. Trusting a project allows pi to load `.riemann/settings.json` and `.pi` resources, install missing project packages, and execute project extensions.

Before the trust decision, pi loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.riemann/agent/settings.json`, or change it with `/settings`.

`riemann config` and package commands use the same project trust flow, except `riemann update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.riemann/agent/trust.json` only; the current session is not reloaded, so restart pi for changes to take effect.

### Telemetry and update checks

Pi has two separate startup features:

- **Update check:** fetches `https://pi.dev/api/latest-version` to check whether a newer Pi version exists. Disable it with `PI_SKIP_VERSION_CHECK=1`. Disabling update checks only turns off this check.
- **Install/update telemetry:** after first install or a changelog-detected update, sends an anonymous version ping to `https://pi.dev/api/report-install`. This setting also controls optional provider attribution headers for OpenRouter, Cloudflare, and direct NVIDIA NIM requests. Opt out by setting `enableInstallTelemetry` to `false` in `settings.json`, or by setting `PI_TELEMETRY=0`. This does not disable update checks; Pi may still contact `pi.dev` for the latest version unless update checks are disabled or offline mode is enabled.

Use `--offline` or `PI_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

---

## Context Files

Pi loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.riemann/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

If a directory contains `AGENTS.override.md`, Pi loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory. Context files from other directories are still concatenated.

Use for project instructions (`AGENTS.md`/`CLAUDE.md`), conventions, common commands. All matching files are concatenated.

Disable context file loading with `--no-context-files` (or `-nc`).

### System Prompt

Replace the default system prompt with `.riemann/SYSTEM.md` (project) or `~/.riemann/agent/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.riemann/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.riemann/agent/prompts/`, `.riemann/prompts/`, or a [pi package](#pi-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name` or let the agent load them automatically.

```markdown
<!-- ~/.riemann/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `~/.riemann/agent/skills/`, `~/.agents/skills/`, `.riemann/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [pi package](#pi-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend pi with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

The default export can also be `async`. pi waits for async extension factories before startup continues, which is useful for one-time initialization such as fetching remote model lists before calling `pi.registerProvider()`.

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make pi look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `~/.riemann/agent/extensions/`, `.riemann/extensions/`, or a [pi package](#pi-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and pi immediately applies changes.

Place in `~/.riemann/agent/themes/`, `.riemann/themes/`, or a [pi package](#pi-packages) to share with others. See [docs/themes.md](docs/themes.md).

### Pi Packages

Bundle and share extensions, skills, prompts, and themes via npm or git. Find packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) or [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** Pi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
riemann install npm:@foo/pi-tools
riemann install npm:@foo/pi-tools@1.2.3      # pinned version
riemann install git:github.com/user/repo
riemann install git:github.com/user/repo@v1  # tag or commit
riemann install git:git@github.com:user/repo
riemann install git:git@github.com:user/repo@v1  # tag or commit
riemann install https://github.com/user/repo
riemann install https://github.com/user/repo@v1      # tag or commit
riemann install ssh://git@github.com/user/repo
riemann install ssh://git@github.com/user/repo@v1    # tag or commit
riemann remove npm:@foo/pi-tools
riemann uninstall npm:@foo/pi-tools          # alias for remove
riemann list
riemann update --extensions                  # update installed packages
riemann update --extensions                  # update packages only
riemann update --models                      # refresh model catalogs only
riemann update npm:@foo/pi-tools             # update one package
riemann config                               # enable/disable extensions, skills, prompts, themes
```

Packages install to `~/.riemann/agent/git/` (git) or `~/.riemann/agent/npm/` (npm). Use `-l` for project-local installs (`.riemann/git/`, `.riemann/npm/`). Git `@ref` values are pinned tags or commits; pinned packages are skipped by `riemann update --extensions`, so use `riemann install git:host/user/repo@new-ref` to move an existing package to a new ref. Git packages install dependencies with `npm install --omit=dev` by default, so runtime deps must be listed under `dependencies`; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers. If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `pi` key to `package.json`:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `riemann` manifest, pi auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "riemann-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
riemann --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Philosophy

Pi is aggressively extensible so it doesn't have to dictate your workflow. Features that other tools bake in can be built with [extensions](#extensions), [skills](#skills), or installed from third-party [pi packages](#pi-packages). This keeps the core minimal while letting you shape pi to fit how you work.

**No MCP.** Build CLI tools with READMEs (see [Skills](#skills)), or build an extension that adds MCP support. [Why?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or build your own with [extensions](#extensions), or install a package that does it your way.

**No permission popups.** Run in a container, or build your own confirmation flow with [extensions](#extensions) inline with your environment and security requirements.

**No plan mode.** Write plans to files, or build it with [extensions](#extensions), or install a package.

**No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with [extensions](#extensions).

**No background bash.** Use tmux. Full observability, direct interaction.

Read the [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) for the full rationale.

---

## CLI Reference

```bash
riemann [options] [@files...] [messages...]
```

### Package Commands

```bash
riemann install <source> [-l]     # Install package, -l for project-local
riemann remove <source> [-l]      # Remove package
riemann uninstall <source> [-l]   # Alias for remove
riemann update [source]           # Update one package source
riemann update --extensions       # Update packages only
riemann update --models           # Refresh model catalogs only
riemann update --extension <src>  # Update one package
riemann list                      # List installed packages
riemann config                    # Enable/disable package resources
```

`riemann config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `riemann update` never prompts for project trust.

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, Riemann also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | riemann -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path\|id>` | Use specific session file or partial UUID |
| `--fork <path\|id>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable AGENTS.md and CLAUDE.md context file discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Add user instructions inside the Riemann execution contract |
| `--append-system-prompt <text>` | Append user instructions to the Riemann execution contract |
| `--tui-mode <mode>` | TUI mode: `regular` (default) or experimental `fullscreen` |
| `--use-theme <name[/name]>` | Set the initial interactive theme for this run without changing settings |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
riemann @prompt.md "Answer this"
riemann -p @screenshot.png "What's in this image?"
riemann @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
riemann "List all .ts files in src/"

# Non-interactive
riemann -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | riemann -p "Summarize this text"

# Named one-shot session
riemann --name "release audit" -p "Audit this repository"

# Different model
riemann --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
riemann --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
riemann --model sonnet:high "Solve this complex problem"

# Limit model cycling
riemann --models "claude-*,gpt-4o"

# High thinking level
riemann --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AI_AGENT` | Set to `riemann` by the CLI and RPC entry points |
| `RIEMANN_CODING_AGENT` | Set to `true` by the CLI and RPC entry points |
| `RIEMANN_CODING_AGENT_DIR` | Override config directory (default: `~/.riemann/agent`) |
| `RIEMANN_CODING_AGENT_SESSION_DIR` | Override session storage directory (overridden by `--session-dir`) |
| `RIEMANN_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `PI_OFFLINE` | Disable startup network operations, including update checks, package update checks, and install/update telemetry |
| `PI_SKIP_VERSION_CHECK` | Skip the Pi version update check at startup. This prevents the `pi.dev` latest-version request |
| `PI_TELEMETRY` | Override install/update telemetry and provider attribution headers. Use `1`/`true`/`yes` to enable or `0`/`false`/`no` to disable. This does not disable update checks |
| `PI_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | Fallback external editor for Ctrl+G when `externalEditor` is unset; defaults to Notepad on Windows and `nano` elsewhere |

Commands run by the LLM-callable bash tool also receive current session metadata:

| Variable | Description |
|----------|-------------|
| `PI_SESSION_ID` | Current session ID |
| `PI_SESSION_FILE` | Absolute session JSONL path; unset for ephemeral sessions |
| `PI_PROVIDER` | Currently selected model provider |
| `PI_MODEL` | Currently selected model ID |
| `PI_REASONING_LEVEL` | Current effective reasoning level |

These values are resolved when each command starts. See [Environment Variables](docs/environment-variables.md#bash-tool-session-environment) for semantics, examples, and custom-tool opt-out.

---

## Contributing & Development

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines and [docs/development.md](docs/development.md) for setup, forking, and debugging.

## License

MIT

## See Also

- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai): Core LLM toolkit
- [@earendil-works/pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core): Agent framework
- [@earendil-works/pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui): Terminal UI components

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
