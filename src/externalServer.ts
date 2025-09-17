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
    persistence?: {
        enabled: boolean;
        dir: string; // absolute directory
        maxMessages: number;
    };
}

export class ExternalServer {
  private server?: http.Server;
  private sseClients = new Set<http.ServerResponse>();
    private sessions: Map<string, { id: string; name: string; created: number; messages: any[] }> = new Map();
  private clientSessionMap: Map<http.ServerResponse, string | undefined> = new Map();
    private messageSessionIndex: Map<string, string> = new Map();
    private persistedInboundIds: Set<string> = new Set();
    private pendingOutboundBuffers: Map<string, { fragments: string[]; model?: string; done?: boolean }> = new Map();
    private approvalSessionIndex: Map<string, string | undefined> = new Map();

  constructor(private options: ServerOptions, private bus: MessageBus, private proxy: any, private output: vscode.OutputChannel, private webRoot?: string, private autoInvoke: boolean = true, private agent?: AgentController, private agentEnabled: boolean = false) {}

  async start() {
      if (this.options.persistence?.enabled) {
          await this.ensureDir(this.options.persistence.dir);
          await this.loadPersistence();
      }
    // Auto create sessions based on workspace folders (run once)
    if (this.sessions.size === 0) {
      const folders = vscode.workspace.workspaceFolders || [];
      if (folders.length) {
        for (const f of folders) {
          const id = f.uri.fsPath; // stable id
            if (!this.sessions.has(id)) {
                this.sessions.set(id, { id, name: path.basename(f.uri.fsPath), created: Date.now(), messages: [] });
            }
        }
      } else {
          if (!this.sessions.has('default-session')) {
            this.sessions.set('default-session', { id: 'default-session', name: 'default', created: Date.now(), messages: [] });
        }
        }
        await this.persistSessionsMeta();
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

        if (pathPart === '/persistence/status' && req.method === 'GET') {
            const enabled = !!this.options.persistence?.enabled;
            const status = {
                enabled,
                dir: this.options.persistence?.dir,
                sessions: Array.from(this.sessions.values()).map(s => ({ id: s.id, name: s.name, messageCount: s.messages.length })),
                mappingEntries: this.messageSessionIndex.size,
                pendingBuffers: Array.from(this.pendingOutboundBuffers.entries()).map(([id, buf]) => ({ id, fragments: buf.fragments.length, done: buf.done })),
                timestamp: Date.now()
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status, null, 2));
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
                if (sess) {
                    sess.messages.push(msg);
                    this.messageSessionIndex.set(msg.id, sessionId);
                    if (this.options.persistence?.enabled) {
                        await this.persistMessage(sessionId, { type: 'inbound', ...msg });
                        this.persistedInboundIds.add(msg.id);
                    }
                }
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

        if (pathPart === '/approval' && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body || '{}');
                    const approvalId = parsed.approvalId; const approved = !!parsed.approved;
                    if (!approvalId) { res.writeHead(400); res.end(JSON.stringify({ error: 'approvalId required' })); return; }
                    this.bus.emitApprovalDecision({ approvalId, approved });
                    this.broadcast({ event: 'approvalDecision', data: { approvalId, approved } });
                    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
                } catch (e: any) {
                    res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
                }
            });
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
            this.persistSessionsMeta();
        }
          target?.messages.push({ ...msg, direction: 'inbound' });
          if (this.options.persistence?.enabled) {
              if (!this.persistedInboundIds.has(msg.id)) {
                  this.persistMessage(msg.sessionId, { type: 'inbound', ...msg, direction: 'inbound' });
                  this.persistedInboundIds.add(msg.id);
              }
          }
          this.messageSessionIndex.set(msg.id, msg.sessionId);
          // Flush any buffered outbound fragments that arrived before we knew the session
          const pending = this.pendingOutboundBuffers.get(msg.id);
          if (pending) {
              const sess = this.sessions.get(msg.sessionId);
              if (sess) {
                  for (const frag of pending.fragments) {
                      sess.messages.push({ id: msg.id, fragment: frag, model: pending.model, done: false, direction: 'outbound' });
                      if (this.options.persistence?.enabled) {
                          this.persistMessage(msg.sessionId, { type: 'outbound', id: msg.id, fragment: frag, model: pending.model, done: false, direction: 'outbound', ts: Date.now() });
                      }
                  }
                  if (pending.done) {
                      // Persist aggregated final answer
                      const full = pending.fragments.join('');
                      if (full) {
                          sess.messages.push({ id: msg.id, fragment: full, model: pending.model, done: true, direction: 'outbound', aggregated: true });
                          if (this.options.persistence?.enabled) {
                              this.persistMessage(msg.sessionId, { type: 'final', id: msg.id, full, model: pending.model, direction: 'outbound', ts: Date.now() });
                          }
                      }
                  }
              }
              this.pendingOutboundBuffers.delete(msg.id);
          }
      }
      this.broadcast({ event: 'inbound', data: msg });
    });
    this.bus.onOutbound(frag => {
      // Try to match correlation id to a session
        let sessionId: string | undefined = this.messageSessionIndex.get(frag.id);
        if (!sessionId) {
            for (const sess of this.sessions.values()) {
                if (sess.messages.find(m => m.id === frag.id)) { sessionId = sess.id; break; }
            }
            if (sessionId) this.messageSessionIndex.set(frag.id, sessionId);
        }
        if (!sessionId && this.sessions.size === 1) {
            sessionId = Array.from(this.sessions.values())[0].id;
            this.messageSessionIndex.set(frag.id, sessionId);
      }
      const withSession = { ...frag, sessionId };
        if (!sessionId) {
            // Buffer until we learn the session (inbound might not have been processed yet for some reason)
            const buf = this.pendingOutboundBuffers.get(frag.id) || { fragments: [], model: frag.model, done: false };
            if (frag.fragment) buf.fragments.push(frag.fragment);
            if (frag.done) buf.done = true;
            this.pendingOutboundBuffers.set(frag.id, buf);
        } else {
            const sess = this.sessions.get(sessionId);
            if (sess) {
            if (frag.fragment) {
              sess.messages.push({ id: frag.id, fragment: frag.fragment, model: frag.model, done: !!frag.done, direction: 'outbound' });
                if (this.options.persistence?.enabled) {
                    this.persistMessage(sessionId, { type: 'outbound', id: frag.id, fragment: frag.fragment, model: frag.model, done: !!frag.done, direction: 'outbound', ts: Date.now() });
                }
            }
            if (frag.done) {
                // Build aggregated final answer from this run's fragments
                const related = sess.messages.filter(m => m.id === frag.id && m.direction === 'outbound' && m.fragment && !m.aggregated);
                const full = related.map(r => r.fragment).join('');
                if (full) {
                    sess.messages.push({ id: frag.id, fragment: full, model: frag.model, done: true, direction: 'outbound', aggregated: true });
                    if (this.options.persistence?.enabled) {
                        this.persistMessage(sessionId, { type: 'final', id: frag.id, full, model: frag.model, direction: 'outbound', ts: Date.now() });
                    }
                }
            }
          }
      }
      this.broadcast({ event: 'fragment', data: withSession });
      if (frag.done) this.broadcast({ event: 'done', data: { id: frag.id, model: frag.model, sessionId } });
    });

      // Approval request forwarding
    this.bus.onApprovalRequest(req => {
      // Try to attach sessionId from correlation id mapping (agent run id == inbound id)
      const sessionId = this.messageSessionIndex.get(req.correlationId);
      this.approvalSessionIndex.set(req.approvalId, sessionId); // record for later decision broadcast
      this.broadcast({ event: 'approvalRequest', data: { ...req, sessionId } });
    });
    this.bus.onApprovalDecision(dec => {
      const sessionId = this.approvalSessionIndex.get(dec.approvalId);
      this.broadcast({ event: 'approvalDecision', data: { ...dec, sessionId } });
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

    private async ensureDir(dir: string) {
        try { await fs.promises.mkdir(dir, { recursive: true }); } catch { }
    }

    private sessionsMetaPath() {
        return path.join(this.options.persistence!.dir, 'sessions.json');
    }

    private safeFileName(sessionId: string) {
        return path.join(this.options.persistence!.dir, encodeURIComponent(sessionId) + '.jsonl');
    }

    private async persistSessionsMeta() {
        if (!this.options.persistence?.enabled) return;
        const meta = Array.from(this.sessions.values()).map(s => ({ id: s.id, name: s.name, created: s.created }));
        try {
            await fs.promises.writeFile(this.sessionsMetaPath(), JSON.stringify({ sessions: meta }, null, 2), 'utf8');
        } catch (e: any) {
            this.output.appendLine(`[CopilotAnywhere] Failed to write sessions meta: ${e.message}`);
        }
    }

    private async persistMessage(sessionId: string, record: any) {
        if (!this.options.persistence?.enabled) return;
        const file = this.safeFileName(sessionId);
        const line = JSON.stringify({ ...record, ts: record.ts || Date.now() }) + '\n';
        try { await fs.promises.appendFile(file, line, 'utf8'); } catch (e: any) {
            this.output.appendLine(`[CopilotAnywhere] Failed to append message: ${e.message}`);
        }
    }

    private async loadPersistence() {
        if (!this.options.persistence?.enabled) return;
        // load sessions meta
        let meta: { sessions: { id: string; name: string; created: number }[] } | undefined;
        try {
            const raw = await fs.promises.readFile(this.sessionsMetaPath(), 'utf8');
            meta = JSON.parse(raw);
        } catch { }
        if (meta?.sessions) {
            for (const s of meta.sessions) {
                this.sessions.set(s.id, { id: s.id, name: s.name, created: s.created, messages: [] });
                await this.loadSessionMessages(s.id);
            }
        }
    }

    private async loadSessionMessages(sessionId: string) {
        if (!this.options.persistence?.enabled) return;
        const file = this.safeFileName(sessionId);
        if (!fs.existsSync(file)) return;
        try {
            const raw = await fs.promises.readFile(file, 'utf8');
            const lines = raw.split(/\r?\n/).filter(l => l.trim());
            const max = this.options.persistence!.maxMessages;
            const slice = lines.slice(-max);
            const seenInbound = new Set<string>();
            for (const line of slice) {
                try {
                    const rec = JSON.parse(line);
                    if (!rec || !rec.id) continue;
                    if (rec.type === 'inbound') {
                        if (seenInbound.has(rec.id)) continue; // dedupe
                        this.sessions.get(sessionId)?.messages.push({ id: rec.id, text: rec.text, source: rec.source, direction: 'inbound', ts: rec.ts });
                        this.messageSessionIndex.set(rec.id, sessionId);
                        this.persistedInboundIds.add(rec.id);
                        seenInbound.add(rec.id);
                    } else if (rec.type === 'outbound') {
                        this.sessions.get(sessionId)?.messages.push({ id: rec.id, fragment: rec.fragment, model: rec.model, done: rec.done, direction: 'outbound', ts: rec.ts });
                    } else if (rec.type === 'final') {
                        // Recreate aggregated final answer representation
                        this.sessions.get(sessionId)?.messages.push({ id: rec.id, fragment: rec.full, model: rec.model, done: true, direction: 'outbound', aggregated: true, ts: rec.ts });
                    }
                } catch { }
            }
        } catch (e: any) {
            this.output.appendLine(`[CopilotAnywhere] Failed to load session messages for ${sessionId}: ${e.message}`);
        }
    }

}
