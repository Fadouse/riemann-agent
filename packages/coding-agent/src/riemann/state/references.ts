import { RiemannHostError } from "../errors.ts";
import type { RiemannDatabase } from "./database.ts";

export const PAGE_MANIFEST_MIME = "application/vnd.riemann.page+json";
export const PAGE_CURSOR_MIME = "application/vnd.riemann.page-cursor+json";
export const OUTPUT_VIEW_MIME = "application/vnd.riemann.output+json";
export const RESULT_MIME = "application/vnd.riemann.result+json";
export type ResourceKind = "artifact" | "page_snapshot" | "page_cursor" | "internal";

export interface StoredReference {
	runId: string;
	shortRef: string;
	resourceId: string;
	kind: ResourceKind;
}

export function resourceKind(mimeType: string): ResourceKind {
	const mediaType = mimeType.split(";", 1)[0].trim().toLowerCase();
	if (mediaType === PAGE_MANIFEST_MIME) return "page_snapshot";
	if (mediaType === PAGE_CURSOR_MIME) return "page_cursor";
	if (mediaType.startsWith("application/vnd.riemann.") && mediaType.endsWith("+json")) return "internal";
	return "artifact";
}

/** Short names identify resources; only persisted grants authorize model access. */
export class ReferenceStore {
	private readonly db: RiemannDatabase;

	constructor(db: RiemannDatabase) {
		this.db = db;
		db.exec(`
			CREATE TABLE IF NOT EXISTS reference_sequences (
				run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
				next_number INTEGER NOT NULL CHECK(next_number > 0)
			);
			CREATE TABLE IF NOT EXISTS resource_references (
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				short_ref TEXT NOT NULL,
				resource_id TEXT NOT NULL REFERENCES artifacts(handle) ON DELETE CASCADE,
				kind TEXT NOT NULL CHECK(kind IN ('artifact','page_snapshot','page_cursor','internal')),
				PRIMARY KEY(run_id, short_ref),
				UNIQUE(run_id, resource_id)
			);
			CREATE INDEX IF NOT EXISTS resource_references_resource ON resource_references(resource_id);
			CREATE TABLE IF NOT EXISTS reference_grants (
				run_id TEXT NOT NULL,
				short_ref TEXT NOT NULL,
				agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
				PRIMARY KEY(run_id, short_ref, agent_id),
				FOREIGN KEY(run_id, short_ref) REFERENCES resource_references(run_id, short_ref) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS reference_grants_agent ON reference_grants(agent_id, run_id);
		`);
	}

	private transaction<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	assertAgent(runId: string, agentId: string): void {
		if (!this.db.prepare("SELECT 1 FROM agents WHERE id = ? AND run_id = ?").get(agentId, runId)) {
			throw new RiemannHostError("not_found", "Agent is not present in this run");
		}
	}

	issue(runId: string, resourceId: string, kind: ResourceKind, agentId?: string): StoredReference {
		return this.transaction(() => {
			if (!this.db.prepare("SELECT 1 FROM artifacts WHERE handle = ? AND run_id = ?").get(resourceId, runId)) {
				throw new RiemannHostError("not_found", "Resource is not present in this run");
			}
			if (agentId !== undefined) this.assertAgent(runId, agentId);
			let reference = this.db
				.prepare(
					"SELECT run_id AS runId, short_ref AS shortRef, resource_id AS resourceId, kind FROM resource_references WHERE run_id = ? AND resource_id = ?",
				)
				.get(runId, resourceId) as unknown as StoredReference | undefined;
			if (reference && reference.kind !== kind) {
				throw new RiemannHostError("conflict", "Resource reference kind changed");
			}
			if (!reference) {
				this.db
					.prepare(
						"INSERT INTO reference_sequences(run_id, next_number) VALUES(?, 1) ON CONFLICT(run_id) DO NOTHING",
					)
					.run(runId);
				const sequence = this.db
					.prepare("SELECT next_number FROM reference_sequences WHERE run_id = ?")
					.get(runId) as { next_number: number };
				if (!Number.isSafeInteger(sequence.next_number) || sequence.next_number >= Number.MAX_SAFE_INTEGER) {
					throw new RiemannHostError("limit_exceeded", "Run reference numbers are exhausted");
				}
				reference = { runId, shortRef: `r${sequence.next_number.toString(36)}`, resourceId, kind };
				this.db
					.prepare("UPDATE reference_sequences SET next_number = ? WHERE run_id = ?")
					.run(sequence.next_number + 1, runId);
				this.db
					.prepare("INSERT INTO resource_references(run_id, short_ref, resource_id, kind) VALUES(?, ?, ?, ?)")
					.run(runId, reference.shortRef, resourceId, kind);
			}
			if (agentId !== undefined) this.addGrant(runId, reference.shortRef, agentId);
			return reference;
		});
	}

	resolve(runId: string, shortRef: string, agentId?: string): StoredReference {
		if (!/^r[1-9a-z][0-9a-z]*$/.test(shortRef) || shortRef.length > 12) {
			throw new RiemannHostError("not_found", "Unknown short resource reference");
		}
		const reference = this.db
			.prepare(
				"SELECT run_id AS runId, short_ref AS shortRef, resource_id AS resourceId, kind FROM resource_references WHERE run_id = ? AND short_ref = ?",
			)
			.get(runId, shortRef) as unknown as StoredReference | undefined;
		if (!reference) throw new RiemannHostError("not_found", "Unknown short resource reference");
		if (
			agentId !== undefined &&
			!this.db
				.prepare(
					"SELECT 1 FROM reference_grants g JOIN agents a ON a.id = g.agent_id AND a.run_id = g.run_id WHERE g.run_id = ? AND g.short_ref = ? AND g.agent_id = ?",
				)
				.get(runId, shortRef, agentId)
		) {
			throw new RiemannHostError("permission_denied", "Resource reference is not granted to this Agent");
		}
		return reference;
	}

	private addGrant(runId: string, shortRef: string, agentId: string): void {
		this.db
			.prepare("INSERT INTO reference_grants(run_id, short_ref, agent_id) VALUES(?, ?, ?) ON CONFLICT DO NOTHING")
			.run(runId, shortRef, agentId);
	}

	grant(runId: string, shortRef: string, targetId: string, sourceId?: string): void {
		this.transaction(() => {
			this.resolve(runId, shortRef, sourceId);
			this.assertAgent(runId, targetId);
			this.addGrant(runId, shortRef, targetId);
		});
	}

	grantFromAgent(runId: string, sourceId: string, targetId: string): void {
		this.transaction(() => {
			this.assertAgent(runId, sourceId);
			this.assertAgent(runId, targetId);
			// Display views and their public data can be handed off; query cursors remain owner-bound.
			this.db
				.prepare(
					"INSERT INTO reference_grants(run_id, short_ref, agent_id) SELECT g.run_id, g.short_ref, ? FROM reference_grants g JOIN resource_references r ON r.run_id = g.run_id AND r.short_ref = g.short_ref JOIN artifacts a ON a.handle = r.resource_id WHERE g.run_id = ? AND g.agent_id = ? AND (r.kind = 'artifact' OR a.mime_type IN (?, ?)) ON CONFLICT DO NOTHING",
				)
				.run(targetId, runId, sourceId, OUTPUT_VIEW_MIME, RESULT_MIME);
		});
	}
}
