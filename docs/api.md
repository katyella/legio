# REST API Reference

When the server is running (`legio server start` or `legio up`), a full REST API is available at `http://localhost:4173/api/`.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | Overall project status |
| `GET /api/health` | Server health check |
| `GET /api/agents` | List all agents |
| `GET /api/agents/active` | Active agents only |
| `GET /api/agents/:name` | Agent details |
| `GET /api/agents/:name/inspect` | Deep inspection data |
| `GET /api/agents/:name/events` | Agent events |
| `POST /api/agents/:name/chat` | Send chat message to agent |
| `GET /api/agents/:name/chat/history` | Agent chat history |
| `POST /api/agents/spawn` | Spawn agent from UI |
| `POST /api/coordinator/chat` | Send chat message to coordinator |
| `GET /api/coordinator/chat/history` | Coordinator chat history |
| `POST /api/gateway/chat` | Send chat message to gateway |
| `GET /api/gateway/chat/history` | Gateway chat history |
| `GET /api/chat/unified/history` | Unified chat timeline |
| `POST /api/chat/transcript-sync` | Sync transcript data |
| `GET /api/ideas` | Ideas list |
| `POST /api/ideas` | Create idea |
| `PUT /api/ideas/:id` | Update idea |
| `DELETE /api/ideas/:id` | Delete idea |
| `POST /api/ideas/:id/dispatch` | Dispatch idea to agents |
| `POST /api/ideas/:id/backlog` | Move idea to backlog |
| `GET /api/mail` | All messages |
| `GET /api/mail/unread` | Unread messages |
| `GET /api/mail/conversations` | Thread grouping |
| `POST /api/mail/send` | Send a message |
| `GET /api/events` | Tool events |
| `GET /api/events/errors` | Error events |
| `GET /api/metrics` | Session metrics |
| `GET /api/runs` | All runs |
| `GET /api/runs/active` | Active run |
| `GET /api/issues` | Beads issues |
| `GET /api/merge-queue` | Merge queue status |
| `POST /api/terminal/send` | Send keys to tmux pane |
| `GET /api/terminal/capture` | Capture pane output |
| `POST /api/setup/init` | Initialize legio from UI |
| `GET /api/setup/status` | Setup status |
| `GET /api/audit` | Query audit trail |
| `WS /ws` | WebSocket for real-time updates |

## WebSocket

Connect to `ws://localhost:4173/ws` for real-time updates. The server pushes events for agent state changes, new mail messages, merge queue updates, and metric snapshots.

## Tech Stack

The server is built with Node's built-in `http` module, with Preact + HTM + Tailwind CSS on the frontend (zero build step, served from `src/server/public/`). WebSocket support via the `ws` package.
