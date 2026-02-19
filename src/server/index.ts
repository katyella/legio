import { join } from "node:path";
import { createAutopilot } from "../autopilot/daemon.ts";
import { createWebSocketManager, type WebSocketData } from "./websocket.ts";

export interface ServerOptions {
	port: number;
	host: string;
	root: string; // Project root directory
	shouldOpen?: boolean; // Auto-open browser
}

/**
 * Create and return a Bun server instance without blocking.
 * Exported for testing; production code should use startServer().
 */
export function createServer(options: ServerOptions): ReturnType<typeof Bun.serve> {
	const { port, host, root } = options;
	const legioDir = join(root, ".legio");
	const publicDir = join(import.meta.dir, "public");

	const autopilot = createAutopilot(root);
	const wsManager = createWebSocketManager(legioDir, () => autopilot.getState());

	const server = Bun.serve<WebSocketData>({
		port,
		hostname: host,

		async fetch(req, server) {
			const url = new URL(req.url);
			const path = url.pathname;

			// WebSocket upgrade
			if (path === "/ws") {
				const upgraded = server.upgrade(req, {
					data: { connectedAt: new Date().toISOString() },
				});
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			// API routes — dynamic import so routes.ts can be provided by another builder
			if (path.startsWith("/api/")) {
				try {
					type RoutesModule = {
						handleApiRequest(
							req: Request,
							legioDir: string,
							root: string,
							autopilot?: import("../autopilot/daemon.ts").AutopilotInstance | null,
						): Promise<Response>;
					};
					const { handleApiRequest } = (await import("./routes.ts")) as RoutesModule;
					return await handleApiRequest(req, legioDir, root, autopilot);
				} catch (err) {
					const message = err instanceof Error ? err.message : "Internal server error";
					return new Response(JSON.stringify({ error: message }), {
						status: 500,
						headers: { "Content-Type": "application/json" },
					});
				}
			}

			// Static files
			const filePath =
				path === "/" ? join(publicDir, "index.html") : join(publicDir, path.slice(1));
			const file = Bun.file(filePath);
			if (await file.exists()) {
				return new Response(file);
			}

			// SPA fallback — serve index.html for non-file paths (hash routing)
			const indexFile = Bun.file(join(publicDir, "index.html"));
			if (await indexFile.exists()) {
				return new Response(indexFile);
			}

			return new Response("Not found", { status: 404 });
		},

		websocket: {
			open(ws) {
				wsManager.addClient(ws);
			},
			message(ws, message) {
				wsManager.handleMessage(ws, message);
			},
			close(ws) {
				wsManager.removeClient(ws);
			},
		},
	});

	// Start WebSocket polling
	wsManager.startPolling();

	return server;
}

export async function startServer(options: ServerOptions): Promise<void> {
	const { host, shouldOpen } = options;

	const server = createServer(options);

	const url = `http://${host}:${server.port}`;
	process.stdout.write(`Legio web UI running at ${url}\n`);

	if (shouldOpen) {
		// Open browser (macOS: open, Linux: xdg-open)
		const cmd = process.platform === "darwin" ? "open" : "xdg-open";
		Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
	}

	// Graceful shutdown
	const shutdown = () => {
		process.stdout.write("\nShutting down server...\n");
		server.stop(true); // close=true to gracefully close connections
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Keep alive — Bun.serve() already keeps the process alive, but
	// we explicitly wait on a never-resolving promise for clarity
	await new Promise(() => {});
}
