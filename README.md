<div align="center">

# Copilot Anywhere

Autonomous workspace agent + HTTP/SSE bridge + minimal web UI — all inside a VS Code extension.

</div>

## Features
* Autonomous multi‑step agent (read / list / create / edit / run)
* Multiple surfaces: VS Code Chat, HTTP API, SSE stream, minimal web UI
* Safe edits: allowed roots + approval with unified diff preview
* Persistence (optional) to reload recent session context
* Multi-root aware with diagnostics + fallback discovery
* Fast troubleshooting: `/diag` for roots & sample files

### Architecture
```
┌────────────┐      ┌──────────────────┐      ┌───────────────────────┐
│ VS Code UI │──┐   │ Message Bus      │   ┌─▶│ External Server (HTTP)│
└──────┬─────┘  │   └────────┬─────────┘   │  └──────────┬────────────┘
  │ Chat Participant    │             │             │ SSE (events)
  │ (Agent Loop)        │             │             ▼
  │        ┌────────────▼──────┐      │      ┌────────────┐
  │        │ Agent Controller  │      │      │  Web UI    │
  │        └───────┬──────────┘       │      └────────────┘
  │                │ Tools            │
  │                ▼                  │
  │        (FS + Shell Actions)       │
  └───────────────────────────────────┘
```

## Key Tools
`listFiles`, `readFiles`, `createFile`, `editFile` (whole-file replace with diff), `runCommand`

## Slash Commands
`/files` recent changed files · `/run <cmd>` shell · `/clear` reset history · `/diag` discovery diagnostics

## Fast Start
```bash
npm install
npm run compile
# Press F5 to launch Extension Development Host
```
Send a goal:
```bash
curl -X POST http://localhost:1337/message \
  -H 'Content-Type: application/json' \
  -d '{"text":"Generate a concise README"}'
```
Stream events:
```bash
curl -N http://localhost:1337/events
```

## Limitations
- Whole-file edits only
- Simple diff algorithm
- No cancellation yet
- No auth/rate limiting
- Naive broad scan fallback.

## Future Work
* Multi-agent orchestration (specialists / planner-executor)
* Diff-based incremental edits
* Search tool (regex / indexed)
* Cancellation & run status
* Auth + rate limiting
* Ignore/include patterns & depth control
