import * as vscode from 'vscode';
import { MessageBus, InboundMessage } from './messageBus';
import { CopilotProxy } from './copilotProxy';
import { AgentController } from './agentController';

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
    if (agent && trimmed.toLowerCase().startsWith(agentPrefix.toLowerCase())) {
      let goal = trimmed.slice(agentPrefix.length).trim();
      // Augment with active file context if available & within workspace
      const active = vscode.window.activeTextEditor?.document;
      if (active && active.uri.scheme === 'file' && !active.isUntitled) {
        const wsFolder = vscode.workspace.getWorkspaceFolder(active.uri);
        if (wsFolder) {
          const rel = active.uri.fsPath.startsWith(wsFolder.uri.fsPath)
            ? active.uri.fsPath.substring(wsFolder.uri.fsPath.length + 1)
            : undefined;
          if (rel) {
            goal += `\nACTIVE_FILE: ${rel}`;
          }
        }
      }
      if (!goal) {
        stream.markdown(`Agent prefix detected but no goal provided after '${agentPrefix}'.`);
        return;
      }
      stream.markdown(`(agent starting for goal: ${goal})`);
      try {
        await agent.run({ goal, id: inbound.id, maxSteps: 12 }, (frag, done) => {
          stream.markdown(frag);
        });
      } catch (e: any) {
        stream.markdown(`Agent error: ${e.message || e}`);
      }
      return;
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
  return participant;
}
