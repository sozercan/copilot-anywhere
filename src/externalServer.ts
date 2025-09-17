import * as http from 'http';
import { MessageBus, InboundMessage } from './messageBus';
import { AgentController } from './agentController';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface ServerOptions {
  port: number;
  host: string;
  allowOrigins: string[];
}

export class ExternalServer {
  private server?: http.Server;
  private sseClients = new Set<http.ServerResponse>();
    private sessions: Map<string, { id: string; name: string; created: number; messages: any[] }> = new Map();
  private clientSessionMap: Map<http.ServerResponse, string | undefined> = new Map();

  constructor(private options: ServerOptions, private bus: MessageBus, private proxy: any, private output: vscode.OutputChannel, private webRoot?: string, private autoInvoke: boolean = true, private agent?: AgentController, private agentEnabled: boolean = false) {}

  async start() {
    // Auto create sessions based on workspace folders (run once)
    if (this.sessions.size === 0) {
      const folders = vscode.workspace.workspaceFolders || [];
      if (folders.length) {
        for (const f of folders) {
          const id = f.uri.fsPath; // stable id
            this.sessions.set(id, { id, name: path.basename(f.uri.fsPath), created: Date.now(), messages: [] });
        }
      } else {
        this.sessions.set('default-session', { id: 'default-session', name: 'default', created: Date.now(), messages: [] });
      }
    }

    this.server = http.createServer(async (req, res) => {
      // CORS
      const origin = req.headers.origin || '*';
      if (this.isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

      // Basic routing parse (ignore query part for path)
      const fullUrl = req.url || '/';
      const [pathPart, queryString] = fullUrl.split('?');
      const queryParams = new URLSearchParams(queryString || '');

      if (pathPart === '/' && req.method === 'GET') {
        const indexPath = this.webRoot ? path.join(this.webRoot, 'web', 'index.html') : undefined;
        if (indexPath && fs.existsSync(indexPath)) {
          const html = fs.readFileSync(indexPath);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Copilot Anywhere Web UI missing');
        return;
      }

      if (pathPart === '/sessions' && req.method === 'GET') {
        // List sessions
        res.writeHead(200, { 'Content-Type': 'application/json'});
        res.end(JSON.stringify(Array.from(this.sessions.values()).map(s => ({ id: s.id, name: s.name, created: s.created, count: s.messages.length }))));
        return;
      }

        if (pathPart === '/context' && req.method === 'GET') {
            // Provide full context (all sessions with messages). WARNING: can be large.
            const payload = Array.from(this.sessions.values()).map(s => ({
                id: s.id,
                name: s.name,
                created: s.created,
                messages: s.messages
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessions: payload }));
            return;
        }

      if (pathPart === '/sessions' && req.method === 'POST') { res.writeHead(405); res.end('auto-managed'); return; }

      if (pathPart?.startsWith('/sessions/') && req.method === 'GET') {
          // Support encoded IDs (absolute paths encoded with encodeURIComponent)
          const sidRaw = pathPart.substring('/sessions/'.length);
          let sid: string;
          try { sid = decodeURIComponent(sidRaw); } catch { sid = sidRaw; }
        const sess = this.sessions.get(sid);
        if (!sess) { res.writeHead(404); res.end('No session'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json'});
        res.end(JSON.stringify({ id: sess.id, name: sess.name, messages: sess.messages }));
        return;
      }

      if (pathPart === '/message' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const text = parsed.text || parsed.message;
            const sessionId = parsed.sessionId as string | undefined;
            if (!text) {
              res.writeHead(400); res.end(JSON.stringify({ error: 'text required'})); return;
            }
            const msg: InboundMessage & { sessionId?: string } = { id: Date.now().toString(), text, source: 'http', sessionId };
            if (sessionId) {
              const sess = this.sessions.get(sessionId);
              if (sess) sess.messages.push(msg);
            }
            this.bus.emitInbound(msg);
            res.writeHead(202, { 'Content-Type': 'application/json'});
            res.end(JSON.stringify({ accepted: true, id: msg.id, sessionId }));
            if (this.agentEnabled && parsed.mode === 'agent' && this.agent) {
              try {
                this.agent.run({ goal: text, id: msg.id, maxSteps: parsed.maxSteps || 12 });
              } catch (e: any) {
                this.output.appendLine(`[CopilotAnywhere] Agent error: ${e.message || e}`);
              }
            } else if (this.autoInvoke) {
              try {
                await this.proxy.runPromptDirect(text, msg.id);
              } catch (e: any) {
                this.output.appendLine(`[CopilotAnywhere] Auto invoke error: ${e.message || e}`);
              }
            }
          } catch (e: any) {
            res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      if (pathPart === '/events' && req.method === 'GET') {
        const sessionFilter = queryParams.get('session') || undefined;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        res.write('\n');
        this.sseClients.add(res);
        this.clientSessionMap.set(res, sessionFilter);
        req.on('close', () => this.sseClients.delete(res));
        return;
      }

      res.writeHead(404); res.end('Not Found');
    });

    this.server.listen(this.options.port, this.options.host, () => {
      this.output.appendLine(`[CopilotAnywhere] Server listening on http://${this.options.host}:${this.options.port}`);
    });

    // bus listeners
    this.bus.onInbound(msg => {
      // If message has a sessionId, append to that session's history (covers chat-originated messages)
      if (msg.sessionId) {
        let target = this.sessions.get(msg.sessionId);
          if (!target) {
            this.sessions.set(msg.sessionId, { id: msg.sessionId, name: path.basename(msg.sessionId) || 'session', created: Date.now(), messages: [] });
            target = this.sessions.get(msg.sessionId);
        }
          target?.messages.push({ ...msg, direction: 'inbound' });
      }
      this.broadcast({ event: 'inbound', data: msg });
    });
    this.bus.onOutbound(frag => {
      // Try to match correlation id to a session
      let sessionId: string | undefined;
      for (const sess of this.sessions.values()) {
        if (sess.messages.find(m => m.id === frag.id)) { sessionId = sess.id; break; }
      }
      const withSession = { ...frag, sessionId };
        if (sessionId) {
            const sess = this.sessions.get(sessionId);
            if (sess) {
                sess.messages.push({ id: frag.id, fragment: frag.fragment, model: frag.model, done: !!frag.done, direction: 'outbound' });
            }
        }
      this.broadcast({ event: 'fragment', data: withSession });
      if (frag.done) this.broadcast({ event: 'done', data: { id: frag.id, model: frag.model, sessionId } });
    });
  }

  private isOriginAllowed(origin: string): boolean {
    if (this.options.allowOrigins.includes('*')) return true;
    return this.options.allowOrigins.includes(origin);
  }

  private broadcast(payload: { event: string; data: any }) {
    const line = `event: ${payload.event}\ndata: ${JSON.stringify(payload.data)}\n\n`;
    for (const client of this.sseClients) {
      const filterSession = this.clientSessionMap.get(client);
      if (filterSession) {
        const sessionId = (payload.data && (payload.data.sessionId || (payload.data.id && payload.data.sessionId))) || undefined;
        if (sessionId && sessionId !== filterSession) continue;
        // If payload lacks sessionId we allow only if filterSession not set
        if (!sessionId && filterSession) continue;
      }
      client.write(line);
    }
  }

  dispose() {
    for (const client of this.sseClients) client.end();
    this.server?.close();
  }
}
