export const CONFIGURED_COMPACTION_STRATEGIES = ["automatic", "default", "openai", "snapshot"] as const;

export type ConfiguredCompactionStrategy = (typeof CONFIGURED_COMPACTION_STRATEGIES)[number];
export type EffectiveCompactionStrategy = Exclude<ConfiguredCompactionStrategy, "automatic"> | "experimental";

export interface CompactionStrategyModel {
	provider: string;
	api: string;
}

export interface CompactionStrategyCapabilities {
	usingOAuth?: boolean;
	/** Whether this session can use experimental context. */
	supportsExperimentalContext?: boolean;
}

export interface CompactionStrategyResolution {
	configured: ConfiguredCompactionStrategy;
	effective: EffectiveCompactionStrategy;
}

/** Resolve a configured strategy for the currently selected model without side effects. */
export function resolveCompactionStrategy(
	configured: ConfiguredCompactionStrategy,
	model: CompactionStrategyModel | undefined,
	capabilities: CompactionStrategyCapabilities = {},
): CompactionStrategyResolution {
	if (configured !== "automatic") return { configured, effective: configured };
	const codex = model?.provider === "openai-codex" && model.api === "openai-codex-responses";
	if (!codex || capabilities.usingOAuth !== true) return { configured, effective: "default" };
	return {
		configured,
		effective: capabilities.supportsExperimentalContext === true ? "experimental" : "openai",
	};
}
