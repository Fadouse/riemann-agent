# Changelog

## [Unreleased]

### Changed

- Serialized tool progress delivery with bounded bookkeeping while preserving update ordering and completion waits.

### Fixed

- Fixed proxied assistant responses dropping persisted provider-native thinking levels.
- Fixed the write tool reporting UTF-16 code-unit counts as byte counts by removing the misleading count ([#8979](https://github.com/earendil-works/pi/issues/8979)).

## [0.84.4] - 2026-08-28

### Breaking Changes

- Changed `prepareNextTurn` and `prepareNextTurnWithContext` to run only after `shouldStopAfterTurn` and queued-message checks determine that the agent loop will start another assistant turn. They no longer run after final or terminating turns; move end-of-run work to `agent_end` handling ([#6879](https://github.com/earendil-works/pi/issues/6879)).

### Fixed

- Fixed Windows `NodeExecutionEnv` aborts crashing when `taskkill.exe` is unavailable on `PATH` ([#6596](https://github.com/earendil-works/pi/issues/6596)).

### Removed

- Removed the withdrawn manual-drive configuration, action inspection methods, action outcomes, and snapshot action field from `AgentHarness`.

## [0.84.3] - 2026-08-24

### Fixed

- Fixed single-object `edit` tool inputs failing validation by accepting them as one-edit arrays ([#7835](https://github.com/earendil-works/pi/issues/7835)).
- Fixed root Markdown files such as `README.md` and `AGENTS.md` in skill directories being reported as broken skills unless they declare valid skill frontmatter ([#7805](https://github.com/earendil-works/pi/issues/7805)).

## [0.84.2] - 2026-08-14

### Added

- Added optional runtime-only content blocks to compaction summary messages for reconstructed snapshot archives.
- Added runtime-only provider-native payloads to compaction summary messages for OpenAI encrypted artifact replay.

### Fixed

- Fixed `streamProxy()` dropping finalized tool-call metadata such as OpenAI Responses namespaces ([#7709](https://github.com/earendil-works/pi/issues/7709)).

## [0.84.1] - 2026-08-07

### Added

- Added `BeforeToolCallResult.terminate` so blocked tool calls can participate in the existing batch early-termination rule ([#7715](https://github.com/earendil-works/pi/pull/7715) by [@muyiyr](https://github.com/muyiyr)).

### Fixed

- Fixed `Agent.reset()` clearing transcript and runtime state during active runs; it now rejects until the agent is idle ([#7717](https://github.com/earendil-works/pi/pull/7717) by [@wesleyzhangwq](https://github.com/wesleyzhangwq)).

## [0.84.0] - 2026-08-06

### Breaking Changes

- Replaced the legacy harness session model with the v4 lane-based `Session`, `SessionStorage`, and `SessionRepo` APIs, including durable operation records, global facts, shared sequence numbers, and tree-scoped lane views.
- Promoted the v2 session and `AgentHarness` API from the experimental entrypoint to the default package export and removed the experimental subpaths.
- Removed the legacy JSONL and in-memory repository APIs. Use the v4 `JsonlSessionRepo` or `InMemorySessionRepo`, both implementing the new `SessionRepo` contract.
- Added the required `FileSystem.renameFile()` operation to harness execution environments for atomic JSONL publication; custom file-system implementations must provide same-filesystem replacement semantics ([#7707](https://github.com/earendil-works/pi/pull/7707) by [@davidbrai](https://github.com/davidbrai)).

### Added

- Added typed AI-request and harness telemetry schemas, their combined schema tuple, callback helpers, and a generated schema reference.
- Added bounded `Session.findEntriesOnBranch()` and `findEntryOnBranch()` queries with explicit traversal, filtering, ordering, and limit options.
- Added a compile-complete `AgentHarness` v2 scaffold; unfinished operation paths reject with `HarnessNotImplemented` while durable execution is implemented.
- Added `JsonlSessionRepo`, a v4 append-only JSONL session repository with metadata validation and shared storage semantics ([#7611](https://github.com/earendil-works/pi/pull/7611) by [@davidbrai](https://github.com/davidbrai)).
- Added indexed `Session.findOpenOperations()` recovery queries and `RecordQuery.operationKind` filtering ([#7646](https://github.com/earendil-works/pi/pull/7646)).
- Added `AgentOptions.shouldStopAfterTurn` for gracefully stopping after a completed turn before queued messages or another model call are processed. See [Agent Options](README.md#agent-options) ([#7367](https://github.com/earendil-works/pi/pull/7367) by [@acmerfight](https://github.com/acmerfight)).
- Added proxy forwarding for arbitrary OpenAI-compatible `samplingParams` ([#7568](https://github.com/earendil-works/pi/pull/7568) by [@mrexodia](https://github.com/mrexodia)).

### Fixed

- Fixed Windows path handling for `NodeExecutionEnv` file basenames, recursive skill loading, and prompt template names.
- Fixed `JsonlSessionRepo` enforcing session IDs globally across working directories; IDs are now unique within each working directory.
- Fixed JSONL session forks and torn-tail repairs to publish atomically, avoiding partially written or corrupted sessions after interrupted writes ([#7707](https://github.com/earendil-works/pi/pull/7707) by [@davidbrai](https://github.com/davidbrai)).

## [0.83.0] - 2026-07-29

## [0.82.1] - 2026-07-25

## [0.82.0] - 2026-07-24

### Breaking Changes

- Replaced `AgentHarness`'s `ExecutionEnv` dependency and context-free `AgentTool` inputs with application-defined `toolContext` values and context-aware `AgentHarnessTool` definitions.

### Added

- Added context-aware `read`, `write`, `edit`, and `bash` harness tools backed by `ExecutionEnv`, including async bash execution preparation.

### Changed

- Aligned harness tool path handling, edit serialization, shell output capture, explicit non-inherited environments, and cross-platform process cleanup with coding-agent behavior.

### Fixed

- Fixed compaction and branch-summary requests to use fresh routing session IDs with prompt caching disabled where supported ([#6618](https://github.com/earendil-works/pi/pull/6618) by [@tmustier](https://github.com/tmustier)).

## [0.81.1] - 2026-07-21

### Added

- Added retry policy support and lifecycle events for compaction and branch-summary operations in `AgentHarness` ([#6901](https://github.com/earendil-works/pi/pull/6901) by [@davidbrai](https://github.com/davidbrai)).

### Fixed

- Restored the `Agent` `streamFn` option and host-configurable fallback for omitted agent-loop stream functions without reintroducing a `pi-ai/compat` dependency ([#6915](https://github.com/earendil-works/pi/issues/6915)).

## [0.81.0] - 2026-07-21

### Breaking Changes

- Changed `SessionStorage` to use `getPathToRootOrCompaction()`, require session name and statistics methods, support cursor-based entry reads, and store retained compaction tails as self-contained checkpoints ([#6594](https://github.com/earendil-works/pi/pull/6594) by [@cristinaponcela](https://github.com/cristinaponcela)).
- Moved the `uuidv7` export to `@earendil-works/pi-ai` ([#6834](https://github.com/earendil-works/pi/pull/6834) by [@xl0](https://github.com/xl0)).
- Replaced the optional `Agent` `streamFn` fallback with a required `streamFunction` and made low-level loop stream functions required, preventing `@earendil-works/pi-ai/compat` and all built-in providers from entering selective-provider bundles ([#6851](https://github.com/earendil-works/pi/issues/6851)).

### Added

- Added usage metadata to tool results, compaction entries, and branch summaries in the agent harness ([#6671](https://github.com/earendil-works/pi/pull/6671) by [@davidbrai](https://github.com/davidbrai)).

## [0.80.10] - 2026-07-16

## [0.80.9] - 2026-07-16

## [0.80.8] - 2026-07-16

## [0.80.7] - 2026-07-14

### Added

- Added `AgentToolResult.addedToolNames` propagation to `ToolResultMessage` so tools introduced by a result can be loaded from that transcript point onward ([#6474](https://github.com/earendil-works/pi-mono/pull/6474)).

## [0.80.6] - 2026-07-09

### Added

- Added the `max` model thinking level after `xhigh`.

## [0.80.5] - 2026-07-09

## [0.80.4] - 2026-07-09

### Added

- Added configurable harness session context entry transforms and custom-entry message projectors.
- Added custom metadata support in JSONL session headers ([#6417](https://github.com/earendil-works/pi/pull/6417) by [@ArcadiaLin](https://github.com/ArcadiaLin)).
- Exported `InMemorySessionStorage` and `JsonlSessionStorage` ([#6435](https://github.com/earendil-works/pi/issues/6435)).

### Fixed

- Fixed harness split-turn compaction to serialize summary requests so single-concurrency providers are not asked to run overlapping generations ([#5536](https://github.com/earendil-works/pi/issues/5536)).
- Fixed harness tool calls from length-truncated assistant messages to fail instead of waiting for missing tool results ([#6285](https://github.com/earendil-works/pi/pull/6285)).
- Fixed harness session ingestion to normalize `null` message content before context projection, avoiding crashes on lax imported transcripts ([#6343](https://github.com/earendil-works/pi/pull/6343)).
- Fixed non-positive or oversized harness shell execution timeouts to fail with a clear validation error instead of being clamped to an immediate timeout ([#6181](https://github.com/earendil-works/pi/issues/6181)).
- Fixed harness session storage short entry ids to use the random tail of the generated uuidv7 instead of the timestamp prefix, which was nearly constant between calls ([#6242](https://github.com/earendil-works/pi/issues/6242)).

## [0.80.3] - 2026-06-30

### Added

- Added `prepareNextTurnWithContext` for `Agent` users that need the next-turn loop context.

### Fixed

- Fixed `Agent.prepareNextTurn` to keep receiving the run abort signal instead of the next-turn context.

## [0.80.2] - 2026-06-23

### Changed

- Renamed the public harness shell execution options type from `ExecutionEnvExecOptions` to `ShellExecOptions`.

## [0.80.1] - 2026-06-23

## [0.80.0] - 2026-06-23

### Breaking Changes

- `AgentHarnessOptions.models` is required and is the only auth path: the harness streams turns, compaction, and branch summarization through the provided `Models` instance (`models.streamSimple()`/`completeSimple()`), resolving auth through the providers. `AgentHarnessOptions.getApiKeyAndHeaders` is removed — apps that resolved keys per request now express that as provider auth (`ApiKeyAuth`/`OAuthAuth`) on the providers in the `Models` collection. Build one with `createModels()` + provider factories (or `builtinModels()` from `@earendil-works/pi-ai/providers/all`); tests use `fauxProvider()`.
- `compact()`, `generateSummary()`, and `generateBranchSummary()` take a `Models` parameter and no longer accept explicit `apiKey`/`headers`.
- `StreamFn` is defined structurally (`(model, context, options?) => AssistantMessageEventStream | Promise<...>`); `Models.streamSimple` satisfies it.
- Removed the `@earendil-works/pi-agent-core/base` selective-provider entrypoint; use the root package with an explicit `Models` instance instead.

### Fixed

- Fixed harness session names to normalize newline characters before storing labels ([#5999](https://github.com/earendil-works/pi/pull/5999) by [@haoqixu](https://github.com/haoqixu)).
- Fixed harness compaction estimates to ignore malformed all-zero assistant usage after truncated responses ([#5526](https://github.com/earendil-works/pi/pull/5526) by [@dmmulroy](https://github.com/dmmulroy)).

## [0.79.10] - 2026-06-22

## [0.79.9] - 2026-06-20

### Fixed

- Fixed Node execution environment commands through legacy WSL `bash.exe` to pass scripts over stdin so shell variables expand in the target bash ([#5893](https://github.com/earendil-works/pi/issues/5893)).

## [0.79.8] - 2026-06-19

### Added

- Added `@earendil-works/pi-agent-core/base` for bundlers that want to pair the agent core with selective `@earendil-works/pi-ai/base` provider registration ([#5348](https://github.com/earendil-works/pi/pull/5348) by [@FredKSchott](https://github.com/FredKSchott)).

## [0.79.7] - 2026-06-18

## [0.79.6] - 2026-06-16

## [0.79.5] - 2026-06-16

## [0.79.4] - 2026-06-15

## [0.79.3] - 2026-06-13

## [0.79.2] - 2026-06-12

### Fixed

- Fixed late tool progress callbacks after tool settlement to be ignored instead of emitting stale `tool_execution_update` events ([#5573](https://github.com/earendil-works/pi/issues/5573)).

## [0.79.1] - 2026-06-09

## [0.79.0] - 2026-06-08

### Fixed

- Fixed the compaction summarization system prompt to use neutral AI assistant wording for non-coding agents ([#5401](https://github.com/earendil-works/pi/issues/5401)).

## [0.78.1] - 2026-06-04

## [0.78.0] - 2026-05-29

## [0.77.0] - 2026-05-28

### Breaking Changes

- Renamed agent harness `model_select` and `thinking_level_select` events to `model_update` and `thinking_level_update`.

### Added

- Added agent harness tool registry APIs, `tools_update` events, b
[preview truncated; inspect artifact]