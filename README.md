# Copilot Anywhere

Bridge GitHub Copilot Chat with external clients (web, mobile, webhook) via an extension-hosted HTTP + Server-Sent Events (SSE) gateway. Send prompts from anywhere; receive streaming AI responses in real-time.

## ✨ Features
- Chat Participant that proxies to Copilot chat models
- External HTTP ingress (`POST /message`) for new prompts
- Real-time streaming via SSE (`GET /events`)
- Broadcast of inbound and outbound fragments
- Simple in-memory message bus
- Built-in lightweight Web UI at `http://localhost:3939/` (input + live stream)
- Optional internal autonomous "agent" mode with structured tool calls (read/create/edit files)

## 🔌 HTTP API
### POST /message
Submit a new prompt.
```
POST http://localhost:3939/message
Content-Type: application/json

{ "text": "Explain the meaning of life in one sentence" }
```
Response:
```
202 Accepted
{ "accepted": true, "id": "<correlation-id>" }
```

### GET /events (SSE)
Receive streaming events.
Events:
- `inbound` : `{ id, text, source }`
- `fragment`: `{ id, fragment, model }`
- `done` : `{ id, model }`

Example:
```
GET http://localhost:3939/events
```
Client pseudo-code:
```js
const es = new EventSource('http://localhost:3939/events');
es.addEventListener('fragment', e => {
  const data = JSON.parse(e.data);
  console.log('Fragment', data.fragment);
});
```

## 🧩 VS Code Chat Usage
Open the GitHub Copilot Chat view and mention the participant:
```
@Copilot Anywhere How do I implement a binary search in TypeScript?
```
Streaming responses appear in chat and are forwarded to SSE clients.

## 🛠 Development
Install deps & compile:
```
npm install
npm run watch
```
Press F5 to launch the Extension Development Host.

## ⚙️ Configuration (Settings)
- `copilotAnywhere.server.port` (default 3939)
- `copilotAnywhere.server.host` (default 127.0.0.1)
- `copilotAnywhere.security.allowOrigins` (array, default ["*"])
- `copilotAnywhere.http.autoInvoke` (boolean, default true) – automatically run model for HTTP-submitted prompts
- `copilotAnywhere.http.injectIntoChat` (boolean, default true) – instead of autoInvoke, open Copilot Chat and prefill `@CopilotAnywhere <prompt>`
- `copilotAnywhere.http.autoSubmit` (boolean, default true) – (Currently passive) earlier versions attempted forced submit; now we rely on VS Code auto-submit or manual Enter to avoid duplicates.
- `copilotAnywhere.agent.enabled` (boolean, default true) – enable internal autonomous agent loop.
- `copilotAnywhere.agent.maxSteps` (number, default 12) – cap iterative reasoning/tool cycles.
- `copilotAnywhere.agent.allowedRoots` (array, default ["src","web","README.md"]) – restrict file access.
- `copilotAnywhere.agent.requireApproval` (boolean, default false) – ask before applying each edit.

## 🔒 Security Notes
- In development defaults are permissive. Tighten CORS (`allowOrigins`) before exposing externally.
- Consider adding an auth token header for production.

## 🧪 Quick Test with curl
# 🤖 Agent Mode
Enable in settings: `copilotAnywhere.agent.enabled = true`.

Send an agent job:
```
curl -X POST http://localhost:3939/message \
  -H 'Content-Type: application/json' \
  -d '{"text":"Create a README section summarizing agent features","mode":"agent"}'
```
Events you'll see:
* `inbound` – received request
* `fragment` – agent commentary & action results
* `done` – final summary

Tools supported now:
* readFiles { files: [paths] }
* createFile { path, content }
* editFile { path, content } (whole-file replace)

Agent JSON protocol (model output each step):
```
{
  "actions": [ { "tool": "readFiles", "files": ["src/copilotProxy.ts"] } ],
  "commentary": "Reading file",
  "done": false
}
```
Finish:
```
{ "finalSummary": "Added new section", "done": true }
```
If `requireApproval` is true, a quick pick appears before edits.

Limitations: diff-based edits not yet supported (model must supply full new content). JSON extraction is simplistic (last object in output). Keep model responses concise.

```
# Send a prompt
curl -X POST http://localhost:3939/message -H 'Content-Type: application/json' -d '{"text":"Say hello in French"}'

# Listen (in another terminal)
curl -N http://localhost:3939/events
```

## 🚧 Roadmap / Ideas
- WebSocket support
- Persistent session + history reconstruction
- Auth tokens & rate limiting
- Multi-model routing and selection
- Retry / backoff for model errors

## License
MIT (add LICENSE file before publishing)
