import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface ToolActionBase { tool: string; }
export interface ReadFilesAction extends ToolActionBase { tool: 'readFiles'; files: string[]; }
export interface EditFileAction extends ToolActionBase { tool: 'editFile'; path: string; content?: string; diff?: string; }
export interface CreateFileAction extends ToolActionBase { tool: 'createFile'; path: string; content: string; }
export interface ListFilesAction extends ToolActionBase { tool: 'listFiles'; glob?: string; max?: number; }
export type ToolAction = ReadFilesAction | EditFileAction | CreateFileAction | ListFilesAction;

export interface ToolResult { tool: string; success: boolean; detail?: any; error?: string; }

export interface AgentToolsOptions {
  workspaceRoot: string;
  allowedRoots: string[]; // relative allowed roots
  requireApproval: boolean;
}

export class AgentTools {
  constructor(private opts: AgentToolsOptions) {}

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
            if (this.opts.requireApproval) {
              const approve = await vscode.window.showQuickPick(['Apply edit', 'Cancel'], { placeHolder: `Agent edit ${act.path}` });
              if (approve !== 'Apply edit') throw new Error('User rejected edit');
            }
            await fs.promises.writeFile(abs, act.content, 'utf8');
            results.push({ tool: 'editFile', success: true, detail: { path: act.path, mode: 'replace' } });
          } else {
            results.push({ tool: 'editFile', success: false, error: 'No content field (diff parsing not implemented yet)' });
          }
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
}
