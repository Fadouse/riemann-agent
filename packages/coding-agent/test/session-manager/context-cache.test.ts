import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildSessionContext, type FileEntry, SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager context working set", () => {
	it("retains compact validation metadata rather than one wrapper object per archived entry", () => {
		const root = mkdtempSync(join(tmpdir(), "session-cache-heap-"));
		try {
			const script = join(root, "heap.mjs");
			const modulePath = new URL("../../src/core/session-manager.ts", import.meta.url).href;
			writeFileSync(
				script,
				`
import { SessionManager } from ${JSON.stringify(modulePath)};
const manager = SessionManager.inMemory("/tmp");
let kept;
for (let i = 0; i < 100000; i++) {
	const id = manager.appendMessage({ role: "user", content: "中🙂 history", timestamp: i });
	if (i === 99980) kept = id;
}
manager.appendCompaction("summary", kept, 100000);
global.gc();
const before = process.memoryUsage().heapUsed;
manager.buildSessionContext();
global.gc();
const retained = process.memoryUsage().heapUsed - before;
const entries = manager.getEntries().length;
const messages = manager.buildSessionContext().messages.length;
for (let i = 0; i < 100; i++) manager.appendMessage({ role: "user", content: "append", timestamp: 100000 + i });
global.gc();
const appendedRetained = process.memoryUsage().heapUsed - before;
console.log(JSON.stringify({ retained, appendedRetained, entries, messages, appendedMessages: manager.buildSessionContext().messages.length }));
`,
			);
			const child = spawnSync(process.execPath, ["--expose-gc", script], { encoding: "utf8" });
			expect(child.status, child.stderr).toBe(0);
			const result = JSON.parse(child.stdout) as {
				retained: number;
				appendedRetained: number;
				entries: number;
				messages: number;
				appendedMessages: number;
			};
			expect(result.entries).toBe(100001);
			expect(result.messages).toBe(21);
			// V8's previous per-entry objects retain ~8 MB here. Leave substantial
			// headroom above flat metadata, without relying on exact heap accounting.
			expect(result.retained).toBeLessThan(6_000_000);
			expect(result.appendedRetained).toBeLessThan(6_000_000);
			expect(result.appendedMessages).toBe(121);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reuses branch topology for stable and appended contexts", () => {
		const entries: FileEntry[] = [
			{ type: "session", version: 3, id: "cached", timestamp: "2026-01-01", cwd: "/tmp" },
		];
		for (let i = 0; i < 1000; i++) {
			entries.push({
				type: "message",
				id: String(i),
				parentId: i === 0 ? null : String(i - 1),
				timestamp: "2026-01-01",
				message: { role: "user", content: String(i), timestamp: i },
			});
		}
		const manager = SessionManager.inMemory("/tmp", undefined, entries);
		manager.appendCompaction("summary", "980", 1000);
		expect(manager.buildSessionContext().messages).toHaveLength(21);
		const lookups = vi.spyOn(Map.prototype, "get");
		try {
			for (let i = 0; i < 10; i++) expect(manager.buildSessionContext().messages).toHaveLength(21);
			manager.appendMessage({ role: "user", content: "new", timestamp: 1001 });
			expect(manager.buildSessionContext().messages).toHaveLength(22);
			expect(lookups.mock.calls.filter(([key]) => key === "0")).toHaveLength(0);
		} finally {
			lookups.mockRestore();
		}
	});

	it("preserves appends and external mutations across metadata block boundaries", () => {
		const manager = SessionManager.inMemory("/tmp");
		for (let i = 0; i < 1023; i++) manager.appendMessage({ role: "user", content: `中🙂 ${i}`, timestamp: i });
		manager.buildSessionContext();
		for (let i = 1023; i < 2050; i++) manager.appendMessage({ role: "user", content: `中🙂 ${i}`, timestamp: i });
		expect(manager.buildSessionContext().messages).toHaveLength(2050);
		const entries = manager.getEntries();
		manager.appendCompaction("summary", entries[2040]!.id, 100000);
		const custom = manager.appendCustomMessageEntry(
			"extension",
			[
				{ type: "text", text: "**中文** 🙂 e" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
			true,
			{ retained: true },
		);
		// Preserve the manager's original map keys while testing mutable entry IDs.
		const byId = new Map(manager.getEntries().map((entry) => [entry.id, entry]));
		const equivalent = () =>
			expect(manager.buildSessionContext()).toEqual(
				buildSessionContext(manager.getEntries(), manager.getLeafId(), byId),
			);
		equivalent();
		for (const index of [1023, 1024, 2047, 2048]) {
			const entry = entries[index]!;
			const parentId = entry.parentId;
			entry.parentId = entries[10]!.id;
			equivalent();
			entry.parentId = parentId;
			equivalent();
		}
		const entry = entries[1024]!;
		Object.assign(entry, { type: "model_change", provider: "changed-provider", modelId: "changed-model" });
		equivalent();
		expect(manager.buildSessionContext().model).toEqual({ provider: "changed-provider", modelId: "changed-model" });
		Object.assign(entry, { type: "message" });
		equivalent();
		const kept = entries[2040]!;
		kept.id = "changed-kept-id";
		equivalent();
		const customEntry = manager.getEntry(custom);
		if (customEntry?.type !== "custom_message" || typeof customEntry.content === "string")
			throw new Error("missing custom message");
		customEntry.content[0] = { type: "text", text: "更新后的 **Markdown** 👩" };
		customEntry.content[1] = { type: "image", data: "bmV3LWltYWdl", mimeType: "image/png" };
		equivalent();
	});

	it("keeps projections fresh and follows mutations, compactions, branches and reset", () => {
		const manager = SessionManager.inMemory("/tmp");
		const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		manager.appendThinkingLevelChange("high");
		const model = manager.appendModelChange("openai", "old-model");
		const mutable = { role: "user" as const, content: "kept", timestamp: 2 };
		const kept = manager.appendMessage(mutable);
		const compacted = manager.appendCompaction("summary", kept, 1000);
		const equivalent = () =>
			expect(manager.buildSessionContext()).toEqual(buildSessionContext(manager.getEntries(), manager.getLeafId()));
		equivalent();
		manager.buildSessionContext().messages.length = 0;
		manager.buildContextEntries().length = 0;
		mutable.content = "edited content";
		const modelEntry = manager.getEntry(model);
		if (modelEntry?.type !== "model_change") throw new Error("missing model");
		modelEntry.modelId = "updated-model";
		const compaction = manager.getEntry(compacted);
		if (compaction?.type !== "compaction") throw new Error("missing compaction");
		compaction.summary = "updated-summary";
		equivalent();
		compaction.firstKeptEntryId = first;
		equivalent();
		manager.branch(first);
		manager.appendMessage({ role: "user", content: "other branch", timestamp: 3 });
		equivalent();
		manager.branch(compacted);
		manager.appendCompaction("second compaction", kept, 2000);
		equivalent();
		manager.resetLeaf();
		equivalent();
		manager.appendMessage({ role: "user", content: "new root", timestamp: 4 });
		equivalent();
		manager.newSession();
		equivalent();
	});

	it("invalidates when exposed entry topology or message roles change", () => {
		const manager = SessionManager.inMemory("/tmp");
		const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const second = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const leaf = manager.appendMessage({ role: "user", content: "leaf", timestamp: 3 });
		const equivalent = () =>
			expect(manager.buildSessionContext()).toEqual(buildSessionContext(manager.getEntries(), manager.getLeafId()));
		equivalent();
		const entry = manager.getEntry(leaf)!;
		entry.parentId = first;
		equivalent();
		entry.parentId = second;
		equivalent();
		const middle = manager.getEntry(second);
		if (middle?.type !== "message") throw new Error("missing message");
		middle.message = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "changed-role",
			stopReason: "stop",
			timestamp: 2,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		equivalent();
		expect(manager.buildSessionContext().model?.modelId).toBe("changed-role");
		entry.parentId = "missing";
		equivalent();
	});

	it("matches the uncached projection through settings precedence and nested kept compactions", () => {
		const manager = SessionManager.inMemory("/tmp");
		const equivalent = () =>
			expect(manager.buildSessionContext()).toEqual(buildSessionContext(manager.getEntries(), manager.getLeafId()));
		const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const level = manager.appendThinkingLevelChange("low");
		const configured = manager.appendModelChange("first-provider", "first-model");
		equivalent();
		const assistant = manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			api: "openai-responses",
			provider: "openai",
			model: "assistant-model",
			stopReason: "stop",
			timestamp: 2,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		equivalent();
		manager.appendModelChange("second-provider", "second-model");
		equivalent();
		const firstCompaction = manager.appendCompaction("first", root, 1000);
		equivalent();
		manager.appendMessage({ role: "user", content: "after first", timestamp: 3 });
		manager.appendCompaction("second", level, 2000);
		equivalent();
		manager.appendMessage({ role: "user", content: "after second", timestamp: 4 });
		manager.appendCompaction("third", root, 3000);
		equivalent();
		expect(
			manager.buildSessionContext().messages.filter((message) => message.role === "compactionSummary"),
		).toHaveLength(3);
		const levelEntry = manager.getEntry(level);
		if (levelEntry?.type !== "thinking_level_change") throw new Error("missing level");
		levelEntry.thinkingLevel = "high";
		equivalent();
		const modelEntry = manager.getEntry(configured);
		if (modelEntry?.type !== "model_change") throw new Error("missing model");
		modelEntry.provider = "mutated-provider";
		modelEntry.modelId = "mutated-model";
		equivalent();
		const assistantEntry = manager.getEntry(assistant);
		if (assistantEntry?.type !== "message" || assistantEntry.message.role !== "assistant")
			throw new Error("missing assistant");
		assistantEntry.message.provider = "mutated-assistant-provider";
		assistantEntry.message.model = "mutated-assistant-model";
		assistantEntry.message.content = [{ type: "text", text: "mutated reply" }];
		equivalent();
		const earlierCompaction = manager.getEntry(firstCompaction);
		if (earlierCompaction?.type !== "compaction") throw new Error("missing compaction");
		earlierCompaction.summary = "updated earlier summary";
		earlierCompaction.preserveData = {
			snapcompact: { frames: [], totalChars: 5, truncatedChars: 0, textHead: "fresh" },
		};
		equivalent();
		manager.branch(assistant);
		equivalent();
		expect(manager.buildSessionContext().model).toEqual({
			provider: "mutated-assistant-provider",
			modelId: "mutated-assistant-model",
		});
		manager.branch(configured);
		equivalent();
		expect(manager.buildSessionContext().model).toEqual({ provider: "mutated-provider", modelId: "mutated-model" });
		manager.branch(root);
		equivalent();
		expect(manager.buildSessionContext().thinkingLevel).toBe("off");
	});

	it("invalidates cached state on reload and fork", () => {
		const root = mkdtempSync(join(tmpdir(), "session-cache-"));
		try {
			const manager = SessionManager.create(root, root);
			const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
			manager.buildSessionContext();
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "reply" }],
				api: "openai-responses",
				provider: "openai",
				model: "model",
				stopReason: "stop",
				timestamp: 2,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			const original = manager.getSessionFile()!;
			manager.buildSessionContext();
			manager.createBranchedSession(first);
			expect(manager.buildSessionContext().messages).toHaveLength(1);
			manager.setSessionFile(original);
			expect(manager.buildSessionContext().messages).toHaveLength(2);
			const fork = SessionManager.forkFrom(original, root, root);
			expect(fork.buildSessionContext()).toEqual(manager.buildSessionContext());
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
