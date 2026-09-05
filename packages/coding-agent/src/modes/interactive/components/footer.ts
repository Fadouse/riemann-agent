import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Compact model/context footer. Detailed token, cache and cost statistics remain
 * available through /session; branch and extension statuses come from the provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private cachedContext?: { usage: ReturnType<AgentSession["getContextUsage"]> };

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this.invalidate();
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/** Invalidate history-derived context while branch data remains provider-cached. */
	invalidate(): void {
		this.cachedContext = undefined;
	}

	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;
		// getContextUsage can traverse the active branch. Cache even an unknown result
		// so spinner/editor repaints do not repeatedly walk session history.
		this.cachedContext ??= { usage: this.session.getContextUsage() };
		const contextUsage = this.cachedContext.usage;
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow;
		const percent = contextUsage?.percent;
		const contextText = `${percent == null ? "?" : `${percent.toFixed(1)}%`}/${contextWindow ? formatTokens(contextWindow) : "?"}`;
		const context =
			percent != null && percent > 90
				? theme.fg("error", contextText)
				: percent != null && percent > 70
					? theme.fg("warning", contextText)
					: contextText;

		const modelName = sanitizeStatusText(state.model?.id || "no-model");
		const thinkingLevel = state.thinkingLevel || "off";
		const thinking = state.model?.reasoning ? ` ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}` : "";
		let modelStatus = `${modelName}${thinking} • ${context}`;
		if (visibleWidth(modelStatus) > width) {
			modelStatus = `${modelName} • ${context}`;
		}
		if (visibleWidth(modelStatus) > width) {
			// Reserve context before truncating a long model name. At tiny widths only
			// context fits; never let a long identifier push it completely offscreen.
			const modelWidth = width - visibleWidth(context) - 3;
			modelStatus =
				modelWidth > 0
					? `${truncateToWidth(modelName, modelWidth, "…")} • ${context}`
					: truncateToWidth(context, width, "");
		}

		const sessionName = sanitizeStatusText(this.session.sessionManager.getSessionName() ?? "");
		let directory = sanitizeStatusText(
			formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
		);
		const branch = this.footerData.getGitBranch();
		if (branch) directory += ` (${sanitizeStatusText(branch)})`;
		let location = sessionName ? `${directory} ${sessionName}` : directory;
		let separateSession = false;
		if (visibleWidth(modelStatus) + 2 + visibleWidth(location) > width) {
			// Directory is secondary. Keep a named session in the existing footer area
			// with an explicit /session entry when it cannot share the primary row.
			location = "";
			separateSession = !!sessionName;
		}

		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			const provider = `(${sanitizeStatusText(state.model.provider)}) `;
			if (visibleWidth(provider + modelStatus) + (location ? 2 + visibleWidth(location) : 0) <= width)
				modelStatus = provider + modelStatus;
		}
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : " (manual)";
		if (visibleWidth(modelStatus + autoIndicator) + (location ? 2 + visibleWidth(location) : 0) <= width)
			modelStatus += autoIndicator;
		if (areExperimentalFeaturesEnabled()) {
			const experimental = ` ${theme.bold(theme.fg("warning", "xp"))}`;
			if (visibleWidth(modelStatus + experimental) + (location ? 2 + visibleWidth(location) : 0) <= width)
				modelStatus += experimental;
		}

		// Keep model/context on the left, with the secondary directory aligned right.
		const padding = " ".repeat(width - visibleWidth(location) - visibleWidth(modelStatus));
		const lines = [theme.fg("dim", modelStatus) + theme.fg("dim", padding + location)];
		if (separateSession) {
			const entry = " • /session";
			const available = width - visibleWidth(entry);
			const nameLine =
				available > 0
					? truncateToWidth(sessionName, available, "…") + entry
					: truncateToWidth("/session", width, "");
			lines.push(theme.fg("dim", nameLine));
		}

		// Preserve extension statuses on their own line, sorted by key alphabetically.
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			lines.push(truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "...")));
		}
		return lines;
	}
}
