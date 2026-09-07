import type { Api, Message, Model, ProviderRequestOptions, ToolCall, ToolResultMessage } from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { uuidv7 } from "../utils/uuid.ts";
import { openAICodexContextTools } from "./openai-codex-context-tools.ts";

export { openAICodexContextTools } from "./openai-codex-context-tools.ts";

export interface OpenAICodexContextIdentity {
	installation_id: string;
	session_id: string;
	thread_id: string;
	agent_name: string;
	turn_id: string;
	window_id: string;
	context_window_id: string;
	window_number: number;
	turn_started_at_unix_ms?: number;
	parent_thread_id?: string;
	parent_turn_id?: string;
	root_turn_id?: string;
	forked_from_thread_id?: string;
	forked_from_ordinal_exclusive?: number;
}

export interface OpenAICodexTruncationPolicy {
	mode: "bytes" | "tokens";
	limit: number;
}

export interface OpenAICodexTokenBudget {
	enabled?: boolean;
	use_history_notes_extension?: boolean;
	reminder_threshold_tokens: number;
	reminder_message_template: string;
	guidance_message: string;
	auto_compact_fallback_prompt: string;
	auto_compact_fallback_buffer_tokens: number;
}

export interface OpenAICodexContextModel {
	slug: string;
	supports_experimental_context: boolean;
	context_window?: number;
	max_context_window?: number;
	comp_hash?: string;
	auto_compact_token_limit?: number;
	effective_context_window_percent?: number;
	truncation_policy: OpenAICodexTruncationPolicy;
	model_messages?: { token_budget?: OpenAICodexTokenBudget };
}

export interface OpenAICodexContextOptions extends ProviderRequestOptions {
	/** Sent to the authenticated models endpoint, not a local supported-model list. */
	clientVersion?: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function authClaims(token: string): Record<string, unknown> {
	try {
		const payload: unknown = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
		if (record(payload) && record(payload["https://api.openai.com/auth"]))
			return payload["https://api.openai.com/auth"];
	} catch {}
	throw new Error("Codex context requires a ChatGPT OAuth access token");
}

/** Experimental state is only supported by the first-party ChatGPT backend. */
export function supportsOpenAICodexContextBackend(model: Model<Api>): boolean {
	if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") return false;
	try {
		const url = new URL(model.baseUrl || "https://chatgpt.com/backend-api");
		return (
			url.origin === "https://chatgpt.com" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			["/backend-api", "/backend-api/codex", "/backend-api/codex/responses"].includes(
				url.pathname.replace(/\/+$/, ""),
			)
		);
	} catch {
		return false;
	}
}

/** Assign once before persisting messages. Existing server IDs remain opaque and unchanged. */
export function assignOpenAICodexContextItemIds(messages: readonly Message[], turnId?: string): void {
	for (const message of messages) {
		if (turnId)
			message.openaiCodexMetadata = {
				turn_id: turnId,
				create_time: message.timestamp / 1000,
				...message.openaiCodexMetadata,
			};
		if (message.role === "user") {
			message.openaiCodexItemId ||= `msg_${uuidv7()}`;
			if (message.providerPayload?.type === "openaiResponsesHistory") {
				for (const item of message.providerPayload.items) {
					if (turnId)
						item.internal_chat_message_metadata_passthrough = {
							turn_id: turnId,
							create_time: message.timestamp / 1000,
							...(record(item.internal_chat_message_metadata_passthrough)
								? item.internal_chat_message_metadata_passthrough
								: {}),
						};
					if (typeof item.id === "string" && item.id) continue;
					const prefixes: Record<string, string> = {
						message: "msg",
						agent_message: "amsg",
						reasoning: "rs",
						function_call: "fc",
						function_call_output: "fco",
						custom_tool_call: "ctc",
						custom_tool_call_output: "ctco",
						tool_search_call: "tsc",
						tool_search_output: "tso",
						additional_tools: "at",
						compaction: "cmp",
						context_compaction: "cmp",
						local_shell_call: "lsh",
						web_search_call: "ws",
						image_generation_call: "ig",
					};
					const prefix = prefixes[typeof item.type === "string" ? item.type : "message"];
					if (prefix) item.id = `${prefix}_${uuidv7()}`;
				}
			}
		} else if (message.role === "toolResult") {
			message.openaiCodexItemId ||= `fco_${uuidv7()}`;
		} else {
			for (const block of message.content) {
				if (block.type === "text" && !block.textSignature)
					block.textSignature = JSON.stringify({ v: 1, id: `msg_${uuidv7()}` });
			}
		}
	}
}

function backendUrl(baseUrl: string, path: string): string {
	const base = (baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "").replace(/\/responses$/, "");
	return `${base.endsWith("/codex") ? base : `${base}/codex`}/${path}`;
}

async function request(
	model: Model<"openai-codex-responses">,
	path: string,
	options: OpenAICodexContextOptions,
	body?: Record<string, unknown>,
	extraHeaders?: Record<string, string>,
): Promise<unknown> {
	if (!supportsOpenAICodexContextBackend(model) || !options.apiKey)
		throw new Error("Codex context requires ChatGPT OAuth authentication");
	const claims = authClaims(options.apiKey);
	if (typeof claims.chatgpt_account_id !== "string") throw new Error("Missing ChatGPT account identity");
	const headers = new Headers(model.headers);
	for (const [key, value] of Object.entries(options.headers ?? {})) {
		if (value === null) headers.delete(key);
		else headers.set(key, value);
	}
	headers.set("authorization", `Bearer ${options.apiKey}`);
	headers.set("chatgpt-account-id", claims.chatgpt_account_id);
	headers.set("originator", "pi");
	headers.set("user-agent", getPiUserAgent());
	headers.set("accept", "application/json");
	if (body) headers.set("content-type", "application/json");
	for (const [key, value] of Object.entries(extraHeaders ?? {})) headers.set(key, value);
	const signal = combineAbortSignals([options.signal, AbortSignal.timeout(options.timeoutMs ?? 35_000)]);
	try {
		const response = await (options.fetch ?? globalThis.fetch)(backendUrl(model.baseUrl, path), {
			method: body ? "POST" : "GET",
			headers,
			body: body ? JSON.stringify(body) : undefined,
			signal: signal.signal,
		});
		await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
		// Do not expose backend private state in errors or retry mutating note operations.
		if (!response.ok)
			throw new Error(`Unable to perform operation: The backend request failed (HTTP ${response.status}).`);
		try {
			return await response.json();
		} catch {
			throw new Error("Unable to perform operation: The backend returned invalid JSON.");
		}
	} catch (error) {
		if (
			signal.signal?.aborted ||
			(error instanceof Error && error.message.startsWith("Unable to perform operation:"))
		)
			throw error;
		throw new Error("Unable to perform operation: The backend request failed.");
	} finally {
		signal.cleanup();
	}
}

/** Authenticated discovery. Unknown models and subscription plans fail closed. */
export async function discoverOpenAICodexContext(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexContextOptions,
): Promise<{ eligible: boolean; planType?: string; model?: OpenAICodexContextModel }> {
	if (!supportsOpenAICodexContextBackend(model) || !options.apiKey) return { eligible: false };
	const claims = authClaims(options.apiKey);
	const planType = typeof claims.chatgpt_plan_type === "string" ? claims.chatgpt_plan_type : undefined;
	const result = await request(
		model,
		`models?client_version=${encodeURIComponent(options.clientVersion ?? "0.0.0")}`,
		options,
	);
	if (!record(result) || !Array.isArray(result.models)) throw new Error("Invalid Codex models response");
	const found: unknown = result.models.find((item: unknown) => record(item) && item.slug === model.id);
	if (!record(found)) return { eligible: false, planType };
	for (const key of [
		"context_window",
		"max_context_window",
		"auto_compact_token_limit",
		"effective_context_window_percent",
	]) {
		const value = found[key];
		if (
			value !== undefined &&
			value !== null &&
			(typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value <= 0 ||
				(key === "effective_context_window_percent" && value > 100))
		)
			throw new Error(`Invalid Codex model ${key}`);
	}
	if (found.comp_hash !== undefined && found.comp_hash !== null && typeof found.comp_hash !== "string")
		throw new Error("Invalid Codex model compaction hash");
	const policy = found.truncation_policy;
	if (
		!record(policy) ||
		!["bytes", "tokens"].includes(String(policy.mode)) ||
		typeof policy.limit !== "number" ||
		!Number.isSafeInteger(policy.limit) ||
		policy.limit < 0
	) {
		throw new Error("Invalid Codex model truncation policy");
	}
	let tokenBudget: OpenAICodexTokenBudget | undefined;
	if (found.model_messages !== undefined && found.model_messages !== null && !record(found.model_messages))
		throw new Error("Invalid Codex model messages");
	if (
		record(found.model_messages) &&
		found.model_messages.token_budget !== undefined &&
		found.model_messages.token_budget !== null
	) {
		const budget = found.model_messages.token_budget;
		if (
			!record(budget) ||
			typeof budget.reminder_message_template !== "string" ||
			typeof budget.guidance_message !== "string" ||
			typeof budget.auto_compact_fallback_prompt !== "string" ||
			typeof budget.reminder_threshold_tokens !== "number" ||
			typeof budget.auto_compact_fallback_buffer_tokens !== "number" ||
			!Number.isSafeInteger(budget.reminder_threshold_tokens) ||
			budget.reminder_threshold_tokens < 0 ||
			!Number.isSafeInteger(budget.auto_compact_fallback_buffer_tokens) ||
			budget.auto_compact_fallback_buffer_tokens < 0 ||
			(budget.enabled !== undefined && typeof budget.enabled !== "boolean") ||
			(budget.use_history_notes_extension !== undefined && typeof budget.use_history_notes_extension !== "boolean")
		)
			throw new Error("Invalid Codex model token budget");
		tokenBudget = {
			enabled: budget.enabled === true,
			use_history_notes_extension: budget.use_history_notes_extension === true,
			reminder_threshold_tokens: budget.reminder_threshold_tokens,
			reminder_message_template: budget.reminder_message_template,
			guidance_message: budget.guidance_message,
			auto_compact_fallback_prompt: budget.auto_compact_fallback_prompt,
			auto_compact_fallback_buffer_tokens: budget.auto_compact_fallback_buffer_tokens,
		};
	}
	return {
		eligible: found.supports_experimental_context === true && ["plus", "pro", "prolite"].includes(planType ?? ""),
		planType,
		model: {
			slug: model.id,
			supports_experimental_context: found.supports_experimental_context === true,
			truncation_policy: { mode: policy.mode === "bytes" ? "bytes" : "tokens", limit: policy.limit },
			context_window: typeof found.context_window === "number" ? found.context_window : undefined,
			max_context_window: typeof found.max_context_window === "number" ? found.max_context_window : undefined,
			auto_compact_token_limit:
				typeof found.auto_compact_token_limit === "number" ? found.auto_compact_token_limit : undefined,
			comp_hash: typeof found.comp_hash === "string" ? found.comp_hash : undefined,
			effective_context_window_percent:
				typeof found.effective_context_window_percent === "number" ? found.effective_context_window_percent : 95,
			...(tokenBudget ? { model_messages: { token_budget: tokenBudget } } : {}),
		},
	};
}

/** Options.metadata.openaiCodexContext opts a request into native history ingestion and tools. */
export function getOpenAICodexContextIdentity(
	metadata: Record<string, unknown> | undefined,
): OpenAICodexContextIdentity | undefined {
	const value = metadata?.openaiCodexContext;
	if (value === undefined) return undefined;
	if (
		!record(value) ||
		!["installation_id", "session_id", "thread_id", "agent_name", "turn_id", "window_id", "context_window_id"].every(
			(key) => typeof value[key] === "string" && value[key].length > 0,
		) ||
		!Number.isSafeInteger(value.window_number) ||
		Number(value.window_number) < 0
	) {
		throw new Error("Invalid Codex context identity");
	}
	return value as unknown as OpenAICodexContextIdentity;
}

export function openAICodexContextMetadata(identity: OpenAICodexContextIdentity): {
	clientMetadata: Record<string, string>;
	headers: Record<string, string>;
} {
	const payload = { ...identity, request_kind: "turn", history_ingest_requested: true };
	// HTTP header values must be ASCII; JSON escapes preserve Unicode agent names exactly.
	const serialized = JSON.stringify(payload).replace(
		/[\u007f-\uffff]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	const clientMetadata: Record<string, string> = {
		"x-codex-installation-id": identity.installation_id,
		session_id: identity.session_id,
		thread_id: identity.thread_id,
		turn_id: identity.turn_id,
		"x-codex-window-id": identity.window_id,
		"x-codex-turn-metadata": serialized,
	};
	const headers: Record<string, string> = {
		"x-codex-window-id": identity.window_id,
		"x-codex-turn-metadata": serialized,
	};
	if (identity.parent_thread_id) {
		headers["x-codex-parent-thread-id"] = identity.parent_thread_id;
		clientMetadata["x-codex-parent-thread-id"] = identity.parent_thread_id;
	}
	if (identity.parent_turn_id) clientMetadata.parent_turn_id = identity.parent_turn_id;
	if (identity.root_turn_id) clientMetadata.root_turn_id = identity.root_turn_id;
	return { clientMetadata, headers };
}

export function isOpenAICodexContextTool(call: Pick<ToolCall, "name" | "namespace">): boolean {
	return openAICodexContextTools.some(
		(namespace) =>
			namespace.type === "namespace" &&
			namespace.name === call.namespace &&
			namespace.tools.some((tool) => tool.name === call.name),
	);
}

/** Upstream read/search operations may overlap; note mutations must be serialized. */
export function openAICodexContextToolSupportsParallelCalls(call: Pick<ToolCall, "name" | "namespace">): boolean {
	return (
		isOpenAICodexContextTool(call) &&
		!(call.namespace === "notes" && (call.name === "append_to_file" || call.name === "write_file"))
	);
}

async function backendCall(
	model: Model<"openai-codex-responses">,
	path: string,
	argumentsValue: Record<string, unknown>,
	identity: OpenAICodexContextIdentity,
	policy: OpenAICodexTruncationPolicy,
	options: OpenAICodexContextOptions,
): Promise<unknown> {
	if (!Number.isSafeInteger(policy.limit) || policy.limit < 0 || !["bytes", "tokens"].includes(policy.mode))
		throw new Error("Invalid Codex output truncation policy");
	const encrypted = [
		"alpha/history/v2/search_contents",
		"alpha/notes/v2/search_contents",
		"alpha/notes/v2/append_to_file",
		"alpha/notes/v2/write_file",
	].includes(path);
	return request(
		model,
		path,
		options,
		{ ...argumentsValue, context: { session_id: identity.session_id, current_agent_name: identity.agent_name } },
		{
			"x-openai-tool-output-truncation-policy": JSON.stringify(policy),
			...(encrypted ? { "x-openai-encrypted-tool-arguments": "true" } : {}),
		},
	);
}

export async function getOpenAICodexThreadHint(
	model: Model<"openai-codex-responses">,
	identity: OpenAICodexContextIdentity,
	options: OpenAICodexContextOptions,
): Promise<string | undefined> {
	try {
		const result = await backendCall(
			model,
			"alpha/notes/v2/thread_hint",
			{},
			identity,
			{ mode: "bytes", limit: 4000 },
			options,
		);
		if (
			record(result) &&
			typeof result.text === "string" &&
			result.text.length > 0 &&
			new TextEncoder().encode(result.text).length <= 4000
		)
			return result.text;
	} catch {
		/* Upstream treats hints as best effort. */
	}
	return undefined;
}

/** Execute a direct, model-only native tool. Arguments already contain server-encrypted fields. */
export async function executeOpenAICodexContextTool(
	model: Model<"openai-codex-responses">,
	call: ToolCall,
	identity: OpenAICodexContextIdentity,
	policy: OpenAICodexTruncationPolicy,
	options: OpenAICodexContextOptions,
): Promise<ToolResultMessage> {
	if (!isOpenAICodexContextTool(call)) throw new Error("Unknown Codex context tool");
	if (!record(call.arguments)) throw new Error("History tool arguments must be a JSON object");
	const result = await backendCall(
		model,
		`alpha/${call.namespace}/v2/${call.name}`,
		call.arguments,
		identity,
		policy,
		options,
	);
	const value = record(result) ? { ...result } : result;
	const images = record(value) ? value.images : undefined;
	if (record(value)) delete value.images;
	let output: NonNullable<ToolResultMessage["openaiCodexOutput"]> =
		record(value) && typeof value.encrypted_output === "string"
			? [{ type: "encrypted_content", encrypted_content: value.encrypted_output }]
			: JSON.stringify(value);
	if (images !== undefined) {
		if (!Array.isArray(images)) throw new Error("History backend returned invalid image content.");
		if (typeof output === "string") output = [{ type: "input_text", text: output }];
		for (const image of images) {
			if (
				!record(image) ||
				typeof image.data !== "string" ||
				typeof image.mime_type !== "string" ||
				(image.detail !== undefined &&
					image.detail !== null &&
					!["auto", "low", "high", "original"].includes(String(image.detail)))
			)
				throw new Error("History backend returned invalid image content.");
			output.push({
				type: "input_image",
				image_url: `data:${image.mime_type};base64,${image.data}`,
				...(typeof image.detail === "string"
					? { detail: image.detail as "auto" | "low" | "high" | "original" }
					: {}),
			});
		}
	}
	return {
		openaiCodexItemId: `fco_${uuidv7()}`,
		openaiCodexMetadata: { turn_id: identity.turn_id, create_time: Date.now() / 1000 },
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [],
		openaiCodexOutput: output,
		isError: false,
		timestamp: Date.now(),
	};
}
