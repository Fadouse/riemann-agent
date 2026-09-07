import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type FilesystemSnapshot, FULL_FILESYSTEM, parseFilesystemSnapshot } from "../access-policy.ts";
import type { EffectiveAgentNetwork } from "../config.ts";
import { DatabaseSync, type RiemannDatabase } from "./database.ts";
import { ReferenceStore } from "./references.ts";

export type AgentStatus = "queued" | "running" | "idle" | "stopped";
export type AgentOutcome = "ok" | "error" | "cancelled";
export type AgentTurnStatus = "queued" | "running" | "settled";
export type AgentDeliveryMode = "notify" | "return";
export type AgentDeliveryMethod = "wait" | "notify" | "return";

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
	workspaceMode: "shared" | "worktree";
	filesystem: FilesystemSnapshot;
	network: EffectiveAgentNetwork;
	depth: number;
	capabilities: string[];
	activeTurnId: string | null;
	lastTurnId: string | null;
	result: string | null;
	error: string | null;
	lastOutcome: AgentOutcome | null;
	transcriptHandle: string | null;
	patchHandle: string | null;
	releasedAt: string | null;
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

export interface AgentEventPayload {
	agentId: string;
	name: string;
	turnId: string;
	outcome: AgentOutcome;
}

export interface StoredAgentEvent {
	id: string;
	runId: string;
	recipientId: string;
	payload: AgentEventPayload;
	createdAt: string;
	deliveredAt: string | null;
}
export interface StoredAgentTurn {
	id: string;
	runId: string;
	agentId: string;
	task: string;
	status: AgentTurnStatus;
	deliveryMode: AgentDeliveryMode;
	deliveredVia: AgentDeliveryMethod | null;
	outcome: AgentOutcome | null;
	result: string | null;
	error: string | null;
	transcriptHandle: string | null;
	patchHandle: string | null;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	deliveredAt: string | null;
	updatedAt: string;
}

export interface AgentCreateInput {
	runId: string;
	parentId: string | null;
	name: string;
	status: AgentStatus;
	prompt: string;
	modelRole: string;
	workspace: string;
	workspaceMode: "shared" | "worktree";
	filesystem: FilesystemSnapshot;
	network: EffectiveAgentNetwork;
	depth: number;
	capabilities: string[];
}
export interface AgentTurnCreateInput {
	agentId: string;
	task: string;
	prompt: string;
	deliveryMode: AgentDeliveryMode;
}

export interface AgentTurnSettlementInput {
	agentId: string;
	turnId: string;
	outcome: AgentOutcome;
	result: string;
	error: string | null;
	transcriptHandle: string | null;
	patchHandle: string | null;
	delivery: AgentDeliveryMethod | "notify";
	event?: {
		recipientId: string;
		payload: AgentEventPayload;
	};
}

export interface AgentTurnSettlement {
	agent: StoredAgent;
	turn: StoredAgentTurn;
	event?: StoredAgentEvent;
}

export type AgentSlotReservation = { ok: true; agent: StoredAgent } | { ok: false; reason: "limit" | "name" };

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
	workspace_mode: "shared" | "worktree";
	filesystem_json: string;
	network: EffectiveAgentNetwork;
	depth: number;
	capabilities_json: string;
	active_turn_id: string | null;
	last_turn_id: string | null;
	result: string | null;
	error: string | null;
	last_outcome: AgentOutcome | null;
	transcript_handle: string | null;
	patch_handle: string | null;
	released_at: string | null;
	created_at: string;
	updated_at: string;
}
interface AgentTurnRow {
	id: string;
	run_id: string;
	agent_id: string;
	task: string;
	status: AgentTurnStatus;
	delivery_mode: AgentDeliveryMode;
	delivered_via: AgentDeliveryMethod | null;
	outcome: AgentOutcome | null;
	result: string | null;
	error: string | null;
	transcript_handle: string | null;
	patch_handle: string | null;
	created_at: string;
	started_at: string | null;
	completed_at: string | null;
	delivered_at: string | null;
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

interface AgentEventRow {
	id: string;
	run_id: string;
	recipient_id: string;
	turn_id: string | null;
	payload_json: string;
	created_at: string;
	delivered_at: string | null;
}

const AGENT_TURNS_SCHEMA_VERSION = 3;
const FILESYSTEM_SCHEMA_VERSION = 4;
const CURRENT_SCHEMA_VERSION = 4;

function now(): string {
	return new Date().toISOString();
}

function parseStringArray(value: string): string[] {
	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
}

function parseAgentEventPayload(value: string): AgentEventPayload {
	const parsed: unknown = JSON.parse(value);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Stored Agent event payload is not an object");
	}
	const record = parsed as Record<string, unknown>;
	if (
		typeof record.agentId !== "string" ||
		typeof record.turnId !== "string" ||
		typeof record.name !== "string" ||
		(record.outcome !== "ok" && record.outcome !== "error" && record.outcome !== "cancelled")
	) {
		throw new Error("Stored Agent event payload is invalid");
	}
	return {
		agentId: record.agentId,
		name: record.name,
		turnId: record.turnId,
		outcome: record.outcome,
	};
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
		workspaceMode: row.workspace_mode,
		filesystem: parseFilesystemSnapshot(row.filesystem_json),
		network: row.network,
		depth: row.depth,
		capabilities: parseStringArray(row.capabilities_json),
		activeTurnId: row.active_turn_id,
		lastTurnId: row.last_turn_id,
		result: row.result,
		error: row.error,
		lastOutcome: row.last_outcome,
		transcriptHandle: row.transcript_handle,
		patchHandle: row.patch_handle,
		releasedAt: row.released_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
function agentTurnFromRow(row: AgentTurnRow): StoredAgentTurn {
	return {
		id: row.id,
		runId: row.run_id,
		agentId: row.agent_id,
		task: row.task,
		status: row.status,
		deliveryMode: row.delivery_mode,
		deliveredVia: row.delivered_via,
		outcome: row.outcome,
		result: row.result,
		error: row.error,
		transcriptHandle: row.transcript_handle,
		patchHandle: row.patch_handle,
		createdAt: row.created_at,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		deliveredAt: row.delivered_at,
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

function agentEventFromRow(row: AgentEventRow): StoredAgentEvent {
	return {
		id: row.id,
		runId: row.run_id,
		recipientId: row.recipient_id,
		payload: parseAgentEventPayload(row.payload_json),
		createdAt: row.created_at,
		deliveredAt: row.delivered_at,
	};
}

export class RiemannStore {
	readonly root: string;
	readonly snapshotsDir: string;
	readonly artifactsDir: string;
	readonly references: ReferenceStore;
	private readonly db: RiemannDatabase;
	private readonly statements = new Map<string, ReturnType<RiemannDatabase["prepare"]>>();

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
		this.references = new ReferenceStore(this.db);
	}

	private prepare(sql: string): ReturnType<RiemannDatabase["prepare"]> {
		let statement = this.statements.get(sql);
		if (!statement) {
			statement = this.db.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
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
				workspace_mode TEXT NOT NULL DEFAULT 'shared',
				filesystem_json TEXT NOT NULL DEFAULT '{}',
				network TEXT NOT NULL DEFAULT 'deny' CHECK(network IN ('allow','deny')),
				depth INTEGER NOT NULL,
				capabilities_json TEXT NOT NULL,
				active_turn_id TEXT,
				last_turn_id TEXT,
				result TEXT,
				error TEXT,
				last_outcome TEXT CHECK(last_outcome IN ('ok','error','cancelled')),
				transcript_handle TEXT,
				patch_handle TEXT,
				released_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE(run_id, name)
			);
			CREATE INDEX IF NOT EXISTS agents_run_status ON agents(run_id, status);
			CREATE TABLE IF NOT EXISTS agent_turns (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
				task TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('queued','running','settled')),
				delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('notify','return')),
				delivered_via TEXT CHECK(delivered_via IN ('wait','notify','return')),
				outcome TEXT CHECK(outcome IN ('ok','error','cancelled')),
				result TEXT,
				error TEXT,
				transcript_handle TEXT,
				patch_handle TEXT,
				created_at TEXT NOT NULL,
				started_at TEXT,
				completed_at TEXT,
				delivered_at TEXT,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS agent_turns_agent_created ON agent_turns(agent_id, created_at, id);
			CREATE INDEX IF NOT EXISTS agent_turns_status ON agent_turns(run_id, status);
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
			CREATE TABLE IF NOT EXISTS agent_events (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				recipient_id TEXT NOT NULL REFERENCES agents(id),
				turn_id TEXT REFERENCES agent_turns(id),
				payload_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				delivered_at TEXT
			);
			CREATE INDEX IF NOT EXISTS agent_events_recipient_delivery
				ON agent_events(recipient_id, delivered_at, created_at);
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
		const schemaVersion = (this.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number })
			.version;
		const agentColumns = this.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
		const hasLegacyPermissions = agentColumns.some((column) => column.name === "permissions");
		const hasFilesystem = agentColumns.some((column) => column.name === "filesystem_json");
		if (!agentColumns.some((column) => column.name === "workspace_mode")) {
			this.db.exec("ALTER TABLE agents ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'shared'");
		}
		if (!agentColumns.some((column) => column.name === "network")) {
			this.db.exec(
				"ALTER TABLE agents ADD COLUMN network TEXT NOT NULL DEFAULT 'deny' CHECK(network IN ('allow','deny'))",
			);
		}
		if (!agentColumns.some((column) => column.name === "last_outcome")) {
			this.db.exec("ALTER TABLE agents ADD COLUMN last_outcome TEXT");
		}
		if (!agentColumns.some((column) => column.name === "transcript_handle")) {
			this.db.exec("ALTER TABLE agents ADD COLUMN transcript_handle TEXT");
		}
		if (!agentColumns.some((column) => column.name === "patch_handle")) {
			this.db.exec("ALTER TABLE agents ADD COLUMN patch_handle TEXT");
		}
		if (!agentColumns.some((column) => column.name === "released_at")) {
			this.db.exec("ALTER TABLE agents ADD COLUMN released_at TEXT");
		}
		if (!agentColumns.some((column) => column.name === "active_turn_id")) {
			this.db.exec("ALTER TABLE agents ADD COLUMN active_turn_id TEXT");
		}
		if (!agentColumns.some((column) => column.name === "last_turn_id")) {
			this.db.exec("ALTER TABLE agents ADD COLUMN last_turn_id TEXT");
		}
		if (!hasFilesystem) {
			this.db.exec("ALTER TABLE agents ADD COLUMN filesystem_json TEXT NOT NULL DEFAULT '{}'");
		}
		if (!hasFilesystem || schemaVersion < FILESYSTEM_SCHEMA_VERSION) {
			const legacy = this.prepare(
				hasLegacyPermissions
					? "SELECT id, permissions, workspace FROM agents"
					: hasFilesystem
						? "SELECT id, NULL AS permissions, workspace FROM agents WHERE filesystem_json = '{}'"
						: "SELECT id, NULL AS permissions, workspace FROM agents",
			).all() as unknown as Array<{ id: string; permissions: string | null; workspace: string }>;
			const update = this.prepare("UPDATE agents SET filesystem_json = ? WHERE id = ?");
			for (const row of legacy) {
				const roots = row.permissions === "host" ? ["/"] : [row.workspace];
				update.run(JSON.stringify({ read: roots, readExclude: [], write: roots, writeExclude: [] }), row.id);
			}
		}
		const eventColumns = this.prepare("PRAGMA table_info(agent_events)").all() as Array<{ name: string }>;
		if (!eventColumns.some((column) => column.name === "turn_id")) {
			this.db.exec("ALTER TABLE agent_events ADD COLUMN turn_id TEXT");
		}
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS agents_parent ON agents(parent_id);
			CREATE INDEX IF NOT EXISTS agents_run_created ON agents(run_id, created_at, id);
			CREATE INDEX IF NOT EXISTS messages_recipient_created ON messages(recipient_id, created_at, id);
			CREATE INDEX IF NOT EXISTS messages_unread_created ON messages(recipient_id, created_at, id)
				WHERE delivered_at IS NULL;
			CREATE INDEX IF NOT EXISTS agent_events_pending_created ON agent_events(recipient_id, created_at, id)
				WHERE delivered_at IS NULL;
			CREATE INDEX IF NOT EXISTS messages_run ON messages(run_id);
			CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender_id);
			CREATE INDEX IF NOT EXISTS messages_reply ON messages(reply_to);
			CREATE INDEX IF NOT EXISTS agent_events_run ON agent_events(run_id);
			CREATE INDEX IF NOT EXISTS agent_events_turn ON agent_events(turn_id);
			CREATE INDEX IF NOT EXISTS artifacts_run_created ON artifacts(run_id, created_at, handle);
			CREATE INDEX IF NOT EXISTS artifacts_path_run ON artifacts(path, run_id);
			CREATE INDEX IF NOT EXISTS file_capabilities_run ON file_capabilities(run_id);
		`);
		if (schemaVersion < AGENT_TURNS_SCHEMA_VERSION) {
			this.db.exec(`
				UPDATE agents
				SET
					last_outcome = CASE
						WHEN status = 'completed' THEN COALESCE(last_outcome, 'ok')
						WHEN status = 'failed' THEN COALESCE(last_outcome, 'error')
						WHEN status = 'parked' THEN COALESCE(last_outcome, 'cancelled')
						ELSE last_outcome
					END,
					status = CASE
						WHEN status IN ('completed', 'failed') THEN 'idle'
						WHEN status = 'parked' THEN 'stopped'
						ELSE status
					END;
			`);
			this.backfillAgentTurns();
		}
		if (schemaVersion < FILESYSTEM_SCHEMA_VERSION && hasLegacyPermissions) {
			this.db.exec("ALTER TABLE agents DROP COLUMN permissions");
		}
		if (schemaVersion < CURRENT_SCHEMA_VERSION) {
			this.prepare("UPDATE schema_version SET version = ?").run(CURRENT_SCHEMA_VERSION);
		}
	}

	private backfillAgentTurns(): void {
		const agents = this.prepare("SELECT * FROM agents WHERE parent_id IS NOT NULL").all() as unknown as AgentRow[];
		const events = this.prepare(
			"SELECT * FROM agent_events ORDER BY created_at, id",
		).all() as unknown as AgentEventRow[];
		const eventAgentIds = new Map<string, string>();
		const pendingEventAgentIds = new Set<string>();
		for (const event of events) {
			const parsed: unknown = JSON.parse(event.payload_json);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
			const agentId = (parsed as Record<string, unknown>).agentId;
			if (typeof agentId !== "string") continue;
			eventAgentIds.set(event.id, agentId);
			if (event.delivered_at === null) pendingEventAgentIds.add(agentId);
		}
		const turnIds = new Map<string, string>();
		const existingTurns = this.prepare(
			"SELECT agent_id, id FROM agent_turns ORDER BY created_at, id",
		).all() as Array<{ agent_id: string; id: string }>;
		for (const turn of existingTurns) turnIds.set(turn.agent_id, turn.id);

		this.db.exec("BEGIN IMMEDIATE");
		try {
			const insertTurn = this.prepare(
				"INSERT INTO agent_turns(id, run_id, agent_id, task, status, delivery_mode, delivered_via, outcome, result, error, transcript_handle, patch_handle, created_at, started_at, completed_at, delivered_at, updated_at) VALUES(?, ?, ?, ?, ?, 'notify', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			);
			const updateAgent = this.prepare("UPDATE agents SET active_turn_id = ?, last_turn_id = ? WHERE id = ?");
			for (const row of agents) {
				let turnId = turnIds.get(row.id);
				const active = row.status === "queued" || row.status === "running";
				if (!turnId) {
					turnId = randomUUID();
					const pendingEvent = pendingEventAgentIds.has(row.id);
					const outcome: AgentOutcome | null = active
						? null
						: (row.last_outcome ?? (row.status === "stopped" ? "cancelled" : row.error ? "error" : "ok"));
					const deliveredVia: AgentDeliveryMethod | null = active || pendingEvent ? null : "notify";
					insertTurn.run(
						turnId,
						row.run_id,
						row.id,
						row.prompt,
						active ? row.status : "settled",
						deliveredVia,
						outcome,
						row.result,
						row.error,
						row.transcript_handle,
						row.patch_handle,
						row.created_at,
						row.created_at,
						active ? null : row.updated_at,
						deliveredVia ? row.updated_at : null,
						row.updated_at,
					);
					turnIds.set(row.id, turnId);
				}
				updateAgent.run(active ? turnId : null, turnId, row.id);
			}

			const updateEvent = this.prepare("UPDATE agent_events SET turn_id = ?, payload_json = ? WHERE id = ?");
			for (const event of events) {
				const agentId = eventAgentIds.get(event.id);
				const turnId = agentId ? turnIds.get(agentId) : undefined;
				if (!turnId) continue;
				const parsed = JSON.parse(event.payload_json) as Record<string, unknown>;
				parsed.turnId = turnId;
				updateEvent.run(turnId, JSON.stringify(parsed), event.id);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	openRun(sessionId: string, cwd: string): StoredRun {
		const existing = this.prepare("SELECT * FROM runs WHERE session_id = ?").get(sessionId) as RunRow | undefined;
		const timestamp = now();
		if (existing) {
			const updated = this.prepare(
				"UPDATE runs SET cwd = ?, status = 'active', updated_at = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM retention_runs WHERE run_id = ?)",
			).run(cwd, timestamp, existing.id, existing.id);
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
		this.prepare(
			"INSERT INTO runs(id, session_id, cwd, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
		).run(run.id, run.sessionId, run.cwd, run.status, run.createdAt, run.updatedAt);
		return run;
	}

	closeRun(runId: string): void {
		this.prepare("UPDATE runs SET status = 'closed', updated_at = ? WHERE id = ?").run(now(), runId);
	}

	ensureRootAgent(
		runId: string,
		cwd: string,
		filesystem: FilesystemSnapshot = FULL_FILESYSTEM,
		network: EffectiveAgentNetwork = "deny",
	): StoredAgent {
		const existing = this.prepare("SELECT * FROM agents WHERE run_id = ? AND parent_id IS NULL").get(runId) as
			| AgentRow
			| undefined;
		if (existing) {
			const agent = agentFromRow(existing);
			return JSON.stringify(agent.filesystem) === JSON.stringify(filesystem) && agent.network === network
				? agent
				: this.updateAgent(agent.id, { filesystem, network });
		}
		return this.createAgent({
			runId,
			parentId: null,
			name: "Main",
			status: "running",
			prompt: "",
			modelRole: "main",
			workspace: cwd,
			workspaceMode: "shared",
			filesystem,
			network,
			depth: 0,
			capabilities: ["*"],
		});
	}

	createAgent(input: AgentCreateInput): StoredAgent {
		const timestamp = now();
		const agent: StoredAgent = {
			id: randomUUID(),
			...input,
			activeTurnId: null,
			lastTurnId: null,
			result: null,
			error: null,
			lastOutcome: null,
			transcriptHandle: null,
			patchHandle: null,
			releasedAt: null,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		this.prepare(
			"INSERT INTO agents(id, run_id, parent_id, name, status, prompt, model_role, workspace, workspace_mode, filesystem_json, network, depth, capabilities_json, active_turn_id, last_turn_id, result, error, last_outcome, transcript_handle, patch_handle, released_at, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)",
		).run(
			agent.id,
			agent.runId,
			agent.parentId,
			agent.name,
			agent.status,
			agent.prompt,
			agent.modelRole,
			agent.workspace,
			agent.workspaceMode,
			JSON.stringify(agent.filesystem),
			agent.network,
			agent.depth,
			JSON.stringify(agent.capabilities),
			agent.createdAt,
			agent.updatedAt,
		);
		return agent;
	}

	reserveAgentSlot(input: AgentCreateInput, maxAgents: number): AgentSlotReservation {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.prepare("SELECT * FROM agents WHERE run_id = ? AND name = ?").get(
				input.runId,
				input.name,
			) as AgentRow | undefined;
			if (existing && existing.released_at === null) {
				this.db.exec("ROLLBACK");
				return { ok: false, reason: "name" };
			}
			const count = this.prepare(
				"SELECT COUNT(*) AS count FROM agents WHERE run_id = ? AND parent_id IS NOT NULL AND released_at IS NULL",
			).get(input.runId) as { count: number };
			if (count.count >= maxAgents) {
				this.db.exec("ROLLBACK");
				return { ok: false, reason: "limit" };
			}
			if (existing) {
				this.prepare("UPDATE agents SET name = ?, updated_at = ? WHERE id = ?").run(
					`${existing.name}~released-${existing.id.slice(0, 8)}`,
					now(),
					existing.id,
				);
			}
			const agent = this.createAgent(input);
			this.db.exec("COMMIT");
			return { ok: true, agent };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	getAgent(id: string): StoredAgent | undefined {
		const row = this.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
		return row ? agentFromRow(row) : undefined;
	}

	listAgents(runId: string, options: { includeReleased?: boolean } = {}): StoredAgent[] {
		const rows = (
			options.includeReleased
				? this.prepare("SELECT * FROM agents WHERE run_id = ? ORDER BY created_at, id")
				: this.prepare("SELECT * FROM agents WHERE run_id = ? AND released_at IS NULL ORDER BY created_at, id")
		).all(runId);
		return rows.map((row) => agentFromRow(row as unknown as AgentRow));
	}

	getAgentTurn(id: string): StoredAgentTurn | undefined {
		const row = this.prepare("SELECT * FROM agent_turns WHERE id = ?").get(id) as AgentTurnRow | undefined;
		return row ? agentTurnFromRow(row) : undefined;
	}

	listAgentTurns(agentId: string): StoredAgentTurn[] {
		const rows = this.prepare("SELECT * FROM agent_turns WHERE agent_id = ? ORDER BY created_at, id").all(agentId);
		return rows.map((row) => agentTurnFromRow(row as unknown as AgentTurnRow));
	}

	startAgentTurn(input: AgentTurnCreateInput): { agent: StoredAgent; turn: StoredAgentTurn } {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.prepare("SELECT * FROM agents WHERE id = ?").get(input.agentId) as AgentRow | undefined;
			if (!row) throw new Error(`Agent not found: ${input.agentId}`);
			if (row.released_at !== null) throw new Error(`Agent is released: ${row.name}`);
			if (
				row.active_turn_id !== null ||
				(row.status !== "idle" && row.status !== "stopped" && row.last_turn_id !== null)
			) {
				throw new Error(`Agent already has an active Turn: ${row.name}`);
			}
			const timestamp = now();
			const turn: StoredAgentTurn = {
				id: randomUUID(),
				runId: row.run_id,
				agentId: row.id,
				task: input.task,
				status: "queued",
				deliveryMode: input.deliveryMode,
				deliveredVia: null,
				outcome: null,
				result: null,
				error: null,
				transcriptHandle: null,
				patchHandle: null,
				createdAt: timestamp,
				startedAt: null,
				completedAt: null,
				deliveredAt: null,
				updatedAt: timestamp,
			};
			this.prepare(
				"INSERT INTO agent_turns(id, run_id, agent_id, task, status, delivery_mode, delivered_via, outcome, result, error, transcript_handle, patch_handle, created_at, started_at, completed_at, delivered_at, updated_at) VALUES(?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?)",
			).run(turn.id, turn.runId, turn.agentId, turn.task, turn.deliveryMode, turn.createdAt, turn.updatedAt);
			this.prepare(
				"UPDATE agents SET status = 'queued', prompt = ?, active_turn_id = ?, last_turn_id = ?, result = NULL, error = NULL, last_outcome = NULL, transcript_handle = NULL, patch_handle = NULL, updated_at = ? WHERE id = ?",
			).run(input.prompt, turn.id, turn.id, timestamp, row.id);
			const agent = this.getAgent(row.id);
			if (!agent) throw new Error(`Agent disappeared while starting a Turn: ${row.id}`);
			this.db.exec("COMMIT");
			return { agent, turn };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	markAgentTurnRunning(agentId: string, turnId: string): StoredAgentTurn {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.prepare("SELECT * FROM agent_turns WHERE id = ?").get(turnId) as AgentTurnRow | undefined;
			if (!row || row.agent_id !== agentId) throw new Error(`Agent Turn not found: ${turnId}`);
			if (row.status === "settled") throw new Error(`Agent Turn is already settled: ${turnId}`);
			const agent = this.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
			if (!agent || agent.active_turn_id !== turnId) throw new Error(`Agent Turn is no longer active: ${turnId}`);
			const timestamp = now();
			this.prepare(
				"UPDATE agent_turns SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
			).run(timestamp, timestamp, turnId);
			this.prepare("UPDATE agents SET status = 'running', updated_at = ? WHERE id = ?").run(timestamp, agentId);
			const updated = this.getAgentTurn(turnId);
			if (!updated) throw new Error(`Agent Turn disappeared while starting: ${turnId}`);
			this.db.exec("COMMIT");
			return updated;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	settleAgentTurn(input: AgentTurnSettlementInput): AgentTurnSettlement {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.prepare("SELECT * FROM agent_turns WHERE id = ?").get(input.turnId) as
				| AgentTurnRow
				| undefined;
			if (!row || row.agent_id !== input.agentId) throw new Error(`Agent Turn not found: ${input.turnId}`);
			const agentRow = this.prepare("SELECT * FROM agents WHERE id = ?").get(input.agentId) as AgentRow | undefined;
			if (!agentRow) throw new Error(`Agent not found: ${input.agentId}`);
			if (row.status === "settled") {
				const existingEvent = this.prepare("SELECT * FROM agent_events WHERE turn_id = ?").get(input.turnId) as
					| AgentEventRow
					| undefined;
				this.db.exec("COMMIT");
				return {
					agent: agentFromRow(agentRow),
					turn: agentTurnFromRow(row),
					...(existingEvent ? { event: agentEventFromRow(existingEvent) } : {}),
				};
			}
			if (agentRow.active_turn_id !== input.turnId) {
				throw new Error(`Agent Turn is no longer active: ${input.turnId}`);
			}
			const timestamp = now();
			const deliveredVia = input.delivery === "notify" ? null : input.delivery;
			this.prepare(
				"UPDATE agent_turns SET status = 'settled', delivered_via = ?, outcome = ?, result = ?, error = ?, transcript_handle = ?, patch_handle = ?, started_at = COALESCE(started_at, created_at), completed_at = ?, delivered_at = ?, updated_at = ? WHERE id = ?",
			).run(
				deliveredVia,
				input.outcome,
				input.result,
				input.error,
				input.transcriptHandle,
				input.patchHandle,
				timestamp,
				deliveredVia ? timestamp : null,
				timestamp,
				input.turnId,
			);
			this.prepare(
				"UPDATE agents SET status = ?, active_turn_id = NULL, last_turn_id = ?, result = ?, error = ?, last_outcome = ?, transcript_handle = ?, patch_handle = ?, updated_at = ? WHERE id = ?",
			).run(
				input.outcome === "cancelled" ? "stopped" : "idle",
				input.turnId,
				input.result,
				input.error,
				input.outcome,
				input.transcriptHandle,
				input.patchHandle,
				timestamp,
				input.agentId,
			);
			let event: StoredAgentEvent | undefined;
			if (input.delivery === "notify") {
				if (!input.event || input.event.payload.turnId !== input.turnId) {
					throw new Error(`Notify settlement requires a matching event payload: ${input.turnId}`);
				}
				event = {
					id: randomUUID(),
					runId: row.run_id,
					recipientId: input.event.recipientId,
					payload: input.event.payload,
					createdAt: timestamp,
					deliveredAt: null,
				};
				this.prepare(
					"INSERT INTO agent_events(id, run_id, recipient_id, turn_id, payload_json, created_at, delivered_at) VALUES(?, ?, ?, ?, ?, ?, NULL)",
				).run(
					event.id,
					event.runId,
					event.recipientId,
					input.turnId,
					JSON.stringify(event.payload),
					event.createdAt,
				);
			}
			const agent = this.getAgent(input.agentId);
			const turn = this.getAgentTurn(input.turnId);
			if (!agent || !turn) throw new Error(`Agent Turn disappeared while settling: ${input.turnId}`);
			this.db.exec("COMMIT");
			return { agent, turn, ...(event ? { event } : {}) };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	claimAgentTurnForWait(agentId: string, turnId: string): StoredAgentTurn {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.prepare("SELECT * FROM agent_turns WHERE id = ?").get(turnId) as AgentTurnRow | undefined;
			if (!row || row.agent_id !== agentId) throw new Error(`Agent Turn not found: ${turnId}`);
			if (row.status === "settled" && row.delivered_via === null) {
				const timestamp = now();
				this.prepare("UPDATE agent_events SET delivered_at = ? WHERE turn_id = ? AND delivered_at IS NULL").run(
					timestamp,
					turnId,
				);
				this.prepare(
					"UPDATE agent_turns SET delivered_via = 'wait', delivered_at = ?, updated_at = ? WHERE id = ? AND delivered_via IS NULL",
				).run(timestamp, timestamp, turnId);
			}
			const turn = this.getAgentTurn(turnId);
			if (!turn) throw new Error(`Agent Turn disappeared while claiming: ${turnId}`);
			this.db.exec("COMMIT");
			return turn;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	updateAgent(
		id: string,
		patch: {
			status?: AgentStatus;
			prompt?: string;
			result?: string | null;
			error?: string | null;
			lastOutcome?: AgentOutcome | null;
			transcriptHandle?: string | null;
			patchHandle?: string | null;
			workspace?: string;
			filesystem?: FilesystemSnapshot;
			network?: EffectiveAgentNetwork;
		},
	): StoredAgent {
		const current = this.getAgent(id);
		if (!current) throw new Error(`Agent not found: ${id}`);
		const status = patch.status ?? current.status;
		const prompt = patch.prompt ?? current.prompt;
		const result = patch.result === undefined ? current.result : patch.result;
		const error = patch.error === undefined ? current.error : patch.error;
		const lastOutcome = patch.lastOutcome === undefined ? current.lastOutcome : patch.lastOutcome;
		const transcriptHandle = patch.transcriptHandle === undefined ? current.transcriptHandle : patch.transcriptHandle;
		const patchHandle = patch.patchHandle === undefined ? current.patchHandle : patch.patchHandle;
		const workspace = patch.workspace ?? current.workspace;
		const filesystem = patch.filesystem === undefined ? current.filesystem : patch.filesystem;
		const network = patch.network ?? current.network;
		const updatedAt = now();
		const fields: Array<[column: string, value: string | null]> = [["updated_at", updatedAt]];
		if (status !== current.status) fields.push(["status", status]);
		if (prompt !== current.prompt) fields.push(["prompt", prompt]);
		if (result !== current.result) fields.push(["result", result]);
		if (error !== current.error) fields.push(["error", error]);
		if (lastOutcome !== current.lastOutcome) fields.push(["last_outcome", lastOutcome]);
		if (transcriptHandle !== current.transcriptHandle) fields.push(["transcript_handle", transcriptHandle]);
		if (patchHandle !== current.patchHandle) fields.push(["patch_handle", patchHandle]);
		if (workspace !== current.workspace) fields.push(["workspace", workspace]);
		if (patch.filesystem !== undefined) fields.push(["filesystem_json", JSON.stringify(filesystem)]);
		if (network !== current.network) fields.push(["network", network]);
		// Column names come only from the fixed list above; all values stay bound.
		this.prepare(`UPDATE agents SET ${fields.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`).run(
			...fields.map(([, value]) => value),
			id,
		);
		return {
			...current,
			status,
			prompt,
			result,
			error,
			lastOutcome,
			transcriptHandle,
			patchHandle,
			workspace,
			filesystem,
			network,
			updatedAt,
		};
	}

	releaseAgent(id: string): StoredAgent {
		const current = this.getAgent(id);
		if (!current) throw new Error(`Agent not found: ${id}`);
		const releasedAt = now();
		this.prepare("UPDATE agents SET released_at = ?, updated_at = ? WHERE id = ?").run(releasedAt, releasedAt, id);
		return { ...current, releasedAt, updatedAt: releasedAt };
	}

	markInterruptedAgents(runId: string): void {
		const timestamp = now();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.prepare(
				"UPDATE agent_turns SET status = 'settled', delivered_via = COALESCE(delivered_via, 'return'), outcome = 'cancelled', error = COALESCE(error, 'host process interrupted'), completed_at = COALESCE(completed_at, ?), delivered_at = COALESCE(delivered_at, ?), updated_at = ? WHERE run_id = ? AND status IN ('queued','running')",
			).run(timestamp, timestamp, timestamp, runId);
			this.prepare(
				"UPDATE agents SET status = 'stopped', active_turn_id = NULL, last_outcome = 'cancelled', error = COALESCE(error, 'host process interrupted'), updated_at = ? WHERE run_id = ? AND (status IN ('queued','running') OR (status = 'stopped' AND active_turn_id IS NOT NULL)) AND parent_id IS NOT NULL",
			).run(timestamp, runId);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
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
		this.prepare(
			"INSERT INTO messages(id, run_id, sender_id, recipient_id, body, reply_to, created_at, delivered_at) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)",
		).run(
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
		const messages = this.prepare(sql)
			.all(recipientId)
			.map((row) => messageFromRow(row as unknown as MessageRow));
		if (options.markDelivered && messages.length > 0) {
			const deliveredAt = now();
			const statement = this.prepare("UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL");
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

	markMessageDelivered(id: string): void {
		this.prepare("UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL").run(now(), id);
	}

	enqueueAgentEvent(input: { runId: string; recipientId: string; payload: AgentEventPayload }): StoredAgentEvent {
		const event: StoredAgentEvent = {
			id: randomUUID(),
			runId: input.runId,
			recipientId: input.recipientId,
			payload: input.payload,
			createdAt: now(),
			deliveredAt: null,
		};
		this.prepare(
			"INSERT INTO agent_events(id, run_id, recipient_id, turn_id, payload_json, created_at, delivered_at) VALUES(?, ?, ?, ?, ?, ?, NULL)",
		).run(
			event.id,
			event.runId,
			event.recipientId,
			event.payload.turnId,
			JSON.stringify(event.payload),
			event.createdAt,
		);
		return event;
	}

	listPendingAgentEvents(recipientId: string): StoredAgentEvent[] {
		const rows = this.prepare(
			"SELECT * FROM agent_events WHERE recipient_id = ? AND delivered_at IS NULL ORDER BY created_at, id",
		).all(recipientId);
		return rows.map((row) => agentEventFromRow(row as unknown as AgentEventRow));
	}

	markAgentEventsDelivered(ids: readonly string[]): void {
		if (ids.length === 0) return;
		const deliveredAt = now();
		const eventStatement = this.prepare(
			"UPDATE agent_events SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL",
		);
		const turnStatement = this.prepare(
			"UPDATE agent_turns SET delivered_via = 'notify', delivered_at = ?, updated_at = ? WHERE id = ? AND delivered_via IS NULL",
		);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const id of ids) {
				const event = this.prepare("SELECT turn_id FROM agent_events WHERE id = ?").get(id) as
					| { turn_id: string | null }
					| undefined;
				const updated = eventStatement.run(deliveredAt, id);
				if (updated.changes > 0 && event?.turn_id) {
					turnStatement.run(deliveredAt, deliveredAt, event.turn_id);
				}
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	putFileCapability(input: { runId: string; token: string; path: string; contentHash: string }): void {
		const tokenHash = createHash("sha256").update(input.token).digest("hex");
		this.prepare(
			"INSERT OR REPLACE INTO file_capabilities(token_hash, run_id, path, content_hash, created_at) VALUES(?, ?, ?, ?, ?)",
		).run(tokenHash, input.runId, input.path, input.contentHash, now());
	}

	getFileCapability(runId: string, token: string): { path: string; contentHash: string } | undefined {
		const tokenHash = createHash("sha256").update(token).digest("hex");
		const row = this.prepare(
			"SELECT path, content_hash FROM file_capabilities WHERE token_hash = ? AND run_id = ?",
		).get(tokenHash, runId) as { path: string; content_hash: string } | undefined;
		return row ? { path: row.path, contentHash: row.content_hash } : undefined;
	}

	putArtifact(artifact: StoredArtifact): void {
		this.prepare(
			"INSERT INTO artifacts(handle, run_id, hash, mime_type, size, name, path, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(handle) DO UPDATE SET run_id = excluded.run_id, hash = excluded.hash, mime_type = excluded.mime_type, size = excluded.size, name = excluded.name, path = excluded.path, created_at = excluded.created_at",
		).run(
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
		const row = this.prepare("SELECT * FROM artifacts WHERE handle = ?").get(handle) as ArtifactRow | undefined;
		return row ? artifactFromRow(row) : undefined;
	}

	listRuns(): StoredRun[] {
		const rows = this.prepare("SELECT * FROM runs ORDER BY updated_at, id").all();
		return rows.map((row) => runFromRow(row as unknown as RunRow));
	}

	listArtifacts(runId: string): StoredArtifact[] {
		const rows = this.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, handle").all(runId);
		return rows.map((row) => artifactFromRow(row as unknown as ArtifactRow));
	}

	countArtifactPathReferences(path: string, excludingRunId?: string): number {
		const row = (
			excludingRunId
				? this.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE path = ? AND run_id != ?").get(
						path,
						excludingRunId,
					)
				: this.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE path = ?").get(path)
		) as { count: number };
		return row.count;
	}

	reserveClosedRunForRetention(runId: string): boolean {
		const result = this.prepare(
			"INSERT OR IGNORE INTO retention_runs(run_id, created_at) SELECT id, ? FROM runs WHERE id = ? AND status = 'closed'",
		).run(now(), runId);
		return result.changes > 0;
	}

	releaseRetentionRun(runId: string): void {
		this.prepare("DELETE FROM retention_runs WHERE run_id = ?").run(runId);
	}

	deleteReservedRun(runId: string): boolean {
		const result = this.prepare(
			"DELETE FROM runs WHERE id = ? AND status = 'closed' AND EXISTS (SELECT 1 FROM retention_runs WHERE run_id = ?)",
		).run(runId, runId);
		return result.changes > 0;
	}

	close(): void {
		this.statements.clear();
		this.db.close();
	}
}
