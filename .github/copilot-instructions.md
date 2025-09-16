## Copilot Anywhere – Agent-Oriented Instructions

Structured context for autonomous / semi‑autonomous agents and contributors.

### 1. Purpose
Bridge VS Code Copilot Chat with external HTTP + SSE clients and provide an internal multi-step agent to inspect & modify the workspace via controlled tools.

### 2. Key Files
- `src/extension.ts` – Activation & wiring of server, chat participant, agent.
- `src/chatParticipant.ts` – Chat handling, agent prefix, session inference, sessionId tagging.
- `src/externalServer.ts` – HTTP endpoints (`/`, `/message`, `/sessions`, `/events`), auto session creation from workspace folders, SSE.
- `src/messageBus.ts` – In‑memory pub/sub (inbound/outbound fragments, optional sessionId).
- `src/copilotProxy.ts` – Model invocation & streaming fragments.
- `src/agentController.ts` – Iterative agent loop (JSON extraction, retries, action enforcement, streaming commentary).
- `src/agentTools.ts` – File system tools (`listFiles`, `readFiles`, `createFile`, `editFile`).
- `web/index.html` – Browser UI (projects sidebar, streaming log, notifications, session filter).

### 3. Settings (`copilotAnywhere.*`)
| Setting | Description |
|---------|-------------|
| server.port / server.host | HTTP listener address |
| http.injectIntoChat | Inject HTTP prompts into Copilot Chat input (no auto-submit) |
| agent.enabled | Enable/disable agent loop |
| agent.prefix | Chat trigger (default `agent:`) |
| agent.maxSteps | Max agent iterations |
| agent.allowedRoots | Safe relative roots (`*` = full workspace) |
| agent.requireApproval | Require user confirmation before applying edits |

(Values read at activation; future improvement: hot reload on config change.)

### 4. Sessions / Projects
- Auto-created from workspace folders (session id = absolute folder path; name = basename).
- Default single session if no folders.
- Web UI filters SSE via `?session=<id>`.
- Chat messages auto-tagged with sessionId (active editor's folder → fallback first folder).
- Outbound fragments tagged by correlation with stored inbound messages.

Limitations: no persistence, absolute path IDs, no dynamic refresh on folder changes (requires reload), no deletion.

### 5. Agent Loop Overview
1. Build chat history: system instructions + goal + prior tool feedback.
2. Receive model text → extract JSON (code fence & brace matching strategies).
3. Validate: non-final step must contain ≥1 action.
4. Execute actions sequentially using tools; capture results.
5. Stream commentary, actions, tool results.
6. Stop when `done` or max steps reached.

Resilience: multi-candidate JSON extraction, retry with corrective message, empty action rejection, step progress headers, parse diagnostics.

### 6. Tools & Schemas
```
listFiles  {"tool":"listFiles","glob":"partial","max":50}
readFiles  {"tool":"readFiles","files":["src/file.ts"]}
createFile {"tool":"createFile","path":"docs/new.md","content":"text"}
editFile   {"tool":"editFile","path":"src/file.ts","content":"<entire new file>"}
```
Non-final step JSON:
```
{"actions":[...],"commentary":"Short reason","done":false}
```
Final step JSON:
```
{"finalSummary":"Summary of changes","done":true}
```
Constraints: `editFile` = whole-file replacement only; must have read file earlier (convention).

### 7. HTTP / SSE API
| Endpoint | Method | Body | Notes |
|----------|--------|------|-------|
| / | GET | – | Web UI |
| /sessions | GET | – | List current sessions |
| /message | POST | `{ text, sessionId?, mode?, maxSteps? }` | `mode:"agent"` triggers agent run |
| /events | GET | – | SSE; optional `?session=` filter |

SSE events: `inbound`, `fragment`, `done` (each JSON with `id`, and possibly `sessionId`, `model`).

### 8. Typical Agent Patterns
| Goal | Suggested Sequence |
|------|--------------------|
| Explore code | listFiles (glob) → readFiles |
| Add documentation | readFiles (context) → createFile → finalSummary |
| Modify single file | readFiles target → editFile → finalSummary |
| Multi-file refactor | listFiles narrowed → iterative readFiles → multiple editFile actions → finalSummary |

Guidelines: keep commentary ≤160 chars; limit file scope; prefer narrow globs.

### 9. Safety / Security
- Enforce `agent.allowedRoots` for file operations.
- No authentication on HTTP endpoints (development use case). Add key / origin filtering before production exposure.
- Avoid editing large/binary files (future enhancement: skip heuristics).

### 10. Backlog / Improvements
1. Diff-based editing tool (apply unified diff).
2. Tools for unsaved buffers (`readActiveDocument`, `applyActiveEdit`).
3. Search tool (regex / substring) with bounded results.
4. Cancellation command (`copilotAnywhere.agent.cancel`) & token propagation.
5. Config hot-reload listener (reinitialize components on change).
6. Session persistence (JSON store) + hashed/short IDs + change events.
7. Auth & rate limiting for `/message`.
8. Model fallback / multi-model selection.
9. Diff preview in approval prompt.
10. Stream chunking & compression for large responses.

### 11. Coding Conventions
- TypeScript strict; limit `any`.
- Keep modules cohesive & avoid circular deps.
- Prefer async fs for new code (legacy sync reads tolerated for now).
- Keep network/server code defensive (validate JSON bodies).

### 12. JSON Action Templates (Copy/Paste)
Read file:
`{"actions":[{"tool":"readFiles","files":["src/extension.ts"]}],"commentary":"Inspect entry point","done":false}`

Edit file (after reading):
`{"actions":[{"tool":"editFile","path":"src/agentTools.ts","content":"<full new content>"}],"commentary":"Refactor tools","done":false}`

Finalize:
`{"finalSummary":"Refactored agent tools for clarity","done":true}`

### 13. Troubleshooting Matrix
| Symptom | Cause | Resolution |
|---------|-------|-----------|
| Empty actions rejected | Model omitted actions | Add `readFiles` or another tool action |
| Repeated JSON parse errors | Extra prose / multiple objects | Tighten output; remind model to output single JSON |
| Edits not applied | Path outside allowedRoots / unsaved | Save file or expand allowedRoots |
| Session mismatch | Missing sessionId | Provide `sessionId` or ensure active editor is in target folder |
| Agent stalls early | Invalid JSON two attempts | Add clarifying user message with schema example |

### 14. Known Limitations
- Whole-file edits only (no incremental patch).
- No persistence for sessions.
- Unsaved buffers inaccessible to tools.
- Session IDs are absolute paths (privacy/noise).
- Single-model selection; no fallback.

### 15. Suggested Roadmap (Order)
Diff editing → Search tool → Cancellation → Persistence + hashed IDs → Editor tools → Auth/rate limit.

### 16. Glossary
- Fragment: streamed output chunk.
- Session/Project: workspace folder context bucket.
- Tool Action: JSON directive executed by agent loop.
