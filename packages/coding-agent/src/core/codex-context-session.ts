import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { type UserMessage, uuidv7 } from "@earendil-works/pi-ai";
import type {
	OpenAICodexContextIdentity,
	OpenAICodexContextModel,
} from "@earendil-works/pi-ai/api/openai-codex-context";
import { Type } from "typebox";
import type { ConfiguredCompactionStrategy } from "../riemann/compaction-strategy.ts";
import { assignCodexContextIds } from "./codex-context-item-ids.ts";
import { CODEX_CONTEXT_STATE, type CodexContextWindow, isCodexContextWindow } from "./codex-context-state.ts";

export { CODEX_CONTEXT_STATE, type CodexContextWindow } from "./codex-context-state.ts";

import { estimateCodexContextTokens } from "./codex-context-token-estimate.ts";
import type { SessionManager } from "./session-manager.ts";

/** Shared installation identity is separate from session/thread/window identities. */
export function getCodexInstallationId(agentDir: string): string {
	const path = join(agentDir, "codex-context-installation-id");
	mkdirSync(agentDir, { recursive: true });
	try {
		writeFileSync(path, uuidv7(), { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	const id = readFileSync(path, "utf8").trim();
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
		throw new Error("Invalid Codex context installation identity");
	return id;
}

export interface CodexContextHost {
	agentName: string;
	sharedSessionId: string;
	compactionStrategy?: () => Promise<ConfiguredCompactionStrategy>;
	parentThreadId?: string;
	parentTurnId?: string;
	rootTurnId?: string;
	/** Called only when generating full initial context for a fresh window. */
	initialContext: () => Promise<{ systemPrompt?: string; messages: AgentMessage[] }>;
}

const hosts = new Map<string, CodexContextHost>();
const activeSessions = new Set<string>();
const identities = new Map<string, OpenAICodexContextIdentity>();
export function getCodexContextIdentity(threadId: string): Readonly<OpenAICodexContextIdentity> | undefined {
	return identities.get(threadId);
}
export function setCodexContextIdentity(identity: OpenAICodexContextIdentity): void {
	identities.set(identity.thread_id, identity);
}
export function isCodexContextActive(sessionId: string): boolean {
	return activeSessions.has(sessionId);
}
export function setCodexContextActive(sessionId: string, active: boolean): void {
	if (active) activeSessions.add(sessionId);
	else {
		activeSessions.delete(sessionId);
		identities.delete(sessionId);
	}
}
export function registerCodexContextHost(sessionId: string, host: CodexContextHost): () => void {
	hosts.set(sessionId, host);
	return () => {
		if (hosts.get(sessionId) === host) hosts.delete(sessionId);
	};
}
export function getCodexContextHost(sessionId: string): CodexContextHost | undefined {
	return hosts.get(sessionId);
}

export interface CodexTokenBudget {
	contextWindow?: number;
	tokenLimit?: number;
	scope?: "total" | "body_after_prefix";
	reminderThresholdTokens?: number;
	reminderMessageTemplate?: string;
	guidanceMessage?: string;
	fallbackPrompt?: string;
	fallbackBufferTokens?: number;
}

/** Model-owned defaults: scoped budget is based on raw context, independently of hard-cap headroom. */
export function resolveCodexContextBudget(model: OpenAICodexContextModel, fallbackWindow: number): CodexTokenBudget {
	const raw = model.context_window ?? model.max_context_window ?? fallbackWindow;
	const defaults = model.model_messages?.token_budget;
	return {
		contextWindow: raw > 0 ? Math.floor((raw * (model.effective_context_window_percent ?? 95)) / 100) : undefined,
		tokenLimit:
			raw > 0
				? Math.min(model.auto_compact_token_limit ?? Infinity, Math.floor(raw * 0.9))
				: model.auto_compact_token_limit,
		reminderThresholdTokens: defaults?.reminder_threshold_tokens,
		reminderMessageTemplate: defaults?.reminder_message_template,
		guidanceMessage: defaults?.guidance_message,
		fallbackPrompt: defaults?.auto_compact_fallback_prompt,
		fallbackBufferTokens: defaults?.auto_compact_fallback_buffer_tokens,
	};
}

/** Provider adapter. Only tool definitions/results, never encrypted transport, enter the public transcript. */
export interface CodexContextBackend {
	threadHint?: (window: Readonly<CodexContextWindow>, signal?: AbortSignal) => Promise<string | undefined>;
}

export interface CodexContextSessionOptions {
	sessionManager: SessionManager;
	agentName: string;
	/** Existing active history is retained on first activation, never silently discarded. */
	messages: AgentMessage[];
	installationId?: string;
	backend: CodexContextBackend;
	budget: CodexTokenBudget;
	/** Rebuild host/environment state; never include the old conversation or a generated summary. */
	initialContext: () => Promise<AgentMessage[]>;
}

/** Session-local context windows. The host calls advance only at a completed tool-batch boundary. */
export class CodexContextSession {
	private readonly options: CodexContextSessionOptions;
	private window: CodexContextWindow;
	private resetRequested = false;
	private reminderDelivered = false;
	private fallbackDelivered = false;
	private prefill?: number;
	private serverPrefill = false;
	private guidanceUpdate?: string;
	private boundaryId: string;

	private constructor(options: CodexContextSessionOptions, window: CodexContextWindow, boundaryId: string) {
		this.options = options;
		this.window = window;
		this.boundaryId = boundaryId;
	}

	static async create(options: CodexContextSessionOptions): Promise<CodexContextSession> {
		const manager = options.sessionManager;
		const branch = manager.getBranch();
		const previous = [...branch]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === CODEX_CONTEXT_STATE);
		if (previous?.type === "custom" && isCodexContextWindow(previous.data)) {
			// Forks retain history/window lineage, but must not share history-ingest identity with their parent.
			if (previous.data.sessionId === manager.getSessionId()) {
				const session = new CodexContextSession(options, previous.data, previous.id);
				const budgetEntry = [...branch]
					.reverse()
					.find((entry) => entry.type === "custom" && entry.customType === "codex-context-budget");
				if (budgetEntry?.type === "custom" && budgetEntry.data && typeof budgetEntry.data === "object") {
					const state = budgetEntry.data as Record<string, unknown>;
					if (state.windowId === previous.data.windowId) {
						session.reminderDelivered = state.reminderDelivered === true;
						session.fallbackDelivered = state.fallbackDelivered === true;
						if (typeof state.prefill === "number" && Number.isFinite(state.prefill) && state.prefill >= 0)
							session.prefill = state.prefill;
						session.serverPrefill = state.serverPrefill === true;
						if (state.guidanceMessage !== options.budget.guidanceMessage)
							session.guidanceUpdate = options.budget.guidanceMessage ?? "";
					}
				}
				return session;
			}
			const hasLaterCompaction = branch
				.slice(branch.indexOf(previous) + 1)
				.some((entry) => entry.type === "compaction");
			const inherited = manager.buildSessionContext().messages;
			const child = options.agentName !== "/root";
			const initial = child ? await options.initialContext() : [];
			const id = uuidv7();
			const forked: CodexContextWindow = {
				...previous.data,
				sessionId: manager.getSessionId(),
				forkedFromThreadId: previous.data.sessionId,
				...(child ? { firstWindowId: id, windowId: id, previousWindowId: undefined, windowNumber: 0 } : {}),
				initialContextLength: child ? initial.length + 1 : previous.data.initialContextLength,
				initialMessages: child
					? [...initial, ...inherited.slice(hasLaterCompaction ? 0 : (previous.data.initialContextLength ?? 1))]
					: inherited,
			};
			forked.threadHint = await options.backend.threadHint?.(forked);
			const session = new CodexContextSession(options, forked, "");
			if (child) forked.initialMessages.unshift(session.guidance());
			assignCodexContextIds(forked.initialMessages);
			session.boundaryId = manager.appendCustomEntry(CODEX_CONTEXT_STATE, forked);
			return session;
		}
		const id = uuidv7();
		const initial = await options.initialContext();
		const window: CodexContextWindow = {
			version: 1,
			sessionId: manager.getSessionId(),
			firstWindowId: id,
			windowId: id,
			windowNumber: 0,
			installationId: options.installationId ?? uuidv7(),
			initialMessages: [...initial, ...options.messages],
			initialContextLength: initial.length + 1,
		};
		window.threadHint = await options.backend.threadHint?.(window);
		const session = new CodexContextSession(options, window, "");
		window.initialMessages.unshift(session.guidance());
		assignCodexContextIds(window.initialMessages);
		session.boundaryId = manager.appendCustomEntry(CODEX_CONTEXT_STATE, window);
		return session;
	}

	get state(): Readonly<CodexContextWindow> {
		return this.window;
	}
	get pendingReset(): boolean {
		return this.resetRequested;
	}

	/** Restore only the active window, including its original host prefix and post-boundary messages. */
	restoreMessages(): AgentMessage[] {
		const branch = this.options.sessionManager.getBranch();
		const index = branch.findIndex((entry) => entry.id === this.boundaryId);
		if (index < 0) throw new Error("Codex context window boundary is not on the active branch");
		return this.options.sessionManager.buildSessionContext().messages;
	}

	cancelReset(): void {
		this.resetRequested = false;
	}

	requestReset(): void {
		this.resetRequested = true;
	}

	private persistBudget(): void {
		this.options.sessionManager.appendCustomEntry("codex-context-budget", {
			windowId: this.window.windowId,
			reminderDelivered: this.reminderDelivered,
			fallbackDelivered: this.fallbackDelivered,
			prefill: this.prefill,
			serverPrefill: this.serverPrefill,
			guidanceMessage: this.options.budget.guidanceMessage,
		});
	}

	updateBudget(budget: CodexTokenBudget): void {
		if (budget.guidanceMessage !== this.options.budget.guidanceMessage)
			this.guidanceUpdate = budget.guidanceMessage ?? "";
		this.options.budget = budget;
	}

	observeInputTokens(tokens: number): void {
		if (!this.serverPrefill && Number.isFinite(tokens) && tokens > 0) {
			this.prefill = tokens;
			this.serverPrefill = true;
			this.persistBudget();
		}
	}

	remaining(messages: AgentMessage[]): number | null {
		const tokens = estimateCodexContextTokens(messages).tokens;
		this.prefill ??= tokens;
		const budget = this.options.budget;
		const scoped = budget.scope === "body_after_prefix" ? Math.max(0, tokens - this.prefill) : tokens;
		const remainders = [
			budget.tokenLimit === undefined ? undefined : budget.tokenLimit - scoped,
			budget.contextWindow === undefined ? undefined : budget.contextWindow - tokens,
		].filter((value): value is number => value !== undefined);
		return remainders.length ? Math.max(0, Math.min(...remainders)) : null;
	}

	/** Returns model-only budget reminders once per window; capacity always wins over fallback grace. */
	prepare(messages: AgentMessage[]): UserMessage[] {
		const tokens = estimateCodexContextTokens(messages).tokens;
		const remaining = this.remaining(messages);
		const budget = this.options.budget;
		const scoped = budget.scope === "body_after_prefix" ? Math.max(0, tokens - (this.prefill ?? tokens)) : tokens;
		const buffer = budget.fallbackPrompt ? (budget.fallbackBufferTokens ?? 0) : 0;
		if (
			(budget.contextWindow !== undefined && tokens >= budget.contextWindow) ||
			(budget.tokenLimit !== undefined && scoped >= budget.tokenLimit + buffer)
		)
			this.requestReset();
		const additions: UserMessage[] = [];
		if (this.guidanceUpdate !== undefined) {
			additions.push(
				this.modelMessage(`<context_window_guidance>\n${this.guidanceUpdate}\n</context_window_guidance>`),
			);
			this.guidanceUpdate = undefined;
		}
		if (
			!this.reminderDelivered &&
			budget.reminderThresholdTokens !== undefined &&
			remaining !== null &&
			remaining <= budget.reminderThresholdTokens
		) {
			this.reminderDelivered = true;
			if (budget.reminderMessageTemplate)
				additions.push(
					this.modelMessage(budget.reminderMessageTemplate.replaceAll("{n_remaining}", String(remaining))),
				);
		}
		if (!this.fallbackDelivered && remaining === 0 && budget.fallbackPrompt && !this.pendingReset) {
			this.fallbackDelivered = true;
			additions.push(this.modelMessage(budget.fallbackPrompt));
		}
		if (additions.length > 0) this.persistBudget();
		return additions;
	}

	private modelMessage(text: string): UserMessage {
		return {
			role: "user",
			content: [],
			timestamp: Date.now(),
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }],
			},
		};
	}

	guidance(): AgentMessage {
		return this.modelMessage(
			[
				"<context_window>",
				`Agent name: ${this.options.agentName}`,
				`First context window id: ${this.window.firstWindowId}`,
				`Current context window id: ${this.window.windowId}`,
				...(this.window.previousWindowId ? [`Previous context window id: ${this.window.previousWindowId}`] : []),
				this.window.threadHint ?? "",
				"</context_window>",
				this.options.budget.guidanceMessage
					? `<context_window_guidance>\n${this.options.budget.guidanceMessage}\n</context_window_guidance>`
					: "",
			]
				.filter(Boolean)
				.join("\n"),
		);
	}

	tools(getMessages: () => AgentMessage[]): AgentTool[] {
		return [
			{
				name: "new_context",
				label: "New context",
				description:
					"Start a new context window without summarizing conversation history. Does not reset environment state.",
				parameters: Type.Object({}, { additionalProperties: false }),
				execute: async () => {
					this.requestReset();
					return {
						content: [
							{
								type: "text",
								text: "A new context window will start without summarizing conversation history.",
							},
						],
						details: undefined,
					};
				},
			},
			{
				name: "get_context_remaining",
				label: "Context remaining",
				description: "Get the remaining tokens in the current context window.",
				parameters: Type.Object({}, { additionalProperties: false }),
				execute: async () => ({
					content: [
						{
							type: "text",
							text: `You have ${this.remaining(getMessages()) ?? "unknown"} tokens left in this context window.`,
						},
					],
					details: undefined,
				}),
			},
		];
	}

	async advance(
		messages: AgentMessage[],
		signal?: AbortSignal,
		incoming: readonly AgentMessage[] = [],
	): Promise<AgentMessage[]> {
		if (!this.pendingReset) return messages;
		signal?.throwIfAborted();
		const initial = await this.options.initialContext();
		const initialMessages = [...initial, ...incoming];
		signal?.throwIfAborted();
		const next: CodexContextWindow = {
			...this.window,
			sessionId: this.options.sessionManager.getSessionId(),
			previousWindowId: this.window.windowId,
			windowId: uuidv7(),
			windowNumber: this.window.windowNumber + 1,
			initialMessages,
			initialContextLength: initial.length + 1,
		};
		next.threadHint = await this.options.backend.threadHint?.(next, signal);
		const previous = this.window;
		this.window = next;
		next.initialMessages.unshift(this.guidance());
		this.window = previous;
		// Persist before clearing memory. A failed write must not discard the active conversation.
		assignCodexContextIds(next.initialMessages);
		this.boundaryId = this.options.sessionManager.appendCustomEntry(CODEX_CONTEXT_STATE, next);
		this.window = next;
		this.resetRequested = false;
		this.reminderDelivered = false;
		this.fallbackDelivered = false;
		this.prefill = undefined;
		this.serverPrefill = false;
		return [...initialMessages];
	}
}
