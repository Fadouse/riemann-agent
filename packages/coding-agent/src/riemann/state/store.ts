import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type RiemannDatabase } from "./database.ts";

export type AgentStatus = "queued" | "running" | "idle" | "parked" | "completed" | "failed" | "stopped";

export interface StoredRun {
	id: string;
	sessionId: string;
	cwd: string;
	status: "active" | "closed";
	createdAt: string;
	updatedAt: string;
}

export interface StoredAgent {
	id: string;
	runId: string;
	parentId: string | null;
	name: string;
	status: AgentStatus;
	prompt: string;
	modelRole: string;
	workspace: string;
	depth: number;
	capabilities: string[];
	result: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface StoredMessage {
	id: string;
	runId: string;
	senderId: string;
	recipientId: string;
	body: string;
	replyTo: string | null;
	createdAt: string;
	deliveredAt: string | null;
}

export interface StoredArtifact {
	handle: string;
	runId: string;
	hash: string;
	mimeType: string;
	size: number;
	name: string | null;
	path: string;
	createdAt: string;
}

interface RunRow {
	id: string;
	session_id: string;
	cwd: string;
	status: "active" | "closed";
	created_at: string;
	updated_at: string;
}

interface AgentRow {
	id: string;
	run_id: string;
	parent_id: string | null;
	name: string;
	status: AgentStatus;
	prompt: string;
	model_role: string;
	workspace: string;
	depth: number;
	capabilities_json: string;
	result: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
}

interface MessageRow {
	id: string;
	run_id: string;
	sender_id: string;
	recipient_id: string;
	body: string;
	reply_to: string | null;
	created_at: string;
	delivered_at: string | null;
}

interface ArtifactRow {
	handle: string;
	run_id: string;
	hash: string;
	mime_type: string;
	size: number;
	name: string | null;
	path: string;
	created_at: string;
}

function now(): string {
	return new Date().toISOString();
}

function parseStringArray(value: string): string[] {
	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
}

function runFromRow(row: RunRow): StoredRun {
	return {
		id: row.id,
		sessionId: row.session_id,
		cwd: row.cwd,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function agentFromRow(row: AgentRow): StoredAgent {
	return {
		id: row.id,
		runId: row.run_id,
		parentId: row.parent_id,
		name: row.name,
		status: row.status,
		prompt: row.prompt,
		modelRole: row.model_role,
		workspace: row.workspace,
		depth: row.depth,
		capabilities: parseStringArray(row.capabilities_json),
		result: row.result,
		error: row.error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function messageFromRow(row: MessageRow): StoredMessage {
	return {
		id: row.id,
		runId: row.run_id,
		senderId: row.sender_id,
		recipientId: row.recipient_id,
		body: row.body,
		replyTo: row.reply_to,
		createdAt: row.created_at,
		deliveredAt: row.delivered_at,
	};
}

function artifactFromRow(row: ArtifactRow): StoredArtifact {
	return {
		handle: row.handle,
		runId: row.run_id,
		hash: row.hash,
		mimeType: row.mime_type,
		size: row.size,
		name: row.name,
		path: row.path,
		createdAt: row.created_at,
	};
}

export class RiemannStore {
	readonly root: string;
	readonly snapshotsDir: string;
	readonly artifactsDir: string;
	private readonly db: RiemannDatabase;

	constructor(agentDir: string) {
		this.root = join(agentDir, "state");
		this.snapshotsDir = join(this.root, "snapshots");
		this.artifactsDir = join(agentDir, "artifacts");
		mkdirSync(this.snapshotsDir, { recursive: true, mode: 0o700 });
		mkdirSync(this.artifactsDir, { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(join(this.root, "riemann.db"));
		this.db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;",
		);
		this.migrate();
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
			INSERT INTO schema_version(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
			CREATE TABLE IF NOT EXISTS runs (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL UNIQUE,
				cwd TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active','closed')),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS agents (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				parent_id TEXT REFERENCES agents(id),
				name TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('queued','running','idle','parked','completed','failed','stopped')),
				prompt TEXT NOT NULL,
				model_role TEXT NOT NULL,
				workspace TEXT NOT NULL,
				depth INTEGER NOT NULL,
				capabilities_json TEXT NOT NULL,
				result TEXT,
				error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE(run_id, name)
			);
			CREATE INDEX IF NOT EXISTS agents_run_status ON agents(run_id, status);
			CREATE TABLE IF NOT EXISTS messages (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				sender_id TEXT NOT NULL REFERENCES agents(id),
				recipient_id TEXT NOT NULL REFERENCES agents(id),
				body TEXT NOT NULL,
				reply_to TEXT REFERENCES messages(id),
				created_at TEXT NOT NULL,
				delivered_at TEXT
			);
			CREATE INDEX IF NOT EXISTS messages_recipient_delivery ON messages(recipient_id, delivered_at, created_at);
			CREATE TABLE IF NOT EXISTS artifacts (
				handle TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				hash TEXT NOT NULL,
				mime_type TEXT NOT NULL,
				size INTEGER NOT NULL,
				name TEXT,
				path TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS file_capabilities (
				token_hash TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				path TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS retention_runs (
				run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
				created_at TEXT NOT NULL
			);
		`);
	}

	openRun(sessionId: string, cwd: string): StoredRun {
		const existing = this.db.prepare("SELECT * FROM runs WHERE session_id = ?").get(sessionId) as RunRow | undefined;
		const timestamp = now();
		if (existing) {
			const updated = this.db
				.prepare(
					"UPDATE runs SET cwd = ?, status = 'active', updated_at = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM retention_runs WHERE run_id = ?)",
				)
				.run(cwd, timestamp, existing.id, existing.id);
			if (updated.changes === 0) throw new Error(`Run ${existing.id} is being removed by retention`);
			return { ...runFromRow(existing), cwd, status: "active", updatedAt: timestamp };
		}
		const run: StoredRun = {
			id: randomUUID(),
			sessionId,
			cwd,
			status: "active",
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		this.db
			.prepare("INSERT INTO runs(id, session_id, cwd, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)")
			.run(run.id, run.sessionId, run.cwd, run.status, run.createdAt, run.updatedAt);
		return run;
	}

	closeRun(runId: string): void {
		this.db.prepare("UPDATE runs SET status = 'closed', updated_at = ? WHERE id = ?").run(now(), runId);
	}

	ensureRootAgent(runId: string, cwd: string): StoredAgent {
		const existing = this.db.prepare("SELECT * FROM agents WHERE run_id = ? AND parent_id IS NULL").get(runId) as
			| AgentRow
			| undefined;
		if (existing) return agentFromRow(existing);
		return this.createAgent({
			runId,
			parentId: null,
			name: "Main",
			status: "running",
			prompt: "",
			modelRole: "main",
			workspace: cwd,
			depth: 0,
			capabilities: ["*"],
		});
	}

	createAgent(input: {
		runId: string;
		parentId: string | null;
		name: string;
		status: AgentStatus;
		prompt: string;
		modelRole: string;
		workspace: string;
		depth: number;
		capabilities: string[];
	}): StoredAgent {
		const timestamp = now();
		const agent: StoredAgent = {
			id: randomUUID(),
			...input,
			result: null,
			error: null,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		this.db
			.prepare(
				"INSERT INTO agents(id, run_id, parent_id, name, status, prompt, model_role, workspace, depth, capabilities_json, result, error, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
			)
			.run(
				agent.id,
				agent.runId,
				agent.parentId,
				agent.name,
				agent.status,
				agent.prompt,
				agent.modelRole,
				agent.workspace,
				agent.depth,
				JSON.stringify(agent.capabilities),
				agent.createdAt,
				agent.updatedAt,
			);
		return agent;
	}

	getAgent(id: string): StoredAgent | undefined {
		const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
		return row ? agentFromRow(row) : undefined;
	}

	listAgents(runId: string): StoredAgent[] {
		const rows = this.db.prepare("SELECT * FROM agents WHERE run_id = ? ORDER BY created_at, id").all(runId);
		return rows.map((row) => agentFromRow(row as unknown as AgentRow));
	}

	updateAgent(
		id: string,
		patch: { status?: AgentStatus; result?: string | null; error?: string | null; workspace?: string },
	): StoredAgent {
		const current = this.getAgent(id);
		if (!current) throw new Error(`Agent not found: ${id}`);
		const status = patch.status ?? current.status;
		const result = patch.result === undefined ? current.result : patch.result;
		const error = patch.error === undefined ? current.error : patch.error;
		const workspace = patch.workspace ?? current.workspace;
		const updatedAt = now();
		this.db
			.prepare("UPDATE agents SET status = ?, result = ?, error = ?, workspace = ?, updated_at = ? WHERE id = ?")
			.run(status, result, error, workspace, updatedAt, id);
		return { ...current, status, result, error, workspace, updatedAt };
	}

	markInterruptedAgents(runId: string): void {
		this.db
			.prepare(
				"UPDATE agents SET status = 'parked', error = COALESCE(error, 'host process interrupted'), updated_at = ? WHERE run_id = ? AND status IN ('queued','running','idle') AND parent_id IS NOT NULL",
			)
			.run(now(), runId);
	}

	sendMessage(input: {
		runId: string;
		senderId: string;
		recipientId: string;
		body: string;
		replyTo?: string;
	}): StoredMessage {
		const message: StoredMessage = {
			id: randomUUID(),
			runId: input.runId,
			senderId: input.senderId,
			recipientId: input.recipientId,
			body: input.body,
			replyTo: input.replyTo ?? null,
			createdAt: now(),
			deliveredAt: null,
		};
		this.db
			.prepare(
				"INSERT INTO messages(id, run_id, sender_id, recipient_id, body, reply_to, created_at, delivered_at) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)",
			)
			.run(
				message.id,
				message.runId,
				message.senderId,
				message.recipientId,
				message.body,
				message.replyTo,
				message.createdAt,
			);
		return message;
	}

	listInbox(recipientId: string, options: { unreadOnly?: boolean; markDelivered?: boolean } = {}): StoredMessage[] {
		const sql = options.unreadOnly
			? "SELECT * FROM messages WHERE recipient_id = ? AND delivered_at IS NULL ORDER BY created_at, id"
			: "SELECT * FROM messages WHERE recipient_id = ? ORDER BY created_at, id";
		const messages = this.db
			.prepare(sql)
			.all(recipientId)
			.map((row) => messageFromRow(row as unknown as MessageRow));
		if (options.markDelivered && messages.length > 0) {
			const deliveredAt = now();
			const statement = this.db.prepare(
				"UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL",
			);
			this.db.exec("BEGIN IMMEDIATE");
			try {
				for (const message of messages) statement.run(deliveredAt, message.id);
				this.db.exec("COMMIT");
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			}
			return messages.map((message) => ({ ...message, deliveredAt: message.deliveredAt ?? deliveredAt }));
		}
		return messages;
	}

	putFileCapability(input: { runId: string; token: string; path: string; contentHash: string }): void {
		const tokenHash = createHash("sha256").update(input.token).digest("hex");
		this.db
			.prepare(
				"INSERT OR REPLACE INTO file_capabilities(token_hash, run_id, path, content_hash, created_at) VALUES(?, ?, ?, ?, ?)",
			)
			.run(tokenHash, input.runId, input.path, input.contentHash, now());
	}

	getFileCapability(runId: string, token: string): { path: string; contentHash: string } | undefined {
		const tokenHash = createHash("sha256").update(token).digest("hex");
		const row = this.db
			.prepare("SELECT path, content_hash FROM file_capabilities WHERE token_hash = ? AND run_id = ?")
			.get(tokenHash, runId) as { path: string; content_hash: string } | undefined;
		return row ? { path: row.path, contentHash: row.content_hash } : undefined;
	}

	putArtifact(artifact: StoredArtifact): void {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO artifacts(handle, run_id, hash, mime_type, size, name, path, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				artifact.handle,
				artifact.runId,
				artifact.hash,
				artifact.mimeType,
				artifact.size,
				artifact.name,
				artifact.path,
				artifact.createdAt,
			);
	}

	getArtifact(handle: string): StoredArtifact | undefined {
		const row = this.db.prepare("SELECT * FROM artifacts WHERE handle = ?").get(handle) as ArtifactRow | undefined;
		return row ? artifactFromRow(row) : undefined;
	}

	listRuns(): StoredRun[] {
		const rows = this.db.prepare("SELECT * FROM runs ORDER BY updated_at, id").all();
		return rows.map((row) => runFromRow(row as unknown as RunRow));
	}

	listArtifacts(runId: string): StoredArtifact[] {
		const rows = this.db.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, handle").all(runId);
		return rows.map((row) => artifactFromRow(row as unknown as ArtifactRow));
	}

	countArtifactPathReferences(path: string, excludingRunId?: string): number {
		const row = (
			excludingRunId
				? this.db
						.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE path = ? AND run_id != ?")
						.get(path, excludingRunId)
				: this.db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE path = ?").get(path)
		) as { count: number };
		return row.count;
	}

	reserveClosedRunForRetention(runId: string): boolean {
		const result = this.db
			.prepare(
				"INSERT OR IGNORE INTO retention_runs(run_id, created_at) SELECT id, ? FROM runs WHERE id = ? AND status = 'closed'",
			)
			.run(now(), runId);
		return result.changes > 0;
	}

	releaseRetentionRun(runId: string): void {
		this.db.prepare("DELETE FROM retention_runs WHERE run_id = ?").run(runId);
	}

	deleteReservedRun(runId: string): boolean {
		const result = this.db
			.prepare(
				"DELETE FROM runs WHERE id = ? AND status = 'closed' AND EXISTS (SELECT 1 FROM retention_runs WHERE run_id = ?)",
			)
			.run(runId, runId);
		return result.changes > 0;
	}

	close(): void {
		this.db.close();
	}
}
