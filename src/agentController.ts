import * as vscode from 'vscode';
import { AgentTools, ToolAction } from './agentTools';
import { MessageBus } from './messageBus';
import { CopilotProxy } from './copilotProxy';

interface AgentRunOptions {
  goal: string;
  id: string;
  maxSteps: number;
}

const SYSTEM_PROMPT = `You are CopilotAnywhereAgent, an autonomous coding assistant.
IMPORTANT OUTPUT RULES:
1. Respond with EXACTLY ONE JSON OBJECT per turn. Do NOT wrap it in code fences. (If a fence is emitted by the model anyway, it must be a json fence only with the object inside and no extra prose.)
2. Every non-final step MUST have at least ONE action in the actions array. If you are waiting for file reads, you MUST include a readFiles action. Empty actions with done=false are INVALID.
3. Allowed tools ONLY:
  - listFiles { "tool": "listFiles", "glob": "partialName", "max": 50 }
  - readFiles { "tool": "readFiles", "files": ["relative/path.ts", ...] }
  - createFile { "tool": "createFile", "path": "path/newFile.txt", "content": "full file text" }
  - editFile { "tool": "editFile", "path": "path/existingFile.ts", "content": "entire new file content" }
    - runCommand { "tool": "runCommand", "command": "npm test", "cwd": "optional/relative/dir", "timeoutMs": 8000 }
4. For edits you MUST readFiles first in a prior step (unless creating a brand new file with createFile).
5. Provide concise commentary (<= 160 chars) explaining WHY you chose the actions.
6. FINAL step: { "finalSummary": "...", "done": true }
7. If you truly cannot proceed without clarification: { "finalSummary": "Need clarification: <question>", "done": true }
8. NEVER invent tools. NEVER output plain text outside JSON.
SCHEMA EXAMPLE (non-final):
{
  "actions": [ { "tool": "readFiles", "files": ["src/example.ts"] } ],
  "commentary": "Reading target file before editing.",
  "done": false
}
FINAL EXAMPLE:
{ "finalSummary": "Created src/demoNote.md and updated foo.ts", "done": true }
`;

export class AgentController {
  constructor(
    private proxy: CopilotProxy,
      private tools: AgentTools,
    private bus: MessageBus
  ) {}

  async run(opts: AgentRunOptions, onStream?: (text: string, done?: boolean) => void): Promise<void> {
    const correlationId = opts.id;
    // Inform tools of current correlation id for approval mapping
    (this.tools as any).setCorrelationId?.(correlationId);
    const history: vscode.LanguageModelChatMessage[] = [
      // Use a system message so model treats instructions with higher authority
      (vscode.LanguageModelChatMessage as any).System
        ? (vscode.LanguageModelChatMessage as any).System(SYSTEM_PROMPT)
        : vscode.LanguageModelChatMessage.User(`SYSTEM:\n${SYSTEM_PROMPT}`),
      vscode.LanguageModelChatMessage.User(opts.goal)
    ];

  let emptyActionRetries = 0;
    for (let step = 0; step < opts.maxSteps; step++) {
        // (Removed explicit step header output as per formatting preference)
        if (step > 0) {
            const spacer = '\n';
            this.bus.emitOutbound({ id: correlationId, fragment: spacer, model: 'agent' });
            onStream?.(spacer, false);
        }
      const model = (await vscode.lm.selectChatModels({}))[0];
      if (!model) {
        const msg = 'No chat model available for agent.';
        this.bus.emitOutbound({ id: correlationId, fragment: msg, done: true });
        onStream?.(msg, true);
        return;
      }
      const tokenSource = new vscode.CancellationTokenSource();
      const chatResponse = await model.sendRequest(history, {}, tokenSource.token);
      let full = '';
      for await (const frag of chatResponse.text) { full += frag; }

      // Try multiple extraction strategies
      const candidates = this.extractJsonCandidates(full);
      let parsed: any | undefined; let rawJson: string | undefined;
      for (const c of candidates) {
        try { parsed = JSON.parse(c); rawJson = c; break; } catch { /* continue */ }
      }
      if (!parsed) {
        const truncated = full.trim().slice(0, 400);
        const parseNote = `Output not valid JSON (showing first 400 chars):\n${truncated}`;
        this.bus.emitOutbound({ id: correlationId, fragment: parseNote, model: model.name });
        onStream?.(parseNote, false);
        const retryMsg = 'Previous output invalid. Respond ONLY with one JSON object following schema.';
        history.push(vscode.LanguageModelChatMessage.Assistant(full));
        history.push(vscode.LanguageModelChatMessage.User(retryMsg));
        step--; // redo same numbered step
        continue;
      }

      if (parsed.done) {
        const summary = parsed.finalSummary || 'Agent finished.';
        this.bus.emitOutbound({ id: correlationId, fragment: summary, done: true, model: model.name });
        onStream?.(summary, true);
        return;
      }

      const commentary: string = parsed.commentary || '';
      if (commentary) {
          // Output commentary plain (no label)
        this.bus.emitOutbound({ id: correlationId, fragment: commentary, model: model.name });
        onStream?.(commentary, false);
      }
      const actions: ToolAction[] = Array.isArray(parsed.actions) ? parsed.actions : [];
      if (actions.length === 0) {
        emptyActionRetries++;
        if (emptyActionRetries > 2) {
          const msg = 'Agent produced empty actions repeatedly. Aborting.';
          this.bus.emitOutbound({ id: correlationId, fragment: msg, done: true, model: model.name });
          onStream?.(msg, true);
          return;
        }
        const correction = 'INVALID_EMPTY_ACTIONS: Provide at least one action (e.g., readFiles) or set done=true with a finalSummary.';
        history.push(vscode.LanguageModelChatMessage.Assistant(rawJson!));
        history.push(vscode.LanguageModelChatMessage.User(correction));
        step--; // redo this step without counting
        continue;
      } else {
        emptyActionRetries = 0;
      }
        const actionLines = actions.map(a => `- ${a.tool}${(a as any).path ? ': ' + (a as any).path : ''}`);
        const actionSummary = `Actions:\n${actionLines.join('\n')}`;
  this.bus.emitOutbound({ id: correlationId, fragment: actionSummary, model: model.name });
  onStream?.(actionSummary, false);
  const results = await this.tools.execute(actions as any);

      // Provide friendlier summaries for runCommand results before raw JSON
      for (const r of results) {
        if (r.tool === 'runCommand' && r.success && r.detail) {
          const d = r.detail;
          const line = `[run] ${d.command} (code ${d.code}${d.timedOut ? ', timed out' : ''})`;
          this.bus.emitOutbound({ id: correlationId, fragment: line, model: model.name });
          onStream?.(line, false);
          if (d.stdout) {
            const first = d.stdout.split(/\r?\n/).slice(0,6).join('\n');
            const outLine = first.trim().length ? `[stdout]\n${first}` : '';
            if (outLine) { this.bus.emitOutbound({ id: correlationId, fragment: outLine, model: model.name }); onStream?.(outLine, false); }
          }
          if (d.stderr) {
            const firstErr = d.stderr.split(/\r?\n/).slice(0,4).join('\n');
            const errLine = firstErr.trim().length ? `[stderr]\n${firstErr}` : '';
            if (errLine) { this.bus.emitOutbound({ id: correlationId, fragment: errLine, model: model.name }); onStream?.(errLine, false); }
          }
        }
      }

        // Human-readable summaries instead of raw JSON
        const summaries = results.map(r => {
            const base = r.tool;
            if (!r.success) return `${base} failed${r.error ? ': ' + r.error : ''}`;
            if (r.tool === 'readFiles' && r.detail?.files) {
                const files = r.detail.files.map((f: any) => f.path).join(', ');
                return `read ${r.detail.files.length} file(s): ${files}`;
            }
            if (r.tool === 'createFile') {
                return `created file ${(r as any).path || (r.detail?.path) || ''}`.trim();
            }
            if (r.tool === 'editFile') {
                return `edited file ${(r as any).path || (r.detail?.path) || ''}`.trim();
            }
            if (r.tool === 'runCommand') {
                const d: any = r.detail || {}; return `ran '${d.command}' exit=${d.code}${d.timedOut ? ' (timed out)' : ''}`;
            }
            return `${base} ok`;
        });
        const resultsFrag = `Results:\n${summaries.map(s => `- ${s}`).join('\n')}`;
      this.bus.emitOutbound({ id: correlationId, fragment: resultsFrag, model: model.name });
      onStream?.(resultsFrag, false);

        // Keep feeding structured JSON to the model for context (even though user sees summaries)
        history.push(vscode.LanguageModelChatMessage.Assistant(rawJson!));
        history.push(vscode.LanguageModelChatMessage.User(`TOOL_RESULTS:\n${JSON.stringify(results)}`));
    }
    const msg = 'Agent reached max steps';
    this.bus.emitOutbound({ id: opts.id, fragment: msg, done: true });
    onStream?.(msg, true);
  }

  // Attempt to extract one or more plausible JSON object strings from model output
  private extractJsonCandidates(text: string): string[] {
    const candidates: string[] = [];
    // Strip code fences first
    const fenceRegex = /```(?:json)?\n([\s\S]*?)```/gi;
    let m: RegExpExecArray | null;
    while ((m = fenceRegex.exec(text)) !== null) {
      candidates.push(m[1].trim());
    }
    // Brace matching across entire text
    const chars = text.split('');
    let stack: number[] = [];
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] === '{') stack.push(i);
      if (chars[i] === '}' && stack.length) {
        const start = stack.pop()!;
        if (stack.length === 0) { // only capture top-level objects
          const obj = text.slice(start, i + 1).trim();
          if (obj.startsWith('{') && obj.endsWith('}')) candidates.push(obj);
        }
      }
    }
    // De-duplicate & prefer later (often cleaner) objects
    return Array.from(new Set(candidates.reverse()));
  }
}
