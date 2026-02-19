import { join } from "node:path";
import type { RawData, WebSocket } from "ws";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import type { AutopilotState } from "../types.ts";

export interface WebSocketData {
	connectedAt: string;
}

interface Snapshot {
	type: "snapshot";
	data: {
		agents: unknown[];
		mail: { unreadCount: number; recent: unknown[] };
		mergeQueue: unknown[];
		metrics: { totalSessions: number; avgDuration: number };
		runs: { active: unknown | null };
		autopilot?: AutopilotState | null;
	};
	timestamp: string;
}

export interface WebSocketManager {
	addClient(ws: WebSocket): void;
	removeClient(ws: WebSocket): void;
	handleMessage(ws: WebSocket, message: RawData): void;
	startPolling(): void;
	stopPolling(): void;
}

export function createWebSocketManager(
	legioDir: string,
	getAutopilotState?: () => AutopilotState | null,
): WebSocketManager {
	const clients = new Set<WebSocket>();
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let lastSnapshot = "";

	function gatherSnapshot(): Snapshot {
		const data: Snapshot["data"] = {
			agents: [],
			mail: { unreadCount: 0, recent: [] },
			mergeQueue: [],
			metrics: { totalSessions: 0, avgDuration: 0 },
			runs: { active: null },
		};

		// Session store
		try {
			const { store } = openSessionStore(legioDir);
			try {
				data.agents = store.getActive();
			} finally {
				store.close();
			}
		} catch {
			/* db may not exist */
		}

		// Mail store
		try {
			const mailPath = join(legioDir, "mail.db");
			const store = createMailStore(mailPath);
			try {
				const all = store.getAll();
				data.mail.unreadCount = all.filter((m: { read: boolean }) => !m.read).length;
				data.mail.recent = all.slice(0, 20);
			} finally {
				store.close();
			}
		} catch {
			/* db may not exist */
		}

		// Merge queue
		try {
			const queue = createMergeQueue(join(legioDir, "merge-queue.db"));
			try {
				data.mergeQueue = queue.list();
			} finally {
				queue.close();
			}
		} catch {
			/* db may not exist */
		}

		// Metrics
		try {
			const store = createMetricsStore(join(legioDir, "metrics.db"));
			try {
				const sessions = store.getRecentSessions(100);
				data.metrics.totalSessions = sessions.length;
				data.metrics.avgDuration = store.getAverageDuration();
			} finally {
				store.close();
			}
		} catch {
			/* db may not exist */
		}

		// Runs
		try {
			const store = createRunStore(join(legioDir, "sessions.db"));
			try {
				data.runs.active = store.getActiveRun();
			} finally {
				store.close();
			}
		} catch {
			/* db may not exist */
		}

		// Autopilot state (from injected callback)
		if (getAutopilotState) {
			data.autopilot = getAutopilotState();
		}

		return {
			type: "snapshot",
			data,
			timestamp: new Date().toISOString(),
		};
	}

	function broadcast(snapshot: Snapshot): void {
		const msg = JSON.stringify(snapshot);
		for (const client of clients) {
			try {
				client.send(msg);
			} catch {
				clients.delete(client);
			}
		}
	}

	return {
		addClient(ws) {
			clients.add(ws);
			// Send initial snapshot immediately
			const snapshot = gatherSnapshot();
			try {
				ws.send(JSON.stringify(snapshot));
			} catch {
				clients.delete(ws);
			}
		},

		removeClient(ws) {
			clients.delete(ws);
		},

		handleMessage(ws, message) {
			try {
				const msgStr =
					typeof message === "string"
						? message
						: Buffer.isBuffer(message)
							? message.toString("utf8")
							: Array.isArray(message)
								? Buffer.concat(message as Buffer[]).toString("utf8")
								: Buffer.from(message as ArrayBuffer).toString("utf8");
				const parsed = JSON.parse(msgStr);
				if (parsed && typeof parsed === "object" && "type" in parsed && parsed.type === "refresh") {
					const snapshot = gatherSnapshot();
					ws.send(JSON.stringify(snapshot));
				}
			} catch {
				// Ignore invalid messages
			}
		},

		startPolling() {
			pollInterval = setInterval(() => {
				if (clients.size === 0) return; // Skip if no clients
				const snapshot = gatherSnapshot();
				const snapshotStr = JSON.stringify(snapshot.data);
				if (snapshotStr !== lastSnapshot) {
					lastSnapshot = snapshotStr;
					broadcast(snapshot);
				}
			}, 2000);
		},

		stopPolling() {
			if (pollInterval) {
				clearInterval(pollInterval);
				pollInterval = null;
			}
		},
	};
}
