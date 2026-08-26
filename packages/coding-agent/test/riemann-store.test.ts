import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FULL_FILESYSTEM } from "../src/riemann/access-policy.ts";
import { DatabaseSync } from "../src/riemann/state/database.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Riemann state schema", () => {
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
