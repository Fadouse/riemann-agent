# Changelog

## [Unreleased]

### Added

- Added Codex experimental-context capability discovery, native encrypted history/notes tools, and history-ingestion metadata.

### Changed

- Reduced streaming tool-argument parsing and queued frame catch-up work while preserving every partial update and malformed-JSON repair behavior.
- Reduced completion-only event retention, strict tool schema conversion work, and dynamic model merge overhead without changing stream iteration or mutable input semantics.

### Fixed

- Fixed Cloudflare AI Gateway API typing and retained Workers AI passthrough models when upstream catalog data omits them.
- Fixed OpenAI Codex retrying non-retryable HTTP errors when retries are enabled.

## [0.85.1] - 2026-09-05

### Added

- Added GPT-6 Astra for OpenAI API keys and OpenAI Codex subscriptions.

### Fixed

- Fixed long prompt-cache requests for GPT-5.6+ Responses models to use `prompt_cache_options.ttl: "30m"` instead of `prompt_cache_retention: "24h"`.

## [0.85.0] - 2026-09-04

### Breaking Changes

- Replaced `createGatewayBindingFetch()` with `createAiBindingFetch()` for Cloudflare Workers AI bindings. Configure the model's Workers AI Gateway passthrough `baseUrl` directly; requests now pass through the binding unchanged ([#8287](https://github.com/earendil-works/pi/pull/8287) by [@Maximo-Guk](https://github.com/Maximo-Guk)).

### Added

- Added compact, persistable assistant-message frames with `AssistantMessageFrameEncoder` and `reduceAssistantMessageFrames()`.
- Added the `vllmPriority` OpenAI-compatible model setting for forwarding scheduler priority to vLLM ([#9004](https://github.com/earendil-works/pi/pull/9004) by [@AppleDannyClegg](https://github.com/AppleDannyClegg)).
- Added the `supportsMaxOutputTokens` OpenAI Responses compatibility setting ([#8941](https://github.com/earendil-works/pi/pull/8941) by [@scturtle](https://github.com/scturtle)).
- Added an optional timestamp argument to `uuidv7()` for follower IDs.
- Added narrow `api`, `providers`, and `utils` subpath exports for direct imports without loading the package barrel.
- Added Anthropic per-turn effort persistence, deterministic historical effort markers, and signed-thinking mismatch recovery for supported Claude models across Anthropic Messages transports, including OpenRouter.

### Fixed

- Removed the unavailable Grok Build 0.1 model from the built-in xAI catalog ([#9093](https://github.com/earendil-works/pi/pull/9093) by [@Jaaneek](https://github.com/Jaaneek)).
- Fixed assistant-message frames preserving the provider thinking level.
- Fixed simple provider streams to consistently emit standard stream events and custom tool-call deltas.
- Fixed the Qwen Token Plan Individual catalog to include Qwen3.8 Flash ([#9021](https://github.com/earendil-works/pi/issues/9021)).
- Fixed Baseten GLM-5.2 models incorrectly advertising image input support ([#8293](https://github.com/earendil-works/pi/pull/8293) by [@Panoplos](https://github.com/Panoplos)).
- Fixed Fireworks GLM models using the wrong API adapter.
- Removed the unnecessary Chord dependency from pi-ai by defining its exported `JsonValue` type directly.
- Fixed GitHub Copilot Claude Fable 5 requests to use the Anthropic Messages adapter so selected reasoning levels are sent ([#8961](https://github.com/earendil-works/pi/issues/8961)).
- Fixed OpenAI Codex SSE parsing to process terminal events that are not followed by a blank line ([#9047](https://github.com/earendil-works/pi/issues/9047)).
- Fixed `NO_PROXY` matching for both root domains and subdomains ([#8737](https://github.com/earendil-works/pi/pull/8737) by [@MeiSiristhebest](https://github.com/MeiSiristhebest)).

## [0.84.4] - 2026-08-28

### Added

- Added the experimental vision-capable `deepseek-v4-flash-vision-exp` model to the DeepSeek catalog.

### Fixed

- Fixed OpenAI-compatible Chat Completions ignoring an explicitly requested `toolChoice` when no tools are defined.
- Fixed thinking signature serialization to run once after the signature is complete ([#8671](https://github.com/earendil-works/pi/pull/8671)).
- Fixed fragmented Mistral tool calls splitting when continuation chunks omit the tool-call ID ([#8387](https://github.com/earendil-works/pi/issues/8387)).
- Fixed OpenAI-compatible reasoning replay to merge consecutive streamed text and summary `reasoning_details` deltas.
- Fixed the Cloudflare AI Gateway catalog to include supported `workers-ai/*` passthrough models omitted by models.dev.
- Fixed OpenRouter reasoning controls by deriving `off` support and available effort levels from OpenRouter's model metadata, preventing reasoning-mandatory models from receiving `effort: "none"` ([#8614](https://github.com/earendil-works/pi/pull/8614) by [@davidbrai](https://github.com/davidbrai)).

## [0.84.3] - 2026-08-24

### Breaking Changes

- Renamed `GoogleThinkingLevel` to `GoogleApiThinkingLevel` and added `ResolvedGoogleThinkingLevel` for normalized adapter levels.

### Added

- Added provider-neutral `toolChoice` support to simple stream requests.
- Added automatic Anthropic server-side refusal fallback for supported first-party models, including returned-model usage pricing ([#8017](https://github.com/earendil-works/pi/issues/8017)).
- Added configurable OpenAI-compatible thinking-token budget fields for vLLM, Qwen/SGLang, and llama.cpp servers ([#8275](https://github.com/earendil-works/pi/pull/8275) by [@bnsd55](https://github.com/bnsd55)).
- Added China-specific ZAI Coding Plan models, including GLM-4.6V vision support, and API-equivalent usage cost estimates for models with published PAYG prices ([#8220](https://github.com/earendil-works/pi/issues/8220)).
- Added `deepseek-v4-pro-0813` to the Qwen Token Plan Individual catalog ([#8194](https://github.com/earendil-works/pi/issues/8194)).

### Changed

- Changed built-in xAI models to use the Responses API with encrypted reasoning replay and made Grok 4.6 the default xAI model ([#8124](https://github.com/earendil-works/pi/pull/8124) by [@Jaaneek](https://github.com/Jaaneek)).
- Changed the Anthropic, Azure OpenAI, Google Generative AI, Google Vertex, Mistral, OpenAI Chat Completions, and OpenAI Responses adapters to send Pi's default `User-Agent` unless overridden ([#8305](https://github.com/earendil-works/pi/issues/8305)).

### Changed

- Reduced buffered stream queue dequeue overhead while preserving event ordering and completion semantics.

### Fixed

- Fixed OpenAI-compatible Chat Completions reasoning replay to preserve and resend assistant-level `reasoning_details` (`reasoning.text`, `reasoning.summary`, and `reasoning.encrypted`) verbatim and in order ([#7994](https://github.com/earendil-works/pi/issues/7994)).
- Fixed Anthropic server-side fallback responses being priced with the requested model instead of the returned fallback model ([#8285](https://github.com/earendil-works/pi/issues/8285)).
- Fixed GitHub Copilot login triggering model-policy rate limits by limiting policy updates, retrying model discovery once, and honoring server retry delays ([#7850](https://github.com/earendil-works/pi/issues/7850)).
- Fixed Amazon Bedrock dropping and failing to replay opaque redacted reasoning from non-Anthropic models ([#8314](https://github.com/earendil-works/pi/pull/8314) by [@seiji](https://github.com/seiji)).
- Fixed Z.AI Coding Plan models deriving incomplete reasoning-effort metadata, including missing GLM-5.3 low, high, and max levels ([#8336](https://github.com/earendil-works/pi/issues/8336)).
- Fixed DeepSeek V4 Flash on OpenCode and OpenCode Go omitting its supported low thinking level ([#8181](https://github.com/earendil-works/pi/pull/8181) by [@tianshuang](https://github.com/tianshuang)).
- Fixed Azure OpenAI Responses ignoring `toolChoice` in provider-specific stream requests.
- Fixed Amazon Bedrock `after_provider_response`/`onResponse` to forward the raw response headers instead of only the synthesized request id header ([#8234](https://github.com/earendil-works/pi/issues/8234)).
- Fixed Kimi OpenAI-compatible usage reporting so top-level `cached_tokens` count as cache reads instead of normal input tokens ([#8075](https://github.com/earendil-works/pi/issues/8075)).
- Fixed Google Generative AI and Vertex AI custom models ignoring `thinkingLevelMap`, which dropped extended thinking controls ([#8135](https://github.com/earendil-works/pi/issues/8135)).
- Fixed Xiaomi model catalog generation retaining shut-down MiMo V2 model names after models.dev marked them deprecated ([#8187](https://github.com/earendil-works/pi/issues/8187)).

## [0.84.2] - 2026-08-14

### Added

- Added `createGatewayBindingFetch()` for routing Cloudflare AI Gateway requests through a Workers AI binding without an API token ([#7901](https://github.com/earendil-works/pi/pull/7901) by [@Maximo-Guk](https://github.com/Maximo-Guk)).
- Added `AssistantMessage.endTurn` to preserve OpenAI Codex's terminal `end_turn` signal for diagnostics ([#7766](https://github.com/earendil-works/pi/pull/7766)).

### Added

- Added optional image resolution hints and forwarded them through OpenAI Responses and compatible Chat Completions transports.
- Added subscription-backed OpenAI Codex Responses V2 compaction and provider-native history payload replay.

### Changed

- Changed Kimi Coding requests to use pi's runtime `User-Agent` header.
- Automatically converted supported strict tool schemas to provider-compatible closed objects with required nullable optional fields while preserving original tool definitions, and treated `null` values for optional non-nullable tool arguments as omitted.
- Changed OpenAI Responses deferred tool loading to prefer message-anchored `additional_tools` where supported while retaining tool-search and top-level fallbacks ([#7709](https://github.com/earendil-works/pi/issues/7709)).
- Replaced the Mistral SDK transport with a native Chat Completions HTTP stream, eliminating its generated client and schema runtime overhead.

### Fixed

- Fixed GitHub Copilot login triggering API rate limits while enabling model policies by limiting concurrent policy updates ([#6187](https://github.com/earendil-works/pi/issues/6187)).
- Fixed GitHub Copilot login still triggering API rate limits by updating only account models with unconfigured policies and honoring server retry delays ([#7850](https://github.com/earendil-works/pi/issues/7850)).
- Fixed upstream request buffer limit failures to trigger automatic assistant retries.
- Fixed OpenAI Responses function and custom tool calls to preserve namespaces during streaming, proxying, and replay ([#7709](https://github.com/earendil-works/pi/issues/7709)).
- Fixed built-in and custom DeepSeek API models to send output limits through the supported `max_tokens` field.
- Fixed Google Generative AI and Vertex AI responses with tool calls incorrectly treating output-limit or provider-error stops as normal tool use ([#8059](https://github.com/earendil-works/pi/issues/8059)).
- Fixed Amazon Bedrock replay rejecting tool arguments that contain empty object keys while preserving all valid nested values ([#7882](https://github.com/earendil-works/pi/pull/7882) by [@muyiyr](https://github.com/muyiyr)).
- Fixed DeepSeek compatibility detection for base URLs whose hostname contains uppercase letters ([#7933](https://github.com/earendil-works/pi/pull/7933) by [@yearth](https://github.com/yearth)).

## [0.84.1] - 2026-08-07

### Added

- Added Qwen Token Plan Individual as a built-in provider with its documented subscription model catalog and the shared international `QWEN_TOKEN_PLAN_API_KEY` ([#7659](https://github.com/earendil-works/pi/pull/7659) by [@arasovic](https://github.com/arasovic)).

## [0.84.0] - 2026-08-06

### Breaking Changes

- Renamed the exported `ModelsStreamTransforms` interface to `ModelsRequestTransforms` because its header transformation now applies to all authenticated provider requests.
- Required dynamic model providers to accept a concrete `RefreshModelsContext.signal`; `Models.refresh()` remains unbounded when callers omit its optional signal.
- Required provider login, API-key check/resolution, and OAuth refresh implementations to accept a concrete abort signal; public auth and credential operations remain unbounded when callers omit their optional signal.
- Replaced raw `RefreshModelsContext.store` access with the read-only `context.stored` snapshot and generation-checked `context.publish()` transaction.

  **`createProvider({ fetchModels })`:** no catalog-publication migration is required. Before and after, return the fetched list; `createProvider()` restores stored models and publishes and persists refreshed models itself. `signal` is now guaranteed to be present.

  ```ts
  // Before
  const beforeProvider = createProvider({
    // ...
    fetchModels: async ({ signal }) => {
      const response = await fetch(catalogUrl, { signal });
      return parseModels(await response.json());
    },
  });

  // After: unchanged
  const afterProvider = createProvider({
    // ...
    fetchModels: async ({ signal }) => {
      const response = await fetch(catalogUrl, { signal });
      return parseModels(await response.json());
    },
  });
  ```

  **Handwritten `Provider.refreshModels()`:** replace direct store access and pre-publication mutation with generation-guarded publications.

  ```ts
  // Before
  refreshModels: async (context) => {
    const stored = await context.store.read();
    if (stored) currentModels = stored.models;
    if (!context.allowNetwork) return;

    const refreshed = await fetchModels(context.signal);
    currentModels = refreshed;
    await context.store.write({ models: refreshed, checkedAt: Date.now() });
  },

  // After
  refreshModels: async (context) => {
    if (context.stored) {
      const restored = context.stored.models;
      if (!(await context.publish({
        update: () => { currentModels = restored; },
      }))) return;
    }
    if (!context.allowNetwork) return;

    const refreshed = await fetchModels(context.signal);
    if (context.signal.aborted) return;
    await context.publish({
      persist: { models: refreshed, checkedAt: Date.now() },
      update: () => { currentModels = refreshed; },
    });
  },
  ```

  In `publish()`, omit `persist` to leave storage unchanged, pass a `ModelsStoreEntry` to write it, or pass `persist: null` to delete it. Omit `update` for metadata-only persistence; omit `persist` for an ephemeral in-memory publication.

### Added

- Added optional `OAuthAuth.isSubscription` metadata for distinguishing subscription-backed authentication from generic OAuth sign-in.
- Added explicit `TelemetryContext` propagation across stream, deferred, and image request options using the vendor-neutral `@earendil-works/pi-telemetry` contract.
- Added deferred provider request contracts, durable response handles, authenticated fetch/cancel dispatch, and faux-provider support for pending, ready, failed, and cancelled responses ([#7339](https://github.com/earendil-works/pi/pull/7339) by [@davidbrai](https://github.com/davidbrai)).
- Added Baseten as a built-in OpenAI-compatible provider with models.dev catalog generation and native `chat_template_args` reasoning controls.
- Added arbitrary OpenAI-compatible sampling parameters through `Model.samplingParams` and `StreamOptions.samplingParams`, including per-request overrides ([#7568](https://github.com/earendil-works/pi/pull/7568) by [@mrexodia](https://github.com/mrexodia)).
- Added opt-in vLLM `thinking_token_budget` support for OpenAI-compatible models, reserving output tokens for the final answer ([#7638](https://github.com/earendil-works/pi/pull/7638) by [@bnsd55](https://github.com/bnsd55)).
- Added `OpenAICompletionsCompat.supportsFinishReason` for providers that omit streamed `finish_reason` values, inferring normal and tool-use stops when the stream ends.
- Added structured Amazon Bedrock failure diagnostics with HTTP status, modeled error code, and AWS request id when available ([#7286](https://github.com/earendil-works/pi/pull/7286) by [@brianstanley](https://github.com/brianstanley)).

### Changed

- Added optional cancellation to `ModelsStore` reads, writes, and deletions; catalog orchestration binds these waits to the provider refresh signal.

### Fixed

- Fixed GitHub Copilot Grok 4.5 requests to use the supported Responses API ([#7560](https://github.com/earendil-works/pi/issues/7560)).
- Bounded OAuth token refreshes so stalled requests release the credential-store lock ([#7508](https://github.com/earendil-works/pi/issues/7508)).
- Fixed tool argument validation to preserve values that alr
[preview truncated; inspect artifact]