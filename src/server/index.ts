import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import * as http from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createAutopilot } from "../autopilot/daemon.ts";
import { createWebSocketManager, type WebSocketData } from "./websocket.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
	port: number;
	host: string;
	root: string; // Project root directory
	shouldOpen?: boolean; // Auto-open browser
}

export interface ServerInstance {
	port: number;
	stop(force?: boolean): void;
}

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".txt": "text/plain",
};

function fileExists(filePath: string): Promise<boolean> {
	return access(filePath).then(
		() => true,
		() => false,
	);
}

function collectBody(req: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

async function sendWebResponse(webRes: Response, res: http.ServerResponse): Promise<void> {
	res.statusCode = webRes.status;
	webRes.headers.forEach((value, key) => {
		res.setHeader(key, value);
	});
	const body = await webRes.arrayBuffer();
	res.end(Buffer.from(body));
}

/**
 * Create and return a server instance without blocking.
 * Exported for testing; production code should use startServer().
 */
export async function createServer(options: ServerOptions): Promise<ServerInstance> {
	const { port, host, root } = options;
	const legioDir = join(root, ".legio");
	const publicDir = join(__dirname, "public");

	const autopilot = createAutopilot(root);
	const wsManager = createWebSocketManager(legioDir, () => autopilot.getState());

	const httpServer = http.createServer(async (req, res) => {
		try {
			const urlStr = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
			const url = new URL(urlStr);
			const pathname = url.pathname;

			// WebSocket upgrade requests are handled by the upgrade event, not here
			if (pathname === "/ws") {
				res.writeHead(400);
				res.end("WebSocket upgrade required");
				return;
			}

			// API routes — dynamic import so routes.ts can be provided by another builder
			if (pathname.startsWith("/api/")) {
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

					const body = await collectBody(req);
					const headers = new Headers();
					for (const [key, value] of Object.entries(req.headers)) {
						if (value !== undefined) {
							if (Array.isArray(value)) {
								for (const v of value) headers.append(key, v);
							} else {
								headers.set(key, value);
							}
						}
					}

					const webReq = new Request(urlStr, {
						method: req.method ?? "GET",
						headers,
						body: body.length > 0 ? body.toString("utf8") : undefined,
					});

					const webRes = await handleApiRequest(webReq, legioDir, root, autopilot);
					await sendWebResponse(webRes, res);
				} catch (err) {
					const message = err instanceof Error ? err.message : "Internal server error";
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: message }));
				}
				return;
			}

			// Static files
			const filePath =
				pathname === "/" ? join(publicDir, "index.html") : join(publicDir, pathname.slice(1));

			if (await fileExists(filePath)) {
				const content = await readFile(filePath);
				const ext = extname(filePath);
				const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";
				res.writeHead(200, { "Content-Type": mimeType });
				res.end(content);
				return;
			}

			// SPA fallback — serve index.html for non-file paths (hash routing)
			const indexPath = join(publicDir, "index.html");
			if (await fileExists(indexPath)) {
				const content = await readFile(indexPath);
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(content);
				return;
			}

			res.writeHead(404);
			res.end("Not found");
		} catch (err) {
			const message = err instanceof Error ? err.message : "Server error";
			res.writeHead(500);
			res.end(message);
		}
	});

	const wss = new WebSocketServer({ noServer: true });

	httpServer.on("upgrade", (req, socket, head) => {
		const urlStr = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
		const url = new URL(urlStr);
		if (url.pathname === "/ws") {
			wss.handleUpgrade(req, socket as import("node:net").Socket, head, (ws) => {
				wss.emit("connection", ws, req);
			});
		} else {
			socket.destroy();
		}
	});

	wss.on("connection", (ws) => {
		const _data: WebSocketData = { connectedAt: new Date().toISOString() };
		wsManager.addClient(ws);
		ws.on("message", (message) => {
			wsManager.handleMessage(ws, message);
		});
		ws.on("close", () => {
			wsManager.removeClient(ws);
		});
	});

	// Start WebSocket polling
	wsManager.startPolling();

	// Start listening and wait for the port to be assigned
	await new Promise<void>((resolve, reject) => {
		httpServer.once("listening", resolve);
		httpServer.once("error", reject);
		httpServer.listen(port, host);
	});

	const address = httpServer.address();
	const actualPort = typeof address === "object" && address !== null ? address.port : port;

	return {
		port: actualPort,
		stop(_force?: boolean) {
			wsManager.stopPolling();
			wss.close();
			httpServer.close();
		},
	};
}

export async function startServer(options: ServerOptions): Promise<void> {
	const { host, shouldOpen } = options;

	const server = await createServer(options);

	const url = `http://${host}:${server.port}`;
	process.stdout.write(`Legio web UI running at ${url}\n`);

	if (shouldOpen) {
		// Open browser (macOS: open, Linux: xdg-open)
		const cmd = process.platform === "darwin" ? "open" : "xdg-open";
		const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
		child.unref();
	}

	// Graceful shutdown
	const shutdown = () => {
		process.stdout.write("\nShutting down server...\n");
		server.stop(true);
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// http.createServer + listen keeps the process alive naturally via the event loop.
	// No need to await an infinite promise.
}
