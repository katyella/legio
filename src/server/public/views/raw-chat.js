// Legio Web UI — RawChatView component
// Standalone Claude chat interface — talk directly to Claude via the backend API.
// 2-panel layout: session sidebar (left) + message feed + input (right).
// No npm dependencies — uses CDN imports. Served as a static ES module.

import { fetchJson, postJson } from "../lib/api.js";
import {
	html,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "../lib/preact-setup.js";
import { appState } from "../lib/state.js";
import { timeAgo } from "../lib/utils.js";

/**
 * Format a date as "MMM D" (e.g. "Feb 21").
 */
function formatDate(isoString) {
	if (!isoString) return "";
	const d = new Date(isoString);
	return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * RawChatView — direct Claude chat interface.
 *
 * Self-fetches sessions and config. No props required.
 */
export function RawChatView() {
	// ── Config ──────────────────────────────────────────────────────────────
	const [configAvailable, setConfigAvailable] = useState(true);
	const [defaultModel, setDefaultModel] = useState("claude-sonnet-4-6");

	// ── Sessions ─────────────────────────────────────────────────────────────
	const sessions = appState.chatSessions.value;
	const activeSessionId = appState.chatActiveSessionId.value;
	const [sessionsLoading, setSessionsLoading] = useState(appState.chatSessions.value.length === 0);

	// ── Messages ─────────────────────────────────────────────────────────────
	const [messages, setMessages] = useState([]);
	const [messagesLoading, setMessagesLoading] = useState(false);

	// ── Input ────────────────────────────────────────────────────────────────
	const [inputValue, setInputValue] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState("");

	// ── Scroll ───────────────────────────────────────────────────────────────
	const feedRef = useRef(null);
	const isNearBottomRef = useRef(true);
	const inputRef = useRef(null);

	// ── Mount: load config + sessions ────────────────────────────────────────
	useEffect(() => {
		if (appState.chatSessions.value.length > 0) {
			setSessionsLoading(false);
			return;
		}
		Promise.all([
			fetchJson("/api/chat/config").catch(() => null),
			fetchJson("/api/chat/sessions").catch(() => []),
		]).then(([cfg, sess]) => {
			if (cfg !== null) {
				setConfigAvailable(cfg.available ?? true);
				if (cfg.defaultModel) setDefaultModel(cfg.defaultModel);
			}
			appState.chatSessions.value = Array.isArray(sess) ? sess : [];
			setSessionsLoading(false);
		});
	}, []);

	// ── Load messages when active session changes ─────────────────────────────
	useEffect(() => {
		if (!activeSessionId) {
			setMessages([]);
			return;
		}
		setMessagesLoading(true);
		setError("");
		fetchJson(`/api/chat/sessions/${activeSessionId}/messages`)
			.then((msgs) => {
				setMessages(Array.isArray(msgs) ? msgs : []);
				isNearBottomRef.current = true;
			})
			.catch((err) => {
				setError(err.message || "Failed to load messages");
				setMessages([]);
			})
			.finally(() => setMessagesLoading(false));
	}, [activeSessionId]);

	// ── Auto-scroll after messages update ────────────────────────────────────
	useLayoutEffect(() => {
		const feed = feedRef.current;
		if (feed && isNearBottomRef.current) {
			feed.scrollTop = feed.scrollHeight;
		}
	});

	const handleFeedScroll = useCallback(() => {
		const feed = feedRef.current;
		if (!feed) return;
		isNearBottomRef.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
	}, []);

	// ── Create new session ────────────────────────────────────────────────────
	const handleNewChat = useCallback(async () => {
		setError("");
		try {
			const session = await postJson("/api/chat/sessions", {});
			appState.chatSessions.value = [session, ...appState.chatSessions.value];
			appState.chatActiveSessionId.value = session.id;
			setMessages([]);
			isNearBottomRef.current = true;
			setTimeout(() => inputRef.current?.focus(), 50);
		} catch (err) {
			setError(err.message || "Failed to create session");
		}
	}, []);

	// ── Select session ────────────────────────────────────────────────────────
	const handleSelectSession = useCallback((id) => {
		if (id === appState.chatActiveSessionId.value) return;
		appState.chatActiveSessionId.value = id;
		setError("");
	}, []);

	// ── Delete session ────────────────────────────────────────────────────────
	const handleDeleteSession = useCallback(async (e, id) => {
		e.stopPropagation();
		try {
			await fetch(`/api/chat/sessions/${id}`, { method: "DELETE" });
			appState.chatSessions.value = appState.chatSessions.value.filter((s) => s.id !== id);
			if (appState.chatActiveSessionId.value === id) {
				appState.chatActiveSessionId.value = null;
				setMessages([]);
			}
		} catch (err) {
			setError(err.message || "Failed to delete session");
		}
	}, []);

	// ── Send message ──────────────────────────────────────────────────────────
	const handleSend = useCallback(async () => {
		const content = inputValue.trim();
		if (!content || sending || !activeSessionId) return;
		setError("");
		setSending(true);
		setInputValue("");
		isNearBottomRef.current = true;

		// Optimistically add user message
		const tempUserMsg = {
			id: `temp-${Date.now()}`,
			sessionId: activeSessionId,
			role: "user",
			content,
			createdAt: new Date().toISOString(),
			_temp: true,
		};
		setMessages((prev) => [...prev, tempUserMsg]);

		try {
			const assistantMsg = await postJson(`/api/chat/sessions/${activeSessionId}/messages`, {
				content,
			});
			// Replace temp user message with real messages from server
			setMessages((prev) => {
				const withoutTemp = prev.filter((m) => !m._temp);
				// The server returns the assistant message; reconstruct the user message
				const userMsg = {
					id: `user-${assistantMsg.id}`,
					sessionId: activeSessionId,
					role: "user",
					content,
					createdAt: assistantMsg.createdAt,
				};
				return [...withoutTemp, userMsg, assistantMsg];
			});
			// Update session updatedAt in sidebar
			appState.chatSessions.value = appState.chatSessions.value.map((s) =>
				s.id === activeSessionId ? { ...s, updatedAt: assistantMsg.createdAt } : s,
			);
		} catch (err) {
			setError(err.message || "Failed to send message");
			// Remove temp message on error
			setMessages((prev) => prev.filter((m) => !m._temp));
			setInputValue(content); // restore input
		} finally {
			setSending(false);
			setTimeout(() => inputRef.current?.focus(), 50);
		}
	}, [inputValue, sending, activeSessionId]);

	// ── Active session data ───────────────────────────────────────────────────
	const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

	// ── Render ────────────────────────────────────────────────────────────────
	return html`
		<div class="flex h-full">

			<!-- Sidebar -->
			<div class="w-64 bg-[#0f0f0f] border-r border-[#2a2a2a] flex flex-col flex-shrink-0">

				<!-- New Chat button -->
				<div class="p-3 border-b border-[#2a2a2a]">
					<button
						onClick=${handleNewChat}
						disabled=${!configAvailable}
						class="w-full bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-3 py-2 rounded border-none cursor-pointer transition-colors"
					>
						+ New Chat
					</button>
				</div>

				<!-- Session list -->
				<div class="flex-1 overflow-y-auto">
					${
						sessionsLoading
							? html`<div class="px-3 py-4 text-xs text-[#555]">Loading...</div>`
							: sessions.length === 0
								? html`<div class="px-3 py-4 text-xs text-[#555]">No sessions yet</div>`
								: sessions.map((session) => {
										const isActive = session.id === activeSessionId;
										const title = session.title
											? session.title.length > 28
												? `${session.title.slice(0, 28)}\u2026`
												: session.title
											: "Untitled";
										return html`
									<div
										key=${session.id}
										class=${
											"group flex items-start gap-1 px-3 py-2.5 cursor-pointer hover:bg-[#1a1a1a] border-l-2 transition-colors " +
											(isActive ? "bg-[#1a1a1a] border-[#E64415]" : "border-transparent")
										}
										onClick=${() => handleSelectSession(session.id)}
									>
										<div class="flex-1 min-w-0">
											<div class=${"text-xs font-medium truncate " + (isActive ? "text-[#e5e5e5]" : "text-[#aaa]")}>
												${title}
											</div>
											<div class="flex items-center gap-1.5 mt-0.5">
												${
													session.model
														? html`<span class="text-[10px] bg-[#1a1a1a] border border-[#333] text-[#666] px-1 rounded font-mono">
														${session.model.split("-").slice(-2).join("-")}
													</span>`
														: null
												}
												<span class="text-[10px] text-[#555]">${formatDate(session.updatedAt || session.createdAt)}</span>
											</div>
										</div>
										<button
											class="opacity-0 group-hover:opacity-100 text-[#555] hover:text-[#e55] bg-transparent border-none cursor-pointer p-0.5 text-xs shrink-0 transition-opacity"
											onClick=${(e) => handleDeleteSession(e, session.id)}
											title="Delete session"
										>\u00D7</button>
									</div>
								`;
									})
					}
				</div>
			</div>

			<!-- Main area -->
			<div class="flex-1 flex flex-col min-w-0">

				<!-- Header -->
				<div class="px-4 py-3 border-b border-[#2a2a2a] flex items-center gap-3 flex-shrink-0">
					<span class="text-sm font-semibold text-[#e5e5e5]">Claude Chat</span>
					<span class="text-xs text-[#555]">\u2022 direct</span>
					${
						activeSession?.model
							? html`<span class="ml-auto text-xs bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] px-2 py-0.5 rounded font-mono">
							${activeSession.model}
						</span>`
							: html`<span class="ml-auto text-xs text-[#555] font-mono">${defaultModel}</span>`
					}
				</div>

				<!-- Content area -->
				${
					!configAvailable
						? html`
						<div class="flex-1 flex items-center justify-center p-8">
							<div class="max-w-sm text-center">
								<div class="text-2xl mb-3">\u{1F511}</div>
								<div class="text-sm font-medium text-[#e5e5e5] mb-2">API Key Required</div>
								<div class="text-xs text-[#888] leading-relaxed">
									Claude chat requires an <span class="font-mono text-[#ccc]">ANTHROPIC_API_KEY</span> environment variable.
									Set it and restart the server to enable direct Claude chat.
								</div>
							</div>
						</div>
					`
						: !activeSessionId
							? html`
							<div class="flex-1 flex items-center justify-center p-8">
								<div class="text-center">
									<div class="text-2xl mb-3">\u{1F4AC}</div>
									<div class="text-sm text-[#888]">Start a new chat to talk with Claude</div>
								</div>
							</div>
						`
							: html`
							<!-- Message feed -->
							<div
								class="flex-1 overflow-y-auto p-4 space-y-3 min-h-0"
								ref=${feedRef}
								onScroll=${handleFeedScroll}
							>
								${
									messagesLoading
										? html`<div class="flex items-center justify-center h-full text-xs text-[#555]">Loading messages...</div>`
										: messages.length === 0
											? html`<div class="flex items-center justify-center h-full text-xs text-[#555]">No messages yet — say hello!</div>`
											: messages.map((msg) => {
													const isUser = msg.role === "user";
													return html`
												<div
													key=${msg.id}
													class=${"flex " + (isUser ? "justify-end" : "justify-start")}
												>
													<div class=${"max-w-[75%] " + (isUser ? "" : "")}>
														<div class=${
															"px-3 py-2 rounded-lg text-sm leading-relaxed whitespace-pre-wrap break-words " +
															(isUser
																? "bg-[#E64415] text-white rounded-br-sm"
																: "bg-[#1a1a1a] border border-[#2a2a2a] text-[#e5e5e5] rounded-bl-sm")
														}>
															${
																msg._temp && msg.role === "user"
																	? html`<span class="opacity-70">${msg.content}</span>`
																	: msg.content
															}
														</div>
														<div class=${"mt-0.5 text-[10px] text-[#555] " + (isUser ? "text-right" : "text-left")}>
															${timeAgo(msg.createdAt)}
														</div>
													</div>
												</div>
											`;
												})
								}
								${
									sending
										? html`
										<div class="flex justify-start">
											<div class="bg-[#1a1a1a] border border-[#2a2a2a] px-3 py-2 rounded-lg rounded-bl-sm">
												<span class="text-xs text-[#666] italic">Claude is thinking\u2026</span>
											</div>
										</div>
									`
										: null
								}
							</div>

							<!-- Input area -->
							<div class="border-t border-[#2a2a2a] p-3 flex-shrink-0">
								${error ? html`<div class="text-xs text-red-400 mb-2">${error}</div>` : null}
								<div class="flex gap-2 items-end">
									<textarea
										ref=${inputRef}
										placeholder="Message Claude... (Ctrl+Enter to send)"
										rows="2"
										value=${inputValue}
										disabled=${sending}
										onInput=${(e) => setInputValue(e.target.value)}
										onKeyDown=${(e) => {
											if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
												e.preventDefault();
												handleSend();
											}
										}}
										class="flex-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e5e5e5] placeholder-[#555] outline-none focus:border-[#E64415] resize-none disabled:opacity-50 transition-colors"
									/>
									<button
										onClick=${handleSend}
										disabled=${sending || !inputValue.trim()}
										class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded border-none cursor-pointer self-end transition-colors"
									>
										${sending ? "\u2026" : "Send"}
									</button>
								</div>
							</div>
						`
				}
			</div>

		</div>
	`;
}
