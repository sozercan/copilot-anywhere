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

  constructor(private options: ServerOptions, private bus: MessageBus, private proxy: any, private output: vscode.OutputChannel, private webRoot?: string, private autoInvoke: boolean = true, private agent?: AgentController, private agentEnabled: boolean = false) {}

  async start() {
    this.server = http.createServer(async (req, res) => {
      // CORS
      const origin = req.headers.origin || '*';
      if (this.isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

      if (req.url === '/' && req.method === 'GET') {
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

      if (req.url === '/message' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const text = parsed.text || parsed.message;
            if (!text) {
              res.writeHead(400); res.end(JSON.stringify({ error: 'text required'})); return;
            }
            const msg: InboundMessage = { id: Date.now().toString(), text, source: 'http' };
            this.bus.emitInbound(msg);
            res.writeHead(202, { 'Content-Type': 'application/json'});
            res.end(JSON.stringify({ accepted: true, id: msg.id }));
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

      if (req.url === '/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        res.write('\n');
        this.sseClients.add(res);
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
      // Could optionally trigger auto-response by invoking chat participant programmatically
      // For MVP we just broadcast inbound messages to SSE
      this.broadcast({ event: 'inbound', data: msg });
    });
    this.bus.onOutbound(frag => {
      this.broadcast({ event: 'fragment', data: frag });
      if (frag.done) this.broadcast({ event: 'done', data: { id: frag.id, model: frag.model } });
    });
  }

  private isOriginAllowed(origin: string): boolean {
    if (this.options.allowOrigins.includes('*')) return true;
    return this.options.allowOrigins.includes(origin);
  }

  private broadcast(payload: { event: string; data: any }) {
    const line = `event: ${payload.event}\ndata: ${JSON.stringify(payload.data)}\n\n`;
    for (const client of this.sseClients) {
      client.write(line);
    }
  }

  dispose() {
    for (const client of this.sseClients) client.end();
    this.server?.close();
  }
}
