import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

export interface ToolActionBase { tool: string; }
export interface ReadFilesAction extends ToolActionBase { tool: 'readFiles'; files: string[]; }
export interface EditFileAction extends ToolActionBase { tool: 'editFile'; path: string; content?: string; diff?: string; }
export interface CreateFileAction extends ToolActionBase { tool: 'createFile'; path: string; content: string; }
export interface ListFilesAction extends ToolActionBase { tool: 'listFiles'; glob?: string; max?: number; }
export interface RunCommandAction extends ToolActionBase { tool: 'runCommand'; command: string; cwd?: string; timeoutMs?: number; }
export type ToolAction = ReadFilesAction | EditFileAction | CreateFileAction | ListFilesAction | RunCommandAction;

export interface ToolResult { tool: string; success: boolean; detail?: any; error?: string; }

export interface AgentToolsOptions {
  workspaceRoot: string;
  allowedRoots: string[]; // relative allowed roots
  requireApproval: boolean;
    bus?: { emitApprovalRequest: (r: any) => void; onApprovalDecision: (l: (d: any) => void) => () => void };
}

export class AgentTools {
  constructor(private opts: AgentToolsOptions) {}

  private currentCorrelationId: string | undefined;
  setCorrelationId(id: string) { this.currentCorrelationId = id; }

    private pendingApprovals: Map<string, { resolve: (approved: boolean) => void }> = new Map();

    private async requestApproval(kind: 'editFile' | 'createFile', pathRel: string, diff?: string, contentPreview?: string): Promise<boolean> {
        if (!this.opts.requireApproval) return true;
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Native chat approval: no QuickPick (handled via chat buttons / web modal)
    let quickPickDecision: boolean | undefined; // retained for future fallback
        const p = new Promise<boolean>(resolve => {
            this.pendingApprovals.set(id, { resolve });
            // Timeout fallback (auto reject after 2 minutes if no decision)
            setTimeout(() => { if (this.pendingApprovals.has(id)) { this.pendingApprovals.get(id)!.resolve(false); this.pendingApprovals.delete(id); } }, 120000);
        });
        // Emit through bus so web UI can render approval dialog
  this.opts.bus?.emitApprovalRequest({ approvalId: id, correlationId: this.currentCorrelationId || 'N/A', action: kind, path: pathRel, diff, contentPreview });
        if (quickPickDecision !== undefined) {
            // Resolve immediately but still allow web override until resolved
            const entry = this.pendingApprovals.get(id);
            if (entry) { entry.resolve(quickPickDecision); this.pendingApprovals.delete(id); }
            return quickPickDecision;
        }
        if (!this.opts.bus) return quickPickDecision ?? true;
        // Listen for decision
        this.opts.bus.onApprovalDecision((d: any) => {
            if (d.approvalId === id) {
                const entry = this.pendingApprovals.get(id);
                if (entry) { entry.resolve(!!d.approved); this.pendingApprovals.delete(id); }
            }
        });
        return p;
    }

  private isAllowed(rel: string): boolean {
    if (this.opts.allowedRoots.includes('*')) return true;
    return this.opts.allowedRoots.some(root => {
      if (root === rel) return true;
      if (root.endsWith('/') && rel.startsWith(root)) return true;
      return rel === root || rel.startsWith(root + '/');
    });
  }

  async execute(actions: ToolAction[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const a of actions) {
      try {
        if (a.tool === 'readFiles') {
          const act = a as ReadFilesAction;
          const files: any[] = [];
          for (const f of act.files) {
            const abs = path.join(this.opts.workspaceRoot, f);
            if (!this.isAllowed(f)) { files.push({ path: f, error: 'Not allowed'}); continue; }
            if (!fs.existsSync(abs)) { files.push({ path: f, error: 'Not found'}); continue; }
            const content = fs.readFileSync(abs, 'utf8');
            files.push({ path: f, content });
          }
          results.push({ tool: 'readFiles', success: true, detail: { files } });
        } else if (a.tool === 'listFiles') {
          const act = a as ListFilesAction;
          const max = act.max && act.max > 0 ? Math.min(act.max, 500) : 200;
          const glob = act.glob?.toLowerCase();
          const collected: string[] = [];
          const roots = this.opts.allowedRoots.includes('*') ? [''] : this.opts.allowedRoots.map(r => r.replace(/\\/g,'/'));
          const walk = (relDir: string) => {
            if (collected.length >= max) return;
            const absDir = path.join(this.opts.workspaceRoot, relDir);
            let entries: fs.Dirent[] = [];
            try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
              const relPath = path.posix.join(relDir || '', e.name);
              if (e.isDirectory()) {
                walk(relPath);
                if (collected.length >= max) break;
              } else if (e.isFile()) {
                if (!this.isAllowed(relPath)) continue;
                if (!glob || relPath.toLowerCase().includes(glob)) {
                  collected.push(relPath);
                  if (collected.length >= max) break;
                }
              }
            }
          };
          for (const root of roots) {
            walk(root.replace(/\/$/, ''));
            if (collected.length >= max) break;
          }
          results.push({ tool: 'listFiles', success: true, detail: { files: collected, truncated: collected.length >= max } });
        } else if (a.tool === 'createFile') {
          const act = a as CreateFileAction;
            if (!this.isAllowed(act.path)) { throw new Error('Not allowed'); }
            const abs = path.join(this.opts.workspaceRoot, act.path);
            if (fs.existsSync(abs)) throw new Error('File exists');
            const approved = await this.requestApproval('createFile', act.path, undefined, (act.content || '').slice(0, 800));
            if (!approved) throw new Error('User rejected create');
            await fs.promises.mkdir(path.dirname(abs), { recursive: true });
            await fs.promises.writeFile(abs, act.content ?? '', 'utf8');
            results.push({ tool: 'createFile', success: true, detail: { path: act.path } });
        } else if (a.tool === 'editFile') {
          const act = a as EditFileAction;
          if (!this.isAllowed(act.path)) throw new Error('Not allowed');
          const abs = path.join(this.opts.workspaceRoot, act.path);
          if (!fs.existsSync(abs)) throw new Error('File missing');
          // For MVP prefer whole-file replacement if content provided; ignore diff for now (future: parse unified diff)
          if (act.content) {
              let existing = '';
              try { existing = fs.readFileSync(abs, 'utf8'); } catch { }
              const diff = this.buildUnifiedDiff(act.path, existing, act.content);
              const approved = await this.requestApproval('editFile', act.path, diff);
              if (!approved) throw new Error('User rejected edit');
            await fs.promises.writeFile(abs, act.content, 'utf8');
            results.push({ tool: 'editFile', success: true, detail: { path: act.path, mode: 'replace' } });
          } else {
            results.push({ tool: 'editFile', success: false, error: 'No content field (diff parsing not implemented yet)' });
          }
        } else if (a.tool === 'runCommand') {
          const act = a as RunCommandAction;
          if (!act.command) throw new Error('Missing command');
          // Restrict cwd to allowed roots (if provided)
          let relCwd = act.cwd?.replace(/\\/g,'/');
          if (relCwd) {
            if (!this.isAllowed(relCwd)) throw new Error('cwd not allowed');
          } else {
            relCwd = '';
          }
          const absCwd = path.join(this.opts.workspaceRoot, relCwd);
          const timeoutMs = act.timeoutMs && act.timeoutMs > 0 ? Math.min(act.timeoutMs, 20000) : 8000;
          if (this.opts.requireApproval) {
            const approve = await vscode.window.showQuickPick(['Run command', 'Cancel'], { placeHolder: `Agent run: ${act.command}` });
            if (approve !== 'Run command') throw new Error('User rejected command');
          }
          const detail = await new Promise<any>((resolve) => {
            const child = exec(act.command, { cwd: absCwd, timeout: timeoutMs, maxBuffer: 1024 * 512 }, (error, stdout, stderr) => {
              const truncatedStdout = stdout.length > 8000 ? stdout.slice(0,8000) + '...[truncated]' : stdout;
              const truncatedStderr = stderr.length > 4000 ? stderr.slice(0,4000) + '...[truncated]' : stderr;
              resolve({
                command: act.command,
                cwd: relCwd || '.',
                code: (error as any)?.code ?? 0,
                signal: (error as any)?.signal,
                stdout: truncatedStdout,
                stderr: truncatedStderr,
                timedOut: (error as any)?.killed && (error as any)?.signal === 'SIGTERM'
              });
            });
          });
          results.push({ tool: 'runCommand', success: true, detail });
        } else {
          const anyAction: any = a as any;
          results.push({ tool: anyAction.tool || 'unknown', success: false, error: 'Unknown tool' });
        }
      } catch (e: any) {
        results.push({ tool: a.tool, success: false, error: e.message || String(e) });
      }
    }
    return results;
  }

    private buildUnifiedDiff(filePath: string, oldStr: string, newStr: string): string {
        // Simple line-based diff (not optimized). For brevity implement minimal unified diff.
        const oldLines = oldStr.split(/\r?\n/);
        const newLines = newStr.split(/\r?\n/);
        // Myers diff would be nicer; use LCS dynamic programming for small files.
        const m = oldLines.length, n = newLines.length;
        const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
        for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        const hunks: { oldStart: number; oldLines: string[]; newStart: number; newLines: string[] }[] = [];
        let i = 0, j = 0; const diffLines: string[] = [];
        while (i < m && j < n) {
            if (oldLines[i] === newLines[j]) { i++; j++; continue; }
            // start hunk
            const oldStart = i + 1; const newStart = j + 1; const oldBuf: string[] = []; const newBuf: string[] = [];
            while (i < m && j < n && oldLines[i] !== newLines[j]) {
                // choose direction
                if (dp[i + 1][j] >= dp[i][j + 1]) { oldBuf.push(oldLines[i++]); }
                else { newBuf.push(newLines[j++]); }
            }
            // drain remaining mismatched area
            while (i < m && (j >= n || dp[i][j] === dp[i + 1][j])) { oldBuf.push(oldLines[i++]); }
            while (j < n && (i >= m || dp[i][j] === dp[i][j + 1])) { newBuf.push(newLines[j++]); }
            hunks.push({ oldStart, oldLines: oldBuf, newStart, newLines: newBuf });
        }
        // Tail additions
        if (i < m || j < n) {
            const oldStart = i + 1; const newStart = j + 1; const oldBuf: string[] = []; const newBuf: string[] = [];
            while (i < m) oldBuf.push(oldLines[i++]);
            while (j < n) newBuf.push(newLines[j++]);
            hunks.push({ oldStart, oldLines: oldBuf, newStart, newLines: newBuf });
        }
        const header = `--- a/${filePath}\n+++ b/${filePath}`;
        const hunkStrs = hunks.filter(h => h.oldLines.length || h.newLines.length).map(h => {
            const oldCount = h.oldLines.length || 0; const newCount = h.newLines.length || 0;
            const lines: string[] = [`@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@`];
            h.oldLines.forEach(l => lines.push('-' + l));
            h.newLines.forEach(l => lines.push('+' + l));
            return lines.join('\n');
        });
        return [header, ...hunkStrs].join('\n');
    }
}
