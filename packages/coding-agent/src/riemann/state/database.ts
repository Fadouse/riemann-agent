import { createRequire } from "node:module";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";

export type RiemannDatabase = NodeDatabaseSync;

interface DatabaseConstructor {
	new (path: string): NodeDatabaseSync;
}

const require = createRequire(import.meta.url);

function databaseConstructor(): DatabaseConstructor {
	if (process.versions.bun) {
		const bunSqlite = require("bun:sqlite") as { Database: DatabaseConstructor };
		return bunSqlite.Database;
	}
	const nodeSqlite = require("node:sqlite") as { DatabaseSync: DatabaseConstructor };
	return nodeSqlite.DatabaseSync;
}

/** Runtime-neutral synchronous SQLite constructor for Node and compiled Bun releases. */
export const DatabaseSync = databaseConstructor();
