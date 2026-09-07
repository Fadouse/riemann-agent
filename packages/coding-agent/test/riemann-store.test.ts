import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { FULL_FILESYSTEM } from "../src/riemann/access-policy.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
import { DatabaseSync } from "../src/riemann/state/database.ts";
import { applyRetention } from "../src/riemann/state/retention.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Riemann state schema", () => {
	test("allocates unique short references and persists grants across concurrent processes", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-reference-processes-"));
		roots.push(root);
		const agentDir = join(root, ".agent");
		let store = new RiemannStore(agentDir);
		const run = store.openRun("reference-processes", root);
		const agent = store.ensureRootAgent(run.id, root);
		const script = join(root, "reference-worker.mts");
		await writeFile(
			script,
			`
import { RiemannStore } from ${JSON.stringify(new URL("../src/riemann/state/store.ts", import.meta.url).href)};
import { ArtifactStore } from ${JSON.stringify(new URL("../src/riemann/state/artifacts.ts", import.meta.url).href)};
const [agentDir, runId, agentId, text] = process.argv.slice(2);
const store = new RiemannStore(agentDir);
try {
    console.log(JSON.stringify(await new ArtifactStore(store, runId).forAgent(agentId).putText(text)));
} finally { store.close(); }
`,
		);
		try {
			const results = await Promise.all(
				["same", "same", "different"].map((text) =>
					execCommand(process.execPath, [script, agentDir, run.id, agent.id, text], root, { timeout: 15_000 }),
				),
			);
			const refs = results.map((result) => {
				expect(result.code, result.stderr).toBe(0);
				const wire = JSON.parse(result.stdout) as { handle: string };
				expect(wire.handle).toMatch(/^r[12]$/);
				return wire.handle;
			});
			expect(refs[0]).toBe(refs[1]);
			expect(refs[2]).not.toBe(refs[0]);
			store.close();
			store = new RiemannStore(agentDir);
			const restored = new ArtifactStore(store, run.id).forAgent(agent.id);
			expect(await restored.get(refs[0])).toMatchObject({ handle: refs[0], text: "same" });
			expect(await restored.get(refs[2])).toMatchObject({ handle: refs[2], text: "different" });
			expect(await restored.putText("same")).toMatchObject({ handle: refs[0] });
			expect(store.listArtifacts(run.id)).toHaveLength(2);
		} finally {
			store.close();
		}
	}, 30_000);

	test("does not reuse expired references and cascades reference state with retention", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-reference-retention-"));
		roots.push(root);
		const agentDir = join(root, ".agent");
		const store = new RiemannStore(agentDir);
		const run = store.openRun("reference-retention", root);
		const agent = store.ensureRootAgent(run.id, root);
		const artifacts = new ArtifactStore(store, run.id).forAgent(agent.id);
		const database = new DatabaseSync(join(agentDir, "state", "riemann.db"));
		database.exec("PRAGMA foreign_keys=ON");
		try {
			expect(await artifacts.putText("expired")).toMatchObject({ handle: "r1" });
			const canonical = artifacts.getMetadata("r1").handle;
			database.prepare("DELETE FROM artifacts WHERE handle = ?").run(canonical);
			expect(() => artifacts.getMetadata("r1")).toThrow("Unknown short resource reference");
			expect(
				database.prepare("SELECT COUNT(*) AS count FROM reference_grants WHERE run_id = ?").get(run.id),
			).toMatchObject({ count: 0 });
			expect(await artifacts.putText("expired")).toMatchObject({ handle: "r2" });
			for (let number = 3; number <= 36; number += 1) {
				expect(await artifacts.putText(`resource ${number}`)).toMatchObject({ handle: `r${number.toString(36)}` });
			}
			expect(artifacts.getMetadata("r10").handle).toMatch(/^artifact:\/\//);
			store.closeRun(run.id);
			const report = await applyRetention(
				store,
				{ maxAgeDays: 0, maxArtifactBytes: 0, maxSnapshotBytes: 0, maxWorktreeBytes: 0 },
				{ now: new Date(Date.now() + 60_000) },
			);
			expect(report.errors).toEqual([]);
			expect(report.removedRunIds).toContain(run.id);
			for (const table of ["resource_references", "reference_grants", "reference_sequences"]) {
				expect(
					database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ?`).get(run.id),
				).toMatchObject({ count: 0 });
			}
			expect(() => artifacts.getMetadata("r2")).toThrow("Unknown short resource reference");
		} finally {
			database.close();
			store.close();
		}
	});

	test("clears stopped identities with interrupted active Turns during recovery", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-store-stopped-"));
		roots.push(root);
		const agentDir = join(root, ".agent");
		let store = new RiemannStore(agentDir);
		const run = store.openRun("stopped-recovery", root);
		const main = store.ensureRootAgent(run.id, root);
		const child = store.createAgent({
			runId: run.id,
			parentId: main.id,
			name: "stopped",
			status: "idle",
			prompt: "task",
			modelRole: "inherit",
			workspace: root,
			workspaceMode: "shared",
			filesystem: FULL_FILESYSTEM,
			network: "deny",
			depth: 1,
			capabilities: ["fs.read"],
		});
		const { turn } = store.startAgentTurn({
			agentId: child.id,
			task: "task",
			prompt: "task",
			deliveryMode: "notify",
		});
		store.markAgentTurnRunning(child.id, turn.id);
		store.updateAgent(child.id, { status: "stopped", lastOutcome: "cancelled" });
		store.close();
		store = new RiemannStore(agentDir);
		try {
			store.markInterruptedAgents(run.id);
			expect(store.getAgentTurn(turn.id)).toMatchObject({ status: "settled", outcome: "cancelled" });
			expect(store.getAgent(child.id)).toMatchObject({ status: "stopped", activeTurnId: null, lastTurnId: turn.id });
			expect(store.getAgent(main.id)?.status).toBe("running");
			const recovered = store.getAgent(child.id);
			store.markInterruptedAgents(run.id);
			expect(store.getAgent(child.id)).toEqual(recovered);
			expect(
				store.startAgentTurn({ agentId: child.id, task: "next", prompt: "next", deliveryMode: "notify" }).turn.id,
			).not.toBe(turn.id);
		} finally {
			store.close();
		}
	});

	test("gates historical Turn backfill while self-healing current columns and indexes", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-store-current-"));
		roots.push(root);
		const agentDir = join(root, ".agent");
		let store = new RiemannStore(agentDir);
		const run = store.openRun("current-schema", root);
		const main = store.ensureRootAgent(run.id, root);
		const child = store.createAgent({
			runId: run.id,
			parentId: main.id,
			name: "no-legacy-turn",
			status: "idle",
			prompt: "created after the Turn migration",
			modelRole: "inherit",
			workspace: root,
			workspaceMode: "shared",
			filesystem: FULL_FILESYSTEM,
			network: "deny",
			depth: 1,
			capabilities: ["fs.read"],
		});
		store.close();

		const databasePath = join(agentDir, "state", "riemann.db");
		let database = new DatabaseSync(databasePath);
		try {
			database.exec(
				"DROP INDEX artifacts_path_run; ALTER TABLE agents DROP COLUMN released_at; ALTER TABLE agents DROP COLUMN network;",
			);
		} finally {
			database.close();
		}

		store = new RiemannStore(agentDir);
		try {
			expect(store.getAgent(child.id)).toMatchObject({ lastTurnId: null, releasedAt: null, network: "deny" });
			expect(store.listAgentTurns(child.id)).toEqual([]);
		} finally {
			store.close();
		}

		database = new DatabaseSync(databasePath);
		try {
			const columns = database.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
			expect(columns.map((column) => column.name)).toContain("released_at");
			const indexes = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all() as Array<{
				name: string;
			}>;
			expect(indexes.map((index) => index.name)).toEqual(
				expect.arrayContaining([
					"agents_parent",
					"agents_run_created",
					"messages_run",
					"messages_sender",
					"messages_reply",
					"agent_events_run",
					"agent_events_turn",
					"artifacts_run_created",
					"artifacts_path_run",
					"file_capabilities_run",
				]),
			);
		} finally {
			database.close();
		}
	});

	test("migrates schemas that predate both permissions and filesystem columns", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-store-legacy-"));
		roots.push(root);
		const agentDir = join(root, ".agent");
		let store = new RiemannStore(agentDir);
		const run = store.openRun("legacy-schema", root);
		const main = store.ensureRootAgent(run.id, root);
		const child = store.createAgent({
			runId: run.id,
			parentId: main.id,
			name: "legacy-child",
			status: "idle",
			prompt: "legacy task",
			modelRole: "inherit",
			workspace: root,
			workspaceMode: "shared",
			filesystem: FULL_FILESYSTEM,
			network: "deny",
			depth: 1,
			capabilities: ["fs.read"],
		});
		store.close();

		const databasePath = join(agentDir, "state", "riemann.db");
		let database = new DatabaseSync(databasePath);
		try {
			database.exec("UPDATE schema_version SET version = 1");
			database
				.prepare("UPDATE agents SET status = 'completed', result = 'legacy result' WHERE id = ?")
				.run(child.id);
			database.exec("ALTER TABLE agents DROP COLUMN filesystem_json");
		} finally {
			database.close();
		}

		store = new RiemannStore(agentDir);
		try {
			const migrated = store.getAgent(child.id);
			expect(migrated).toMatchObject({
				status: "idle",
				lastOutcome: "ok",
				filesystem: {
					read: [root],
					readExclude: [],
					write: [root],
					writeExclude: [],
				},
				lastTurnId: expect.any(String),
			});
			if (!migrated?.lastTurnId) throw new Error("Legacy Turn was not backfilled");
			expect(store.getAgentTurn(migrated.lastTurnId)).toMatchObject({
				task: "legacy task",
				status: "settled",
				outcome: "ok",
				result: "legacy result",
			});
		} finally {
			store.close();
		}

		database = new DatabaseSync(databasePath);
		try {
			const version = database.prepare("SELECT version FROM schema_version").get() as { version: number };
			expect(version.version).toBe(4);
		} finally {
			database.close();
		}
	});
});
