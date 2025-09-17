import * as vscode from 'vscode';
import { MessageBus, InboundMessage } from './messageBus';
import { CopilotProxy } from './copilotProxy';
import { AgentController } from './agentController';
import { exec } from 'child_process';
import * as path from 'path';

// Track last agent modified / created files for /files slash command
let lastAgentChangedFiles: string[] = [];
// Track active agent run correlation ids so we can inline approvals and suppress duplicate global notifications
const activeAgentRuns = new Set<string>();

export function registerChatParticipant(bus: MessageBus, proxy: CopilotProxy, extensionUri: vscode.Uri, agent?: AgentController, agentPrefix: string = 'agent:') {
  const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
    // Determine sessionId: active editor's workspace folder path, else first workspace folder, else undefined
    let sessionId: string | undefined;
    const activeDoc = vscode.window.activeTextEditor?.document;
    const folders = vscode.workspace.workspaceFolders || [];
    if (activeDoc) {
      const folder = vscode.workspace.getWorkspaceFolder(activeDoc.uri);
      if (folder) sessionId = folder.uri.fsPath;
    }
    if (!sessionId && folders.length) sessionId = folders[0].uri.fsPath;
    const inbound: InboundMessage = {
      id: Date.now().toString(),
      text: request.prompt,
      source: 'chat',
      sessionId
    };
    // Forward to bus so external clients also see it
  bus.emitInbound(inbound);
    const trimmed = request.prompt.trim();
      // Slash command handling
      if (request.command) {
          const cmd = request.command;
          if (cmd === 'files') {
              if (!lastAgentChangedFiles.length) {
                  stream.markdown('No recent agent file changes tracked in this session.');
              } else {
                  stream.markdown(`Recently changed files (agent):`);
                  // Provide references & filetree
                  if (sessionId) {
                      const base = vscode.Uri.file(sessionId);
                      const treeRoot: any = { name: path.basename(sessionId), children: [] as any[] };
                      lastAgentChangedFiles.forEach(rel => {
                          stream.reference(vscode.Uri.joinPath(base, rel));
                          treeRoot.children.push({ name: rel });
                      });
                      stream.filetree([treeRoot], base);
          }
            lastAgentChangedFiles.forEach(f => stream.markdown(`- ${f}`));
        }
          return { metadata: { command: 'files', count: lastAgentChangedFiles.length } } as any;
      } else if (cmd === 'run') {
          const toRun = trimmed.replace(/^\s*\/run\s*/i, '').trim();
          if (!toRun) { stream.markdown('Usage: /run <shell command>'); return; }
          stream.progress(`Running: ${toRun}`);
          const cwd = sessionId || vscode.workspace.workspaceFolders?.[0].uri.fsPath || process.cwd();
          await new Promise<void>((resolve) => {
              const child = exec(toRun, { cwd, maxBuffer: 1024 * 500 }, (err, stdout, stderr) => {
                  if (stdout) {
                      const first = stdout.split(/\r?\n/).slice(0, 40).join('\n');
                      stream.markdown(['```bash', first, '```'].join('\n'));
            }
              if (stderr) {
                  const first = stderr.split(/\r?\n/).slice(0, 20).join('\n');
                  if (first.trim()) stream.markdown(['**stderr**', '```', first, '```'].join('\n'));
              }
              if (err) {
                  stream.markdown(`Command exited with error: ${(err as any).code ?? ''}`);
              } else {
                  stream.markdown('Command completed successfully.');
              }
              resolve();
          });
            const cancelListener = token.onCancellationRequested(() => {
                child.kill();
                stream.progress('Run command cancelled.');
                resolve();
            });
        });
            return { metadata: { command: 'run' }, followups: [{ prompt: 'Run another command' }] } as any;
        } else if (cmd === 'agent' && agent) {
            // Allow /agent <goal> (strip command from prompt body)
            const goal = trimmed.replace(/^\s*\/agent\s*/i, '').trim();
            if (!goal) { stream.markdown('Usage: /agent <goal description>'); return; }
            // Fall through to agent invocation logic below using parsed goal
            return await invokeAgent(goal);
        }
    }

      async function invokeAgent(goalFromPrefix: string) {
          stream.markdown(`**Agent Goal:** ${goalFromPrefix}`);
          const actionsCollected: string[] = [];
          const resultsCollected: string[] = [];
          const commentaryCollected: string[] = [];
          activeAgentRuns.add(inbound.id);
          // Inline approval listener for this specific run
          const disposeInlineApproval = bus.onApprovalRequest(req => {
              if (req.correlationId !== inbound.id) return; // not for this run
              const snippetSrc = req.diff || req.contentPreview || '';
              const snippet = snippetSrc.slice(0, 2000); // safety truncate
              const fenced = snippet ? ['```diff', snippet, '```'].join('\n') : '';
              stream.markdown(`**Approval Required:** ${req.action} \`${req.path}\`\n\n${fenced}`);
              // Provide buttons directly in chat
              stream.button({ command: 'copilotAnywhere.approval.decide', title: 'Approve', arguments: [req.approvalId, true] });
              stream.button({ command: 'copilotAnywhere.approval.decide', title: 'Reject', arguments: [req.approvalId, false] });
          });
      try {
          await agent!.run({ goal: goalFromPrefix, id: inbound.id, maxSteps: 12 }, (frag, done) => {
              if (done) {
                  const finalSummary = frag;
                  const unique = (arr: string[]) => Array.from(new Set(arr));
                  // Extract changed files from results (created/edited)
                  const changed = new Set<string>();
                  resultsCollected.forEach(line => {
                      const m = /(created|edited) file (.+)$/i.exec(line);
                      if (m) changed.add(m[2]);
                  });
                  lastAgentChangedFiles = Array.from(changed);
                  const md: string[] = [];
                  md.push(`### Agent Summary`);
                  md.push('');
                  md.push(finalSummary);
                  if (commentaryCollected.length) {
                      md.push('\n**Notes:**'); unique(commentaryCollected).forEach(c => md.push(`- ${c}`));
                  }
                  if (actionsCollected.length) {
                      md.push('\n**Actions Performed:**'); unique(actionsCollected).forEach(a => md.push(`- ${a}`));
                  }
                  if (resultsCollected.length) {
                      md.push('\n**Results:**'); unique(resultsCollected).forEach(r => md.push(`- ${r}`));
                  }
                  if (lastAgentChangedFiles.length && sessionId) {
                      const base = vscode.Uri.file(sessionId);
                      const rootName = path.basename(sessionId);
                      const treeRoot: any = { name: rootName, children: [] as any[] };
                      lastAgentChangedFiles.forEach(rel => { treeRoot.children.push({ name: rel }); });
                      stream.filetree([treeRoot], base);
                      lastAgentChangedFiles.forEach(rel => stream.reference(vscode.Uri.joinPath(base, rel)));
                  }
                // Single button to open external web UI (removed duplicate link)
                stream.button({ command: 'copilotAnywhere.openWeb', title: 'Open Web UI' });
                  stream.markdown(md.join('\n'));
              } else {
                  const t = frag.trim(); if (!t) return;
                  if (t.startsWith('Actions:')) {
                      const lines = t.split(/\n/).slice(1).map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
                      actionsCollected.push(...lines); stream.progress(lines.join('; '));
                  } else if (t.startsWith('Results:')) {
                      const lines = t.split(/\n/).slice(1).map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
                      resultsCollected.push(...lines); if (lines.length) stream.progress(lines.join('; '));
                  } else { commentaryCollected.push(t); stream.progress(t); }
              }
        });
          return {
              metadata: { agent: true, changedFiles: lastAgentChangedFiles }, followups: [
                  { prompt: 'Summarize changes' },
                  { prompt: 'List created or edited files' },
                  ...(lastAgentChangedFiles.length ? [{ prompt: '/files', title: 'Show changed files' } as any] : [])
              ]
          } as any;
            } catch (e: any) {
                stream.markdown(`Agent error: ${e.message || e}`);
            } finally {
                    // Clean up inline approval listener & active run tracking
                    activeAgentRuns.delete(inbound.id);
                    try { disposeInlineApproval(); } catch {}
            }
      }

      if (agent && trimmed.toLowerCase().startsWith(agentPrefix.toLowerCase())) {
          let goal = trimmed.slice(agentPrefix.length).trim();
          if (!goal) {
              stream.markdown(`Agent prefix detected but no goal provided after '${agentPrefix}'.`);
          return;
        }
        await invokeAgent(goal);
        return; // already handled
    }
    // Standard single-turn model proxy
    try {
      const response = await proxy.sendToModel(request, context, token, (fragment) => {
        stream.markdown(fragment);
      }, inbound.id);
      return { metadata: { model: response.model } } as any;
    } catch (err: any) {
      stream.markdown(`Error: ${err.message || err}`);
    }
  };

    const participant = vscode.chat.createChatParticipant('copilot-anywhere.proxy', handler);
    participant.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icon.png');

            // Global approval request handling (fallback for runs not initiated from current chat): show notification only.
            bus.onApprovalRequest(req => {
                if (activeAgentRuns.has(req.correlationId)) return; // inline handler already rendered buttons
                const approveCmd: vscode.Command = { command: 'copilotAnywhere.approval.decide', title: 'Approve', arguments: [req.approvalId, true] };
                const rejectCmd: vscode.Command = { command: 'copilotAnywhere.approval.decide', title: 'Reject', arguments: [req.approvalId, false] };
                const max = 800;
                const snippet = req.diff ? req.diff.slice(0,max) : (req.contentPreview || '').slice(0,max);
                const detail = `${req.action} ${req.path}`;
                vscode.window.showInformationMessage(`Approval required: ${detail}`, 'Approve', 'Reject').then(choice => {
                    if (choice === 'Approve') vscode.commands.executeCommand(approveCmd.command, ...(approveCmd.arguments||[]));
                    else if (choice === 'Reject') vscode.commands.executeCommand(rejectCmd.command, ...(rejectCmd.arguments||[]));
                });
                bus.emitOutbound({ id: req.approvalId, fragment: `Pending approval: ${detail}\n${snippet ? '---\n'+snippet : ''}`, model: 'agent' });
            });
    return participant;
}
