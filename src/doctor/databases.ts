import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Database integrity checks.
 * Validates SQLite databases (mail.db, metrics.db, sessions.db) exist and have correct schema.
 */
export const checkDatabases: DoctorCheckFn = (_config, legioDir): DoctorCheck[] => {
	const checks: DoctorCheck[] = [];

	// Define expected databases and their required tables
	const databases = [
		{
			name: "mail.db",
			tables: ["messages"],
			requiredColumns: {
				messages: [
					"id",
					"from_agent",
					"to_agent",
					"subject",
					"body",
					"type",
					"priority",
					"thread_id",
					"payload",
					"read",
					"created_at",
				],
			},
		},
		{
			name: "metrics.db",
			tables: ["sessions"],
			requiredColumns: {
				sessions: [
					"agent_name",
					"bead_id",
					"capability",
					"started_at",
					"completed_at",
					"duration_ms",
					"exit_code",
					"merge_result",
					"parent_agent",
					"input_tokens",
					"output_tokens",
					"cache_read_tokens",
					"cache_creation_tokens",
					"estimated_cost_usd",
					"model_used",
				],
			},
		},
		{
			name: "sessions.db",
			tables: ["sessions", "runs"],
			requiredColumns: {
				sessions: [
					"id",
					"agent_name",
					"capability",
					"worktree_path",
					"branch_name",
					"bead_id",
					"tmux_session",
					"state",
					"pid",
					"parent_agent",
					"depth",
					"run_id",
					"started_at",
					"last_activity",
					"escalation_level",
					"stalled_since",
				],
				runs: [
					"id",
					"started_at",
					"completed_at",
					"agent_count",
					"coordinator_session_id",
					"status",
				],
			},
		},
	];

	for (const dbSpec of databases) {
		const dbPath = join(legioDir, dbSpec.name);

		// Check if database file exists
		if (!existsSync(dbPath)) {
			checks.push({
				name: `${dbSpec.name} exists`,
				category: "databases",
				status: "fail",
				message: `Database file ${dbSpec.name} does not exist`,
				details: [`Expected at: ${dbPath}`],
			});
			continue;
		}

		// Try to open the database
		let db: Database | null = null;
		try {
			db = new Database(dbPath);

			// Check WAL mode is enabled
			const journalMode = db.prepare("PRAGMA journal_mode").get() as
				| { journal_mode: string }
				| undefined;
			const walEnabled = journalMode?.journal_mode?.toLowerCase() === "wal";

			// Check for required tables
			const missingTables: string[] = [];
			const schemaIssues: string[] = [];

			for (const tableName of dbSpec.tables) {
				const tableExists = db
					.prepare(
						"SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name=?",
					)
					.get(tableName) as { count: number } | undefined;

				if (!tableExists || tableExists.count === 0) {
					missingTables.push(tableName);
					continue;
				}

				// Check columns if table exists
				const requiredCols =
					dbSpec.requiredColumns[tableName as keyof typeof dbSpec.requiredColumns];
				if (requiredCols) {
					const columns = db
						.prepare(`PRAGMA table_info(${tableName})`)
						.all() as Array<{ name: string }>;
					const existingCols = new Set(columns.map((c) => c.name));

					for (const reqCol of requiredCols) {
						if (!existingCols.has(reqCol)) {
							schemaIssues.push(`Table ${tableName} missing column: ${reqCol}`);
						}
					}
				}
			}

			// Determine check status
			if (missingTables.length > 0 || schemaIssues.length > 0) {
				const details: string[] = [];
				if (missingTables.length > 0) {
					details.push(`Missing tables: ${missingTables.join(", ")}`);
				}
				if (schemaIssues.length > 0) {
					details.push(...schemaIssues);
				}
				if (!walEnabled) {
					details.push("WAL mode not enabled");
				}

				checks.push({
					name: `${dbSpec.name} schema`,
					category: "databases",
					status: "fail",
					message: `Database ${dbSpec.name} has schema issues`,
					details,
					fixable: true,
				});
			} else if (!walEnabled) {
				checks.push({
					name: `${dbSpec.name} WAL mode`,
					category: "databases",
					status: "warn",
					message: `Database ${dbSpec.name} is not using WAL mode`,
					details: ["WAL mode improves concurrent access performance"],
					fixable: true,
				});
			} else {
				checks.push({
					name: `${dbSpec.name} health`,
					category: "databases",
					status: "pass",
					message: `Database ${dbSpec.name} is healthy`,
				});
			}

			db.close();
		} catch (err) {
			if (db) {
				try {
					db.close();
				} catch {
					// Ignore close errors
				}
			}

			checks.push({
				name: `${dbSpec.name} integrity`,
				category: "databases",
				status: "fail",
				message: `Failed to open or validate ${dbSpec.name}`,
				details: [
					err instanceof Error ? err.message : String(err),
					"Database may be corrupted or locked",
				],
			});
		}
	}

	return checks;
};

