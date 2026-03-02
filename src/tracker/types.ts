/**
 * Tracker abstraction layer types.
 *
 * Defines a pluggable TrackerClient interface that works with any backend
 * (beads via bd CLI, or seeds via sd CLI).
 */

/** A tracker issue as returned by any backend. */
export interface TrackerIssue {
	id: string;
	title: string;
	status: string;
	priority: number;
	type: string;
	assignee?: string;
	description?: string;
	blocks?: string[];
	blockedBy?: string[];
	closedAt?: string;
	closeReason?: string;
	createdAt?: string;
}

/** Supported tracker backends. */
export type TrackerBackend = "auto" | "seeds" | "beads" | "builtin";

/** Pluggable tracker client interface. */
export interface TrackerClient {
	/** List issues that are ready for work (open, unblocked). */
	ready(options?: { mol?: string }): Promise<TrackerIssue[]>;
	/** Show details for a specific issue. */
	show(id: string): Promise<TrackerIssue>;
	/** Create a new issue. Returns the new issue ID. */
	create(
		title: string,
		options?: { type?: string; priority?: number; description?: string },
	): Promise<string>;
	/** Claim an issue (mark as in_progress). */
	claim(id: string): Promise<void>;
	/** Close an issue with an optional reason. */
	close(id: string, reason?: string): Promise<void>;
	/** List issues with optional filters. */
	list(options?: { status?: string; limit?: number; all?: boolean }): Promise<TrackerIssue[]>;
	/** Sync tracker state (e.g., bd sync or sd sync). */
	sync(): Promise<void>;
}
