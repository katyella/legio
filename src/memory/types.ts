/**
 * Memory system types and interfaces.
 *
 * Defines the universal MemoryClient interface that all backends
 * (builtin SQLite, mulch CLI) implement. Agents use `legio memory`
 * commands which delegate to the configured backend.
 */

/** Supported memory backends. "auto" detects from filesystem. */
export type MemoryBackend = "auto" | "mulch" | "builtin";

/** A single memory/expertise record. */
export interface MemoryRecord {
	id: string; // "mem-{uuid8}"
	domain: string;
	type: string; // convention|pattern|failure|decision|reference|guide
	content: string;
	classification: string; // tactical|observational
	tags: string[];
	evidenceCommit?: string;
	evidenceBead?: string;
	recordedAt: string;
	updatedAt?: string;
}

/** Domain-level statistics. */
export interface DomainStats {
	name: string;
	recordCount: number;
	lastUpdated: string;
}

/** Universal memory client interface implemented by all backends. */
export interface MemoryClient {
	/** Generate a priming prompt with domain expertise. */
	prime(options?: {
		domains?: string[];
		files?: string[];
		format?: string;
		budget?: number;
	}): Promise<string>;

	/** Record a new expertise entry. Returns the record ID. */
	record(
		domain: string,
		options: {
			type: string;
			description: string;
			tags?: string[];
			classification?: string;
			evidenceCommit?: string;
			evidenceBead?: string;
		},
	): Promise<string>;

	/** Full-text search across all records. */
	search(query: string): Promise<string>;

	/** Query records, optionally scoped to a domain. */
	query(domain?: string): Promise<string>;

	/** Get domain statistics. */
	status(): Promise<DomainStats[]>;

	/** List records with optional filters. */
	list(options?: {
		domain?: string;
		type?: string;
		limit?: number;
		since?: string;
	}): Promise<MemoryRecord[]>;

	/** Show a single record by ID. */
	show(id: string): Promise<MemoryRecord>;

	/** Delete a record by ID. */
	delete(id: string): Promise<void>;

	/** Prune old/stale records. */
	prune(options?: {
		dryRun?: boolean;
		olderThanDays?: number;
		domain?: string;
	}): Promise<{ pruned: number; dryRun: boolean }>;

	/** Suggest domains for a set of file paths. */
	suggestDomains(files: string[]): string[];

	/** Close underlying resources (e.g., SQLite connection). */
	dispose?(): void;
}
