# Changelog

## [Unreleased]

### Breaking Changes

- Renamed the public `AgentResult.result` field to `AgentResult.output` and replaced `AgentHandle` with exact-Turn `AgentTurnHandle`.
- Renamed the `workspace` Python namespace to `fs` (`fs.read`, `fs.glob`, `fs.search`, `fs.edit`, `fs.create`, `fs.remove`); capabilities are now `fs.read`/`fs.write`.
- Removed `permissions: host|workspace` from `agents.main`, `agents.defaults`, and profiles; configure `filesystem: {read?, readExclude?, write?, writeExclude?}` instead, where each field is an absolute-path list or `inherit`.
- Changed the main Agent default filesystem to unrestricted read and write of `/` with no built-in exclusions; tools, shell, and the kernel sandbox all consume one `FileAccessPolicy`.
- Changed shared child Agents to inherit every filesystem field from their calling Agent and worktree children to inherit reads while defaulting writes to their own worktree; exclusions exist only where configured.
- Collapsed the Riemann `shell` operations into one script-based `shell.run(script, cwd, env, timeout)`; removed `shell.exec` and the argv `command`/`args` form.
- Removed the `state.checkpoint()` and `catalog.namespaces()` Python operations; kernel checkpointing remains automatic after each cell and the operation inventory remains in the system prompt.
- Hidden `artifacts.get`, `artifacts.view`, and `artifacts.materialize` from the model surface; use the `Artifact` dataclass methods `read()`, `view()`, and `materialize()` instead.
- Renamed `web.search` arguments `num_results`/`include_domains`/`start_published_date` to `limit`/`domains`/`since`, aligning the search `limit` vocabulary across `fs.glob`, `fs.search`, and `catalog.search`.
- Renamed the `fs.search` file-filter argument `pattern` to `glob`, removing the `query`/`pattern` ambiguity.
- Filesystem policies now require every configured root and exclusion to exist, require write roots to be covered by read roots, and treat `readExclude` as denying both reads and writes.
- Omitted Riemann `compaction.strategy` now resolves automatically: eligible supported Codex OAuth models use experimental context, other Codex OAuth models use cloud compaction, and other sessions use the semantic default strategy; set `default` explicitly to force semantic compaction on Codex.
- Replaced the Riemann Python operation bridge with strict lockstep schemas, keyword-only calls, discriminated result tags, normalized errors, and a single `agents.start()`/`mcp.open()` lifecycle surface; removed `agents.run()`, `agents.spawn()`, `AgentHandle.send()`, and `mcp.activate()`.
- Replaced `fs.search(regex=...)` with `fs.search(mode="literal" | "regex")`, defined edit offsets as Unicode code points, and changed Shell, Web, Artifact, and MCP result records to exact named shapes.
- Replaced the separate `shell.network` capability with `agents.main/defaults/profiles.network: allow | deny | inherit`; the effective policy now controls both IPython and `shell.run`, while Web and MCP host operations remain unaffected.
- Removed embedded Riemann config, bridge, result-tag, compaction-state, and managed-Python layout version markers; these lockstep contracts now reject stale shapes without compatibility aliases.

### Added

- Added native Codex context windows, budget reminders, encrypted history/notes recovery, and private transcript presentation.

- Added theme-aware, color-only running-tool dots with shared, bounded animation frames and cached tool-body rendering.
- Added configurable reusable Agent slots and default child-model selection to the settings panel.
- Added durable Agent completion delivery, standard transcript rendering, configurable Hub/viewer controls, and confirmed settled-slot release.
- Added exact-Turn `AgentTurnHandle.wait()`, `steer()`, cancellable settlement, durable results, and explicit queued/running admission status.
- Added direct-session image attachments across clipboard input with highlighted attachment markers, remote sessions, compaction, and explicit Riemann artifact image views.
- Added live Riemann compaction strategy switching with complete Automatic, Default, OpenAI Codex, and Snapshot settings choices.
- Added non-blocking compaction warnings for encrypted OpenAI context transitions, Snapshot models without image input, and incompatible OpenAI Codex model or OAuth selections.
- Added schema-derived operation discovery with inline return fields, bounded Python result representations, explicit image viewing, Unicode-safe snapshot editing, and structured artifact recovery metadata.

### Changed

- Aligned tool colors with Codex: terminal-default action titles and paths, Cyan entities, DIM output, ANSI status text, and tinted syntax-aware diffs; retained Riemann syntax palettes, exploration accents, and green success icons.
- Condensed collapsed IPython transcripts into structured exploration, command, file-change, and MCP summaries; adjacent exploration and repeated MCP calls are grouped within each cell, while expanded code and output remain available.
- Removed redundant running/tool labels from Subagent Fleet rows; the middle now shows only the latest available activity summary, without falling back to the original task.
- Simplified the main composer and Fleet rows; removed the prompt arrow, its reserved indentation, and the shortcut hint row, with the working directory on the left and model/context on the right. Detailed statistics remain in `/session`.
- Unified tool status markers and Subagent success/failure markers as full-size solid circles, with green success and red failure; Subagent selection and controls are unchanged.
- Restructured the Riemann main, child, operation, and compaction prompts around one runtime contract and catalog-backed schema discovery.
- Changed Riemann shell execution to resolve bash through pi's shared shell configuration (`bash -c`, legacy WSL stdin transport) instead of `$SHELL -lc`/`cmd /d /s /c`.
- Changed child delegation to one `agents.start()` operation returning durable `AgentTurnHandle` values with deterministic `info()`, `wait()`, `steer()`, `stop()`, and `release()` lifecycle controls.
- Changed Linux Riemann isolation to preserve workspace/state paths and host devices while one inheritable Agent network policy consistently controls both persistent IPython and `shell.run`; PID namespaces still provide deterministic descendant cleanup.
- Changed `agents.list()` to render compact `AgentInfo` summaries with bounded latest-output previews, while retaining full metadata as explicit fields and exact-Turn result retrieval through each item's handle methods.
- Compacted Subagent Viewer transcript spacing and sized short overlays to their rendered content while preserving long-transcript scrolling.
- Reduced startup and long-session overhead by coalescing model refreshes, gating Riemann migrations, using bounded artifact reads, and reusing session traversal results.
- Reduced interactive streaming work by coalescing assistant, shell, and Subagent display updates and caching Mermaid transforms, footer totals, session search text, and fullscreen transcript search.
- Reduced IPython checkpoint serialization to one common-path pass while retaining automatic snapshots and per-variable fallback diagnostics.
- Changed OpenAI Codex cloud compaction to persist opaque context records without provider/model metadata.
- Reduced repeated session-context traversal, SQLite statement preparation and inbox sorting; agent patches no longer rewrite unchanged payload columns.
- Reused stable assistant Markdown blocks for the built-in renderer while preserving refresh semantics for custom themes and transforms; compared IPython activity fields without serializing output for cache keys.
- Reduced file-search line allocations, web-response copies, activity snapshot allocations, and Jupyter diagnostic-path construction; shell artifacts can be persisted in complete text parts without concatenating another full-sized output string.
- Reduced context-cache metadata retention and reused IPython source/output summaries on status updates; existing collapsed previews no longer materialize a padded copy of the full output.
- Unified collapsed tool rows onto one layout with default-color action titles, muted paths and search queries, shared result gutters, and unexpanded edit `+n -n` stats.
- Removed the Subagent Fleet operation-hint row above agent list entries.
- Reduced duplicate model catalog refreshes during startup and loaded `/resume` lists from streamed disk metadata indexes, without a process-wide history cache or a total index-record size cap.
- Deferred session search-text loading until a query is entered and cancelled pending picker reads on close, while preventing selection of incomplete search results.
- Enabled strict-prefer JSON-schema sampling by default for built-in `read`, `bash`, `powershell`, `edit`, and `write` tools, without requiring `PI_EXPERIMENTAL`. Extensions can re-register tool definitions with `constrainedSampling: false`.

- Limited collapsed shell command previews to five visual rows aligned with output; expanded views retain complete commands and results.

### Fixed

- Fixed the first Codex Automatic prompt waiting for context initialization before showing Working; capabilities are warmed at startup and persisted per account and model, while cancellable window initialization runs after `turn_start` and before model sampling.
- Fixed TUI streaming stalls with native Codex history by retaining footer context estimates across display-only deltas instead of reserializing unchanged encrypted and image payloads on each frame.

- Fixed diff word emphasis swapping syntax colors into bright blocks; collapsed previews retain both sides of the first replacement while expanded diffs remain complete.
- Fixed subagent creation labels to show Spawning/Spawned and restored muted task and interaction prompts.
- Fixed subagent interaction headers briefly displaying full IDs instead of names; missing names use short IDs with full IDs available when expanded.
- Unified first-level tool action capitalization and separated ordinary targets from action titles using terminal foreground.
- Fixed Fleet focus isolation, child draft and navigation restoration, hidden settlement errors, and short-window controls; release confirmation now explains worktree deletion and saved artifacts.
- Fixed empty final IPython results, cancellation, and timeouts retaining running or successful status indicators.
- Preserved long pasted drafts and queued image multiplicity when messages return to the editor.
- Fixed models treating `fs`, `shell`, `web`, Agent, catalog, state, and MCP namespace calls as parallel native tools by declaring `ipython` as the sole callable tool across its schema, main/child prompts, operation headings, and MCP guidance.
- Fixed managed Python startup on NixOS by resolving the host C++ runtime for ZeroMQ wheels while preserving existing library-path entries.
- Fixed active IPython cells remaining uninterruptible behind non-cooperative host requests, including managed-Python startup on NixOS hosts.
- Fixed async Agent calls being presented as synchronous expressions, and replaced delayed result-bearing completion injection with immediate minimal steering reminders.
- Fixed sandboxed command lookup to honor call-level `PATH`, resolve Nix profile symlinks canonically, and return a structured exit-127 result for missing executables.
- Fixed opaque `AgentInfo` field guidance and Agent completion presentation; the prompt exposes flat Turn fields, asynchronous completions emit immediate compact transcript lines, and the Subagent-only Fleet shows the latest Agent output.
- Fixed wrapped Riemann Shell activity previews exceeding their collapsed visual-row budget and increased fullscreen mouse-wheel scrolling from one to three rows per event.
- Fixed the Subagent Fleet to use one icon—active rows remain hollow until selected while settled rows retain their lifecycle outcome—and routed Viewer IPython calls through the same compact renderer as the Main Agent transcript.
- Fixed pasted image routing so deleting an `[Image #N]` marker omits that image from submission, while undo, history recall, retries, and restored queued messages preserve stable marker identity.
- Fixed the model-facing Agent profile contract: empty configurations omit `profile`, configured profiles expose exact policy keys, and unknown keys report valid alternatives without allocating a child slot.
- Removed redundant Shell metadata and empty Agent-profile inventory from the Riemann system prompt.
- Fixed Riemann and tool output decoding, grapheme-boundary previews, and trailing-newline expansion so Unicode streams render without mojibake or extra rows.
- Fixed Bubblewrap launches to preserve host cwd, HOME, temporary and terminal environment values; validate same-path mount policies; keep private IPC writable through exclusions; and detach brokers from the terminal foreground group.
- Fixed Riemann compaction configuration reloads, concurrent settings writes, async UI rollback, and truncated checkpoint rejection.
- Fixed Python checkpoint and restore temporaries retaining deleted user objects, while preserving every checkpoint and object-graph recovery.
- Fixed snapshot compaction context estimates omitting archive text and image blocks.
- Fixed expanded IPython activity output exceeding JavaScript spread argument limits and released derived activity caches when a cell is hidden.
- Show file-change addition and removal counts on collapsed Edited, Added, and Deleted headers.
- Fixed premature missing-model errors after login by waiting for catalog discovery. Radius now defaults to `balanced`, falling back to the first available Radius model when needed.
- Fixed shell command highlighting by parsing complete scripts before wrapping and recognizing external command names.
- Fixed tool output gutters to use vertical continuations and a final corner; successful shell commands with empty output now show `(no output)`.
- Fixed tool header metadata spacing to use a single space before parentheses.


## [0.85.1] - 2026-09-05

### New Features

- **GPT-6 Astra** — Available through OpenAI API keys and OpenAI Codex subscriptions. See [API Keys](docs/providers.md#api-keys) and [OpenAI Codex](docs/providers.md#openai-codex).

### Added

- Added GPT-6 Astra for OpenAI API keys and OpenAI Codex subscriptions.
- Added five-times-faster mouse wheel scrolling while holding Alt in fullscreen mode ([#9166](https://github.com/earendil-works/pi/pull/9166) by [@xl0](https://github.com/xl0)).

### Fixed

- Fixed configurable save keybindings in the model and thinking selectors ([#9149](https://github.com/earendil-works/pi/pull/9149) by [@rwachtler](https://github.com/rwachtler)).
- Fixed SDK import failures caused by unintentionally publishing internal experimental code and dependencies in 0.85.0. The experimental `client` and `experimental/plugin` subpaths and server/client commands are now source-only through `pi-test.sh`; the supported local SDK and stdio RPC API are unchanged ([#9132](https://github.com/earendil-works/pi/issues/9132)).
- Fixed mouse hover changing selection and recentering autocomplete and settings lists, causing clicks to target a different item.
- Fixed long prompt-cache requests for GPT-5.6+ Responses models to use `prompt_cache_options.ttl: "30m"` instead of `prompt_cache_retention: "24h"`.

## [0.85.0] - 2026-09-04

### New Features

- **Persistent Claude thinking effort** — Supported Anthropic transports preserve per-turn effort and recover safely from signed-thinking mismatches. See [Model Configuration](docs/models.md#model-configuration).
- **Fullscreen transcript controls** — Jump to the latest message from a scrolled transcript and use the embedded working indicator. See [TUI Fullscreen Viewport](docs/keybindings.md#tui-fullscreen-viewport).
- **Restorable in-memory sessions** — Resume externally stored session entries through the SDK. See [Session Management](docs/sdk.md#session-management).

### Added

- Added `SessionManager.inMemory()` support for restoring externally managed session entries ([#8980](https://github.com/earendil-works/pi/pull/8980) by [@y-nk](https://github.com/y-nk)).
- Added inherited OpenAI-compatible `vllmPriority` and `supportsMaxOutputTokens` model settings for vLLM scheduler priority and OpenAI Responses output-token limits ([#9004](https://github.com/earendil-works/pi/pull/9004) by [@AppleDannyClegg](https://github.com/AppleDannyClegg), [#8941](https://github.com/earendil-works/pi/pull/8941) by [@scturtle](https://github.com/scturtle)).
- Added inherited LaTeX rendering for relational algebra join symbols ([#9050](https://github.com/earendil-works/pi/pull/9050) by [@haoqixu](https://github.com/haoqixu)).
- Added a clickable "Jump to latest message" label with the `tui.altScreen.bottom` shortcut to the fullscreen transcript while it is scrolled up ([#9080](https://github.com/earendil-works/pi/pull/9080) by [@rwachtler](https://github.com/rwachtler)).

### Changed

- Moved the streaming working indicator into the default editor border and matched its default spinner and label to the thinking-level border color. Custom editors retain the standalone indicator unless they opt in to embedding it ([#8799](https://github.com/earendil-works/pi/pull/8799) by [@cristinaponcela](https://github.com/cristinaponcela)).
- Reduced inherited fullscreen transcript search latency on large transcripts by caching unchanged search results, indexing ASCII runs, and limiting highlight work to visible matches ([#8800](https://github.com/earendil-works/pi/pull/8800) by [@cristinaponcela](https://github.com/cristinaponcela)).

### Fixed

- Fixed managed `fd` and ripgrep downloads on Linux musl systems ([#9070](https://github.com/earendil-works/pi/pull/9070) by [@Charlie0113-T](https://github.com/Charlie0113-T)).
- Removed the unavailable inherited Grok Build 0.1 model from `/model` ([#9093](https://github.com/earendil-works/pi/pull/9093) by [@Jaaneek](https://github.com/Jaaneek)).
- Fixed inherited provider streams emitting incompatible event sequences and custom tool-call deltas.
- Restored the `@earendil-works/pi-coding-agent/client` compatibility entry point.
- Fixed the inherited Qwen Token Plan Individual catalog to include Qwen3.8 Flash ([#9021](https://github.com/earendil-works/pi/issues/9021)).
- Fixed inherited OpenAI Codex SSE parsing to process terminal events that are not followed by a blank line ([#9047](https://github.com/earendil-works/pi/issues/9047)).
- Fixed inherited GitHub Copilot Claude Fable 5 requests so selected reasoning levels are sent ([#8961](https://github.com/earendil-works/pi/issues/8961)).
- Fixed inherited Baseten GLM-5.2 models incorrectly advertising image input support ([#8293](https://github.com/earendil-works/pi/pull/8293) by [@Panoplos](https://github.com/Panoplos)).
- Fixed skills being unavailable when Bash is the only enabled tool ([#8552](https://github.com/earendil-works/pi/pull/8552) by [@xl0](https://github.com/xl0)).
- Fixed concurrent session shares overwriting one another ([#8613](https://github.com/earendil-works/pi/pull/8613) by [@wutongyuonce](https://github.com/wutongyuonce)).
- Fixed image orientation detection skipping EXIF data after non-EXIF APP1 segments ([#8616](https://github.com/earendil-works/pi/pull/8616) by [@wutongyuonce](https://github.com/wutongyuonce)).
- Fixed imported sessions overwriting an existing session with the same filename ([#8985](https://github.com/earendil-works/pi/pull/8985) by [@wutongyuonce](https://github.com/wutongyuonce)).
- Fixed session forks losing their compaction boundary ([#8990](https://github.com/earendil-works/pi/pull/8990) by [@acmerfight](https://github.com/acmerfight)).
- Fixed in-memory session forks before an active turn settled ([#8937](https://github.com/earendil-works/pi/pull/8937) by [@acmerfight](https://github.com/acmerfight)).
- Fixed inherited Fireworks GLM models using the wrong API adapter.
- Fixed inherited `NO_PROXY` matching for root domains and subdomains ([#8737](https://github.com/earendil-works/pi/pull/8737) by [@MeiSiristhebest](https://github.com/MeiSiristhebest)).
- Fixed `bash`, `edit`, `find`, `grep`, `ls`, `read`, and `write` tools ignoring `ctx.cwd` ([#8627](https://github.com/earendil-works/pi/pull/8627) by [@vmizg](https://github.com/vmizg)).
- Fixed inherited terminal startup under restricted seccomp policies that reject the `SIGWINCH` self-signal ([#8898](https://github.com/earendil-works/pi/pull/8898) by [@bartlomiejkida](https://github.com/bartlomiejkida)).
- Fixed inherited Zed terminal image capability detection ([#8828](https://github.com/earendil-works/pi/pull/8828) by [@Perlence](https://github.com/Perlence)).
- Fixed drag selection continuing over the fullscreen editor.
- Fixed managed `fd` and ripgrep downloads requiring the GitHub Releases API ([#8708](https://github.com/earendil-works/pi/pull/8708) by [@Terminator666666](https://github.com/Terminator666666)).
- Fixed branch summaries failing when reasoning consumes the previous 2048-token output cap ([#8845](https://github.com/earendil-works/pi/issues/8845)).
- Fixed the write tool reporting UTF-16 code-unit counts as byte counts by removing the misleading count ([#8979](https://github.com/earendil-works/pi/issues/8979)).
- Fixed proxied plain-HTTP provider requests hanging after a tool call by tunneling them with CONNECT ([#8134](https://github.com/earendil-works/pi/issues/8134)).
- Fixed RPC `abort` reporting success without cancelling an in-progress manual compaction ([#8920](https://github.com/earendil-works/pi/issues/8920)).

## [0.84.4] - 2026-08-28

### New Features

- **Terminal capability overrides** — Override detected terminal hyperlink, image, and truecolor support. See [Capability Overrides](docs/terminal-setup.md#capability-overrides).
- **Extension UI prompt events** — Integrations can distinguish active agent work from time spent waiting for `ctx.ui` prompts. See [Extension UI prompt events](docs/extensions.md#ui_prompt_start--ui_prompt_end).
- **RPC queue clearing** — Retrieve and clear queued steering and follow-up messages with `clear_queue`. See [RPC `clear_queue`](docs/rpc.md#clear_queue).
- **Fullscreen selection copy controls** — Disable automatic selection copying in fullscreen mode and use Ctrl+X to copy the active selection. See [UI & Display](docs/settings.md#ui--display).
- **DeepSeek V4 Flash Vision (experimental)** — Use the vision-capable model through the built-in DeepSeek provider. See [API Keys](docs/providers.md#api-keys).

### Added

- Added `supportsMidConvoEffort` to custom Anthropic Messages model compatibility settings.
- Added transcript notices for Anthropic thinking blocks dropped during provider recovery when cache miss notices are enabled.
- Added `ui_prompt_start` and `ui_prompt_end` extension events so host integrations can distinguish active agent work from waiting on user-facing `ctx.ui` prompts ([#8355](https://github.com/earendil-works/pi/pull/8355) by [@cristinaponcela](https://github.com/cristinaponcela)).
- Added `detectSupportedImageMimeTypeFromFile()` to the public library exports ([#8600](https://github.com/earendil-works/pi/pull/8600) by [@xl0](https://github.com/xl0)).
- Added inherited experimental vision-capable `deepseek-v4-flash-vision-exp` model support.
- Added transcript usage notices for compaction and branch summaries when cache miss notices are enabled.
- Added RPC `clear_queue` to retrieve and remove queued steering and follow-up messages ([#8432](https://github.com/earendil-works/pi/issues/8432)).
- Added environment variables and advanced settings for overriding auto-detected terminal hyperlink, image, and truecolor capabilities ([#8665](https://github.com/earendil-works/pi/issues/8665)).
- Added `fullscreenCopyOnSelect` to disable automatic fullscreen selection copy; when disabled, `Ctrl+X` copies the active text selection before falling back to the last assistant message, while `/tree` still copies the selected message ([#7720](https://github.com/earendil-works/pi/issues/7720)).

### Changed
- Changed fullscreen scrollbars to reveal on pointer entry, support optional `scrollbarTrack` and `scrollbarThumb` theme colors with muted and text fallbacks, keep one thumb color across normal and expanded states, and support track-click jumping.
- Changed fullscreen transcript search arrows to underline on hover and capitalized the search placeholder.
- Changed selectors in `/thinking`, `/model`, `/scoped-models`, `/trust`, per-model thinking settings, and theme settings to keep active options marked while browsing. `/scoped-models` now uses consistent per-item toggles and strikes through unavailable models ([#8900](https://github.com/earendil-works/pi/pull/8900)).

### Fixed

- Fixed toggling thinking visibility clearing partial output from running Bash tools ([#8611](https://github.com/earendil-works/pi/issues/8611)).
- Fixed Windows shell aborts crashing Pi when `taskkill.exe` is unavailable on `PATH` ([#6596](https://github.com/earendil-works/pi/issues/6596)).
- Fixed resumed sessions corrupting the next appended entry when their JSONL file lacks a trailing newline ([#8345](https://github.com/earendil-works/pi/issues/8345)).
- Fixed extension messages sent with `triggerTurn: false` while the agent is running being inserted between a tool call and its result, which made providers that validate message order reject the replayed history. They are now appended once the turn's tool results are in ([#8537](https://github.com/earendil-works/pi/issues/8537)).
- Fixed compaction and branch summaries forcing `toolChoice: "none"` ([#8649](https://github.com/earendil-works/pi/issues/8649), [#8638](https://github.com/earendil-works/pi/issues/8638)).
- Fixed large tool results crossing the auto-compaction threshold being sent to the provider before compaction. Pi now compacts between tool execution and the next assistant response in the same run, and restores interactive progress when that run resumes ([#6879](https://github.com/earendil-works/pi/issues/6879)).
- Fixed Google Vertex requests failing with `HttpsProxyAgent is not a constructor` when the bundled Node.js runtime uses an HTTP(S) proxy ([#8610](https://github.com/earendil-works/pi/issues/8610)).
- Fixed saving a default model from a non-empty model scope so it remains available in that scope.
- Fixed inherited `@` file autocomplete ranking to prefer direct and shallower matches over similarly ranked nested paths ([#8669](https://github.com/earendil-works/pi/pull/8669)).
- Fixed inherited OpenAI-compatible streams serializing thinking signatures repeatedly during streaming ([#8671](https://github.com/earendil-works/pi/pull/8671)).
- Fixed inherited main-screen rendering crashing when image-heavy output exceeded V8's string length limit ([#8028](https://github.com/earendil-works/pi/issues/8028)).
- Fixed inherited fullscreen double-click word selection splitting paths and kebab-case tokens on `/` and `-` ([#8676](https://github.com/earendil-works/pi/pull/8676)).
- Fixed inherited Cloudflare AI Gateway catalogs omitting supported `workers-ai/*` passthrough models.
- Fixed inherited OpenAI-compatible reasoning replay to merge consecutive streamed text and summary `reasoning_details` deltas.
- Fixed inherited OpenRouter reasoning controls so reasoning-mandatory models do not receive `effort: "none"` ([#8614](https://github.com/earendil-works/pi/pull/8614) by [@davidbrai](https://github.com/davidbrai)).
- Fixed inherited OpenAI-compatible Chat Completions ignoring an explicitly requested `toolChoice` when no tools are defined.
- Fixed inherited fragmented Mistral tool calls splitting when continuation chunks omit the tool-call ID ([#8387](https://github.com/earendil-works/pi/issues/8387)).

## [0.84.3] - 2026-08-24

### New Features

- **PowerShell tool** — Use optional native PowerShell command execution on Windows. See [PowerShell Tool](docs/windows.md#powershell-tool).
- **Safer managed updates** — Stage, verify, and atomically activate updates for installer-managed installations. See [Install and Manage](docs/packages.md#install-and-manage).
- **Model and thinking controls** — Select thinking levels with `/thinking`, search defaults, keep selections session-scoped, and persist them explicitly with Ctrl+S. See [Models and Thinking](docs/keybindings.md#models-and-thinking).

### Breaking Changes

- Renamed the inherited `GoogleThinkingLevel` type to `GoogleApiThinkingLevel` and added `ResolvedGoogleThinkingLevel` for normalized adapter levels.

### Added

- Added an optional `powershell` tool for Windows, configurable through `defaultTools` and the SDK. See [PowerShell Tool](docs/windows.md#powershell-tool).
- Added a `/thinking` selector and searchable default choices to the model and thinking selectors; Ctrl+S saves the selected model as the global default. See [Models and Thinking](docs/keybindings.md#models-and-thinking).
- Added optional routing session IDs to exported compaction summary helpers so callers can preserve provider routing without enabling prompt cache writes.
- Added transcript usage notices for compaction and branch summaries when cache miss notices are enabled.
- Added `session_compact_failed` extension events so compaction failures and aborts expose their reason, retry state, source, and error message to handlers ([#8175](https://github.com/earendil-works/pi/issues/8175)).
- Added inherited provider-neutral `toolChoice` support to simple stream requests.
- Added inherited automatic Anthropic server-side refusal fallback for supported first-party models, including returned-model usage pricing ([#8017](https://github.com/earendil-works/pi/issues/8017)).
- Added inherited configurable OpenAI-compatible thinking-token budget fields for vLLM, Qwen/SGLang, and llama.cpp servers. See [OpenAI Compatibility](docs/models.md#openai-compatibility) ([#8275](https://github.com/earendil-works/pi/pull/8275) by [@bnsd55](https://github.com/bnsd55)).
- Added inherited China-specific ZAI Coding Plan models, including GLM-4.6V vision support and API-equivalent usage cost estimates ([#8220](https://github.com/earendil-works/pi/issues/8220)).
- Added inherited `deepseek-v4-pro-0813` support to the Qwen Token Plan Individual catalog ([#8194](https://github.com/earendil-works/pi/issues/8194)).

### Changed

- Changed experimental installer-managed installations so `pi update` stages, verifies, and atomically activates the selected release in place. See [Install and Manage](docs/packages.md#install-and-manage).
- Changed inherited built-in xAI models to use the Responses API with encrypted reasoning replay and made Grok 4.6 the default xAI model ([#8124](https://github.com/earendil-works/pi/pull/8124) by [@Jaaneek](https://github.com/Jaaneek)).
- Changed inherited Anthropic, Azure OpenAI, Google, Mistral, and OpenAI adapters to send Pi's default `User-Agent` unless overridden ([#8305](https://github.com/earendil-works/pi/issues/8305)).
- Changed Windows and WSL keybinding defaults to avoid terminal-reserved shortcuts for image paste, model cycling, editor undo, fullscreen transcript navigation and search, and message queueing ([#8372](https://g
[preview truncated; inspect artifact]