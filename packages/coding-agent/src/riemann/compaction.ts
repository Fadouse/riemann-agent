import { randomUUID } from "node:crypto";
import { contentText, type Message, type Usage } from "@earendil-works/pi-ai";
import { type CompactionPreparation, type CompactionResult, estimateTokens } from "../core/compaction/index.ts";
import { collectConversationImages, serializeConversation } from "../core/compaction/utils.ts";
import type { ExtensionContext } from "../core/extensions/types.ts";
import { convertToLlm } from "../core/messages.ts";
import { graphemeSafePrefix } from "../utils/text.ts";
import type { JsonValue } from "./kernel/types.ts";
import { loadRiemannPrompt } from "./prompts.ts";
import * as snapshot from "./snapshot-compaction.ts";

const MAX_SERIALIZED_SECTION_CHARS = 12_000;
const SNAPSHOT_NON_MESSAGE_RESERVE_TOKENS = 8_000;

type SemanticCompactionKind = "initial" | "update" | "prefix";

function boundedConversation(messages: CompactionPreparation["messagesToSummarize"]): string {
	return serializeConversation(convertToLlm(messages))
		.split("\n\n")
		.map((section) =>
			section.length <= MAX_SERIALIZED_SECTION_CHARS
				? section
				: `${graphemeSafePrefix(section, MAX_SERIALIZED_SECTION_CHARS)}\n[section truncated for compaction]`,
		)
		.join("\n\n");
}

function tagged(name: string, value: string | undefined): string | undefined {
	if (!value) return undefined;
	return `<${name}>\n${value}\n</${name}>`;
}

function fileOperations(preparation: CompactionPreparation): {
	read: string[];
	written: string[];
	edited: string[];
} {
	return {
		read: [...preparation.fileOps.read].sort(),
		written: [...preparation.fileOps.written].sort(),
		edited: [...preparation.fileOps.edited].sort(),
	};
}

function combineUsage(first: Usage | undefined, second: Usage): Usage {
	if (!first) return second;
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

async function createSemanticSection(options: {
	kind: SemanticCompactionKind;
	includeImages: boolean;
	messages: CompactionPreparation["messagesToSummarize"];
	previousSummary?: string;
	customInstructions?: string;
	fileOperations: ReturnType<typeof fileOperations>;
	preparation: CompactionPreparation;
	signal: AbortSignal;
	context: Pick<ExtensionContext, "model" | "modelRegistry">;
}): Promise<{ text: string; usage: Usage }> {
	const model = options.context.model;
	if (!model) throw new Error("Cannot compact Riemann context without a selected model");
	const request = [
		"<compaction_request>",
		`<kind>${options.kind}</kind>`,
		tagged("conversation", boundedConversation(options.messages)),
		tagged("previous_summary", options.previousSummary),
		tagged("file_operations", JSON.stringify(options.fileOperations)),
		tagged("additional_focus", options.customInstructions),
		"</compaction_request>",
	]
		.filter((section): section is string => section !== undefined)
		.join("\n\n");
	const maxTokens = Math.max(
		1,
		Math.min(
			Math.floor(options.preparation.settings.reserveTokens * (options.kind === "prefix" ? 0.5 : 0.8)),
			model.maxTokens || Number.MAX_SAFE_INTEGER,
		),
	);
	const images =
		options.includeImages && model.input.includes("image")
			? collectConversationImages(convertToLlm(options.messages))
			: [];
	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: request }, ...images],
		timestamp: Date.now(),
	};
	const response = await options.context.modelRegistry.complete(
		model,
		{ systemPrompt: loadRiemannPrompt("system/compaction.md"), messages: [userMessage] },
		{
			cacheRetention: "none",
			maxTokens,
			sessionId: randomUUID(),
			signal: options.signal,
		},
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage || `Riemann compaction ${response.stopReason}`);
	}
	const text = contentText(response.content).trim();
	if (!text) throw new Error("Riemann compaction returned an empty summary");
	return { text, usage: response.usage };
}

export async function createRiemannCompaction(options: {
	preparation: CompactionPreparation;
	includeImages: boolean;
	customInstructions?: string;
	signal: AbortSignal;
	context: Pick<ExtensionContext, "model" | "modelRegistry">;
	durableState: JsonValue;
}): Promise<CompactionResult> {
	const preparation = options.preparation;
	const operations = fileOperations(preparation);
	let generated: string;
	let usage: Usage;
	let kind: SemanticCompactionKind = preparation.previousSummary ? "update" : "initial";
	if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
		let history = "No prior history.";
		let historyUsage: Usage | undefined;
		if (preparation.messagesToSummarize.length > 0) {
			const result = await createSemanticSection({
				includeImages: options.includeImages,
				kind,
				messages: preparation.messagesToSummarize,
				previousSummary: preparation.previousSummary,
				customInstructions: options.customInstructions,
				fileOperations: operations,
				preparation,
				signal: options.signal,
				context: options.context,
			});
			history = result.text;
			historyUsage = result.usage;
		}
		const prefix = await createSemanticSection({
			includeImages: options.includeImages,
			kind: "prefix",
			messages: preparation.turnPrefixMessages,
			customInstructions: options.customInstructions,
			fileOperations: operations,
			preparation,
			signal: options.signal,
			context: options.context,
		});
		generated = `${history}\n\n---\n\n## Turn Context\n${prefix.text}`;
		usage = combineUsage(historyUsage, prefix.usage);
		kind = "prefix";
	} else {
		const result = await createSemanticSection({
			includeImages: options.includeImages,
			kind,
			messages: preparation.messagesToSummarize,
			previousSummary: preparation.previousSummary,
			customInstructions: options.customInstructions,
			fileOperations: operations,
			preparation,
			signal: options.signal,
			context: options.context,
		});
		generated = result.text;
		usage = result.usage;
	}
	const summary = `${generated}\n\n<riemann_state>\n${JSON.stringify(options.durableState)}\n</riemann_state>`;
	return {
		summary,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		usage,
		details: { version: 1, strategy: "default", kind, fileOperations: operations },
	};
}

function maxSnapshotFrames(preparation: CompactionPreparation, context: Pick<ExtensionContext, "model">): number {
	const model = context.model;
	if (!model) return 1;
	const shape = snapshot.resolveShape({ api: model.api, id: model.id });
	const edgeTokens = Math.ceil((2 * snapshot.geometry(shape).capacity * 1.15) / 4) + 2_000;
	const retainedTokens = (preparation.recentMessages ?? []).reduce(
		(total, message) => total + estimateTokens(message),
		0,
	);
	const frameBudget =
		model.contextWindow -
		preparation.settings.reserveTokens -
		retainedTokens -
		edgeTokens -
		SNAPSHOT_NON_MESSAGE_RESERVE_TOKENS;
	const contextFrames = Math.max(1, Math.floor(frameBudget / snapshot.FRAME_TOKEN_ESTIMATE));
	return Math.min(
		contextFrames,
		snapshot.MAX_FRAMES_DEFAULT,
		snapshot.maxFramesForDataBudget(),
		snapshot.providerImageBudget(model.provider),
	);
}

export async function createRiemannSnapshotCompaction(options: {
	preparation: CompactionPreparation;
	signal: AbortSignal;
	context: Pick<ExtensionContext, "model">;
	durableState: JsonValue;
}): Promise<CompactionResult> {
	const model = options.context.model;
	if (!model) throw new Error("Cannot compact Riemann context without a selected model");
	if (!model.input.includes("image")) throw new Error(`Model ${model.id} does not support snapshot compaction images`);
	if (options.signal.aborted) throw new Error("Riemann snapshot compaction aborted");
	const result = await snapshot.compact(
		{
			firstKeptEntryId: options.preparation.firstKeptEntryId,
			messagesToSummarize: options.preparation.messagesToSummarize,
			turnPrefixMessages: options.preparation.turnPrefixMessages,
			tokensBefore: options.preparation.tokensBefore,
			previousSummary: options.preparation.previousSummary,
			previousPreserveData: options.preparation.previousPreserveData,
			fileOps: options.preparation.fileOps,
		},
		{
			convertToLlm,
			model: { api: model.api, id: model.id },
			maxFrames: maxSnapshotFrames(options.preparation, options.context),
			includeThinking: !["anthropic-messages", "bedrock-converse-stream"].includes(model.api),
		},
	);
	if (options.signal.aborted) throw new Error("Riemann snapshot compaction aborted");
	const archive = snapshot.getPreservedArchive(result.preserveData);
	const summary = `${result.summary}\n<riemann_state>\n${JSON.stringify(options.durableState)}\n</riemann_state>\n`;
	return {
		summary,
		firstKeptEntryId: result.firstKeptEntryId,
		tokensBefore: result.tokensBefore,
		details: {
			version: 1,
			strategy: "snapshot",
			fileOperations: result.details,
			frames: archive?.frames.length ?? 0,
			archivedCharacters: archive?.totalChars ?? 0,
			truncatedCharacters: archive?.truncatedChars ?? 0,
		},
		preserveData: result.preserveData,
	};
}
