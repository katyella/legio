import { join } from "node:path";
import { createSessionStore, type SessionStore } from "./store.ts";

/**
 * Open or create a SessionStore at the given .legio directory root.
 *
 * @param legioDir - Path to the .legio directory (e.g., /project/.legio)
 * @returns An object with the SessionStore and whether a migration occurred.
 */
export function openSessionStore(legioDir: string): {
	store: SessionStore;
	migrated: boolean;
} {
	const dbPath = join(legioDir, "sessions.db");
	const store = createSessionStore(dbPath);
	return { store, migrated: false };
}
