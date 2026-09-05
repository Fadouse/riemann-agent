import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { DatabaseSync } from "../src/riemann/state/database.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

test("reads complete inboxes in index order and preserves FULL durability", () => {
	const root = mkdtempSync(join(tmpdir(), "store-index-"));
	const configure = vi.spyOn(DatabaseSync.prototype, "exec");
	let store: RiemannStore;
	try {
		store = new RiemannStore(root);
		expect(configure).toHaveBeenCalledWith(expect.stringContaining("PRAGMA synchronous=FULL"));
	} finally {
		configure.mockRestore();
	}
	const db = new DatabaseSync(join(root, "state", "riemann.db"));
	try {
		const run = store.openRun("test", root);
		const main = store.ensureRootAgent(run.id, root);
		for (let i = 0; i < 50; i++)
			store.sendMessage({ runId: run.id, senderId: main.id, recipientId: main.id, body: String(i) });
		const messages = store.listInbox(main.id);
		store.markMessageDelivered(messages[0]!.id);
		expect(store.listInbox(main.id)).toHaveLength(50);
		expect(store.listInbox(main.id, { unreadOnly: true })).toHaveLength(49);
		for (const query of [
			"SELECT * FROM messages WHERE recipient_id = ? ORDER BY created_at, id",
			"SELECT * FROM messages WHERE recipient_id = ? AND delivered_at IS NULL ORDER BY created_at, id",
			"SELECT * FROM agent_events WHERE recipient_id = ? AND delivered_at IS NULL ORDER BY created_at, id",
		]) {
			const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(main.id) as { detail: string }[];
			expect(plan.map((row) => row.detail).join("\n")).not.toContain("TEMP B-TREE");
		}
		expect(db.prepare("PRAGMA synchronous").get()).toMatchObject({ synchronous: 2 });
	} finally {
		db.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("adds complete-order indexes when reopening an existing schema", () => {
	const root = mkdtempSync(join(tmpdir(), "store-index-upgrade-"));
	let store = new RiemannStore(root);
	store.close();
	const db = new DatabaseSync(join(root, "state", "riemann.db"));
	try {
		db.exec(
			"DROP INDEX IF EXISTS messages_recipient_created; DROP INDEX IF EXISTS messages_unread_created; DROP INDEX IF EXISTS agent_events_pending_created;",
		);
		store = new RiemannStore(root);
		const indexes = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all() as { name: string }[];
		expect(indexes.map((index) => index.name)).toEqual(
			expect.arrayContaining([
				"messages_recipient_created",
				"messages_unread_created",
				"agent_events_pending_created",
			]),
		);
	} finally {
		db.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("status patches do not rewrite unchanged prompt/result columns", () => {
	const root = mkdtempSync(join(tmpdir(), "store-patch-"));
	const store = new RiemannStore(root);
	const db = new DatabaseSync(join(root, "state", "riemann.db"));
	try {
		const run = store.openRun("test", root);
		const main = store.ensureRootAgent(run.id, root);
		store.updateAgent(main.id, { prompt: "p".repeat(100000), result: "r".repeat(100000), error: "previous" });
		db.exec(
			"CREATE TABLE rewritten(value INTEGER); CREATE TRIGGER record_large_update AFTER UPDATE OF prompt, result ON agents BEGIN INSERT INTO rewritten VALUES(1); END;",
		);
		expect(store.updateAgent(main.id, { status: "idle" })).toMatchObject({
			status: "idle",
			prompt: "p".repeat(100000),
			result: "r".repeat(100000),
			error: "previous",
		});
		expect(db.prepare("SELECT count(*) AS count FROM rewritten").get()).toMatchObject({ count: 0 });
		expect(store.updateAgent(main.id, { result: null, error: null })).toMatchObject({ result: null, error: null });
		expect(store.getAgent(main.id)).toMatchObject({ status: "idle", prompt: "p".repeat(100000), result: null });
		expect(() => store.updateAgent("missing", {})).toThrow("Agent not found");
	} finally {
		db.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("reuses hot prepared statements across calls and isolates store instances", () => {
	const root = mkdtempSync(join(tmpdir(), "store-prepare-"));
	const store = new RiemannStore(root);
	try {
		const run = store.openRun("test", root);
		const main = store.ensureRootAgent(run.id, root);
		store.getAgent(main.id);
		store.listInbox(main.id);
		const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
		try {
			for (let i = 0; i < 10; i++) {
				expect(store.getAgent(main.id)?.id).toBe(main.id);
				expect(store.listInbox(main.id)).toEqual([]);
			}
			expect(prepare).not.toHaveBeenCalled();
		} finally {
			prepare.mockRestore();
		}
	} finally {
		store.close();
	}
	const reopened = new RiemannStore(root);
	try {
		expect(reopened.openRun("test", root).sessionId).toBe("test");
	} finally {
		reopened.close();
		rmSync(root, { recursive: true, force: true });
	}
});
