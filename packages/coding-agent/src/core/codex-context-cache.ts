import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	discoverOpenAICodexContext,
	type OpenAICodexContextOptions,
} from "@earendil-works/pi-ai/api/openai-codex-context";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { raceWithAbortSignal } from "../utils/abort.ts";

type Discovery = Awaited<ReturnType<typeof discoverOpenAICodexContext>>;
const positive = Type.Integer({ minimum: 1 });
const nonnegative = Type.Integer({ minimum: 0 });
const CacheSchema = Type.Object({
	version: Type.Literal(1),
	fetchedAt: nonnegative,
	result: Type.Object({
		eligible: Type.Boolean(),
		planType: Type.Optional(Type.String()),
		model: Type.Optional(
			Type.Object({
				slug: Type.String(),
				supports_experimental_context: Type.Boolean(),
				context_window: Type.Optional(positive),
				max_context_window: Type.Optional(positive),
				comp_hash: Type.Optional(Type.String()),
				auto_compact_token_limit: Type.Optional(positive),
				effective_context_window_percent: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
				truncation_policy: Type.Object({
					mode: Type.Union([Type.Literal("bytes"), Type.Literal("tokens")]),
					limit: nonnegative,
				}),
				model_messages: Type.Optional(
					Type.Object({
						token_budget: Type.Optional(
							Type.Object({
								enabled: Type.Optional(Type.Boolean()),
								use_history_notes_extension: Type.Optional(Type.Boolean()),
								reminder_threshold_tokens: nonnegative,
								reminder_message_template: Type.String(),
								guidance_message: Type.String(),
								auto_compact_fallback_prompt: Type.String(),
								auto_compact_fallback_buffer_tokens: nonnegative,
							}),
						),
					}),
				),
			}),
		),
	}),
});

/** Account identity survives access-token refresh. Credentials never enter the cache file. */
export function codexContextCacheKey(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexContextOptions,
): string {
	let identity = options.apiKey ?? "";
	try {
		const payload: unknown = JSON.parse(Buffer.from(identity.split(".")[1], "base64url").toString());
		if (payload && typeof payload === "object" && "https://api.openai.com/auth" in payload) {
			const claims = payload["https://api.openai.com/auth"];
			if (
				claims &&
				typeof claims === "object" &&
				"chatgpt_account_id" in claims &&
				typeof claims.chatgpt_account_id === "string"
			) {
				identity = JSON.stringify([
					claims.chatgpt_account_id,
					"chatgpt_plan_type" in claims ? claims.chatgpt_plan_type : null,
				]);
			}
		}
	} catch {
		/* Invalid credentials are rejected by authenticated discovery. */
	}
	return createHash("sha256")
		.update(JSON.stringify([1, model.baseUrl, model.id, options.clientVersion ?? "0.0.0", identity]))
		.digest("hex");
}

/** Shared by root and child sessions. A failed attempt is cooled down instead of retried by every preflight. */
export class CodexContextCache {
	private readonly directory: string;
	private readonly entries = new Map<string, { result: Discovery; fetchedAt: number }>();
	private readonly pending = new Map<string, Promise<Discovery>>();
	private readonly failures = new Map<string, { error: unknown; retryAt: number }>();
	private readonly loaded = new Map<string, Promise<void>>();

	constructor(agentDir: string) {
		this.directory = join(agentDir, "cache", "codex-context");
	}

	async get(model: Model<"openai-codex-responses">, options: OpenAICodexContextOptions): Promise<Discovery> {
		options.signal?.throwIfAborted();
		const key = codexContextCacheKey(model, options);
		const path = join(this.directory, `${key}.json`);
		if (!this.loaded.has(key)) {
			this.loaded.set(
				key,
				(async () => {
					try {
						const saved: unknown = JSON.parse(await readFile(path, "utf8"));
						if (Check(CacheSchema, saved) && (!saved.result.model || saved.result.model.slug === model.id))
							this.entries.set(key, saved);
					} catch {
						/* Missing or damaged cache is replaced by discovery. */
					}
				})(),
			);
		}
		await raceWithAbortSignal(this.loaded.get(key)!, options.signal);
		options.signal?.throwIfAborted();
		const cached = this.entries.get(key);
		const failure = this.failures.get(key);
		if (cached && Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000) return cached.result;
		if (failure && Date.now() < failure.retryAt) {
			if (cached) return cached.result;
			throw failure.error;
		}
		let request = this.pending.get(key);
		if (!request) {
			// One bounded request can serve several callers; aborting one waiter must not cancel the others.
			request = (async () => {
				try {
					const result = await discoverOpenAICodexContext(model, {
						...options,
						signal: undefined,
						timeoutMs: 15_000,
					});
					const entry = { version: 1 as const, fetchedAt: Date.now(), result };
					this.entries.set(key, entry);
					this.failures.delete(key);
					const temporary = `${path}.${randomUUID()}.tmp`;
					try {
						await mkdir(this.directory, { recursive: true, mode: 0o700 });
						await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
						await rename(temporary, path);
					} catch {
						/* An unwritable cache must not prevent the current request. */
					} finally {
						await rm(temporary, { force: true }).catch(() => {});
					}
					return result;
				} catch (error) {
					this.failures.set(key, { error, retryAt: Date.now() + 60_000 });
					throw error;
				} finally {
					this.pending.delete(key);
				}
			})();
			this.pending.set(key, request);
		}
		if (cached) {
			void request.catch(() => {});
			return cached.result;
		}
		return raceWithAbortSignal(request, options.signal);
	}
}

const caches = new Map<string, CodexContextCache>();
export function getCodexContextCache(agentDir: string): CodexContextCache {
	let cache = caches.get(agentDir);
	if (!cache) {
		cache = new CodexContextCache(agentDir);
		caches.set(agentDir, cache);
	}
	return cache;
}
