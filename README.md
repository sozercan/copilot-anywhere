<div align="center">

# Copilot Anywhere

Always‑on autonomous Copilot Chat agent + local HTTP/SSE bridge + web client.

</div>

## Overview
Copilot Anywhere turns a VS Code extension into a tiny multi‑surface AI workspace hub:

| Surface | Capability |
|---------|-----------|
| VS Code Chat Participant | Always-agent mode: any prompt triggers multi‑step reasoning + file tools |
| HTTP API (`POST /message`) | Fire prompts from scripts, CI, or other apps |
| SSE Stream (`GET /events`) | Real‑time inbound, fragment, done, approval, history events |
| Web UI (`/`) | Project selector, live stream, approvals, notifications |

Core loop: user (or HTTP) sends a goal → agent plans JSON tool actions → tools execute (read/list/create/edit/run) → diffs require approval → summarized final answer + changed files references.

## Current Feature Set
- Always-on autonomous agent (no prefix or dropdown; every prompt is a goal)
- Inline chat approval buttons (Approve / Reject) with diff preview
- Cross-surface approval sync (VS Code <→ Web UI)
- Session history persistence + replay (tail limited by setting)
- Synchronized history clearing (`/clear` slash command or HTTP `/clear`)
- Lightweight web client: streaming log, approval modal, desktop notifications, debug toggle
- Structured toolset: `readFiles`, `listFiles`, `createFile`, `editFile` (whole-file), `runCommand`
- Safe roots enforcement + optional approval gating
- Unified diffs for edit previews (simple line diff)

## Architecture
```
┌────────────┐      ┌──────────────────┐      ┌───────────────────────┐
│ VS Code UI │──┐   │ Message Bus      │   ┌─▶│ External Server (HTTP)│
└──────┬─────┘  │   └────────┬─────────┘   │  └──────────┬───────────┘
       │ Chat Participant    │             │             │
       │ (agent loop)        │             │             │ SSE (events)
       │                     │             │             ▼
       │        ┌────────────▼──────┐      │      ┌────────────┐
       │        │ Agent Controller  │      │      │ Web Client │
       │        └───────┬──────────┘      │      └────────────┘
       │                │ Tools           │
       │                ▼                 │
       │        (File System / Shell)     │
       └──────────────────────────────────┘
```

## Event Stream (SSE `/events`)
Event names & payload abridged:

- `inbound` `{ id, text, source, sessionId }`
- `fragment` `{ id, fragment, model, sessionId }` (agent commentary / action + result lines)
- `done` `{ id, model, sessionId }`
- `approvalRequest` `{ approvalId, correlationId, action, path, diff?, contentPreview?, sessionId }`
- `approvalDecision` `{ approvalId, approved, sessionId }`
- `historyCleared` `{ sessionId, at }`

## HTTP API
### POST /message
Send a new goal (always agent mode):
```bash
curl -X POST http://localhost:3939/message \
  -H 'Content-Type: application/json' \
  -d '{ "text": "Add a CONTRIBUTING.md explaining how to run and build" }'
```
Response: `{ "accepted": true, "id": "<correlation-id>", "sessionId": "..." }`

Optional body fields:
- `sessionId` (absolute workspace folder path) – pick target project (defaults to first folder)
- `maxSteps` (override agent max steps)

### POST /clear
Clear session history (memory + persistence file):
```bash
curl -X POST http://localhost:3939/clear -H 'Content-Type: application/json' \
  -d '{ "sessionId": "/absolute/path/to/workspace" }'
```
SSE `historyCleared` event broadcasts afterward.

### GET /sessions
List sessions: id, name, created, message count.

### GET /sessions/:id
Replay full (recent tail) history for a session.

### GET /events
Subscribe to SSE. Add `?session=<id>` to filter.

## VS Code Chat Usage
Just type your goal to the participant (no prefix needed). Examples:
- "Refactor the diff builder to show minimal context"
- "Add unit tests for the approval flow edge cases"
- "List files under src that mention approval"

Slash commands:
- `/files` – list recent agent-changed files
- `/run <cmd>` – run a shell command in workspace root (still subject to approval if configured)
- `/clear` – clear synchronized history

Approvals:
- File create/edit actions emit inline buttons in chat with a truncated diff fenced as `diff`.
- Web UI shows a modal with full diff/preview.
- Decisions sync instantly across surfaces and remove pending state.

## Tools (Agent Actions)
| Tool | Schema (fields) | Notes |
|------|-----------------|-------|
| readFiles | `{ tool: 'readFiles', files: string[] }` | Returns full text for allowed files |
| listFiles | `{ tool: 'listFiles', glob?, max? }` | Simple substring filter, bounded results |
| createFile | `{ tool: 'createFile', path, content }` | Requires approval if enabled; fails if exists |
| editFile | `{ tool: 'editFile', path, content }` | Whole-file replace; diff generated for approval |
| runCommand | `{ tool: 'runCommand', command, cwd?, timeoutMs? }` | QuickPick currently used for approval (future unify) |

## Approval Flow
1. Agent proposes write action.
2. Unified diff (or content preview for new file) generated client-side.
3. `approvalRequest` SSE + inline chat buttons.
4. User approves/rejects → `approvalDecision` broadcast → pending promise resolves.
5. Agent continues or reports rejection.

Timeout: 2 minutes auto-reject if no decision.

## History & Persistence
- Per-session JSONL file (if enabled) stores: inbound, outbound fragments, final aggregated answer.
- On startup, tail (config max) is reloaded and replayed.
- `/clear` truncates persisted file and memory list; broadcasts `historyCleared`.

## Settings
| Setting | Default | Description |
|---------|---------|-------------|
| `copilotAnywhere.server.port` | 3939 | HTTP/SSE port |
| `copilotAnywhere.server.host` | 127.0.0.1 | Host bind (use 0.0.0.0 for LAN) |
| `copilotAnywhere.security.allowOrigins` | ["*"] | CORS origins (tighten in prod) |
| `copilotAnywhere.http.autoInvoke` | true | Auto model call for HTTP prompts when agent disabled |
| `copilotAnywhere.http.injectIntoChat` | false | Inject inbound HTTP text into chat input instead of auto invoke |
| `copilotAnywhere.http.autoSubmit` | true | (Passive placeholder) |
| `copilotAnywhere.agent.enabled` | true | Enable autonomous agent loop |
| `copilotAnywhere.agent.maxSteps` | 12 | Step cap per goal |
| `copilotAnywhere.agent.allowedRoots` | ["*"] | Relative roots permitted ("*" = all) |
| `copilotAnywhere.agent.requireApproval` | true | Require approval for create/edit (and runCommand QuickPick) |
| `copilotAnywhere.persistence.enabled` | true | Enable persistence JSONL logs |
| `copilotAnywhere.persistence.directory` | (storage path) | Override persistence location |
| `copilotAnywhere.persistence.maxMessagesPerSession` | 500 | Tail size loaded at startup |

## Quick Start
```bash
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```
Open: http://localhost:3939/ (adjust host/port if reconfigured)

Send a goal via curl:
```bash
curl -X POST http://localhost:3939/message \
  -H 'Content-Type: application/json' \
  -d '{"text":"Create docs/architecture.md summarizing the agent loop"}'
```
Stream events:
```bash
curl -N http://localhost:3939/events
```

## Limitations / Known Gaps
- Whole-file edit only (no partial patch application)
- Simple diff (no context folding or large-file optimization)
- `runCommand` still uses a QuickPick (not bus-based approval yet)
- No cancellation of in-progress agent run (planned)
- No authentication / rate limiting (add before exposing publicly)
- Session IDs are absolute paths (privacy / noise)

## Roadmap (Short List)
1. Diff-based incremental edits
2. Search tool (regex / substring) with bounded results
3. Cancellation command & token propagation
4. Granular approval toggles (create vs edit vs command)
5. Auth & rate limiting for HTTP endpoints

## Development Tips
- Use `/run` for quick environment probes.
- `/clear` before demos to reset clutter.
- Keep agent goals concise; the controller summarizes actions/results automatically.
- For large edits: agent will show diff preview; refine goal if diff is noisy.

## Security Notes
- Treat the extension host boundary seriously—only enable `*` CORS in trusted local environments.
- Consider reverse proxy with auth when remote.

## License
MIT (add LICENSE file before publishing)
