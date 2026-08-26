export const CONFIGURED_COMPACTION_STRATEGIES = ["automatic", "default", "openai", "snapshot"] as const;

export type ConfiguredCompactionStrategy = (typeof CONFIGURED_COMPACTION_STRATEGIES)[number];
export type EffectiveCompactionStrategy = Exclude<ConfiguredCompactionStrategy, "automatic">;

export interface CompactionStrategyModel {
	provider: string;
	api: string;
}

export interface CompactionStrategyResolution {
	configured: ConfiguredCompactionStrategy;
	effective: EffectiveCompactionStrategy;
}

/** Resolve a configured strategy for the currently selected model without side effects. */
export function resolveCompactionStrategy(
	configured: ConfiguredCompactionStrategy,
	model: CompactionStrategyModel | undefined,
): CompactionStrategyResolution {
	if (configured !== "automatic") return { configured, effective: configured };
	return {
		configured,
		effective: model?.provider === "openai-codex" && model.api === "openai-codex-responses" ? "openai" : "default",
	};
}
