import * as vscode from 'vscode';
import { registerChatParticipant } from './chatParticipant';
import { ExternalServer } from './externalServer';
import { MessageBus } from './messageBus';
import { CopilotProxy } from './copilotProxy';
import { AgentController } from './agentController';
import { AgentTools } from './agentTools';

let externalServer: ExternalServer | undefined;
let bus: MessageBus | undefined;
let proxy: CopilotProxy | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('copilotAnywhere');
  const port = config.get<number>('server.port', 3939);
  const host = config.get<string>('server.host', '127.0.0.1');
  const allowOrigins = config.get<string[]>('security.allowOrigins', ['*']);
  const autoInvokeSetting = config.get<boolean>('http.autoInvoke', true);
  const injectIntoChat = config.get<boolean>('http.injectIntoChat', false);
  const autoSubmit = config.get<boolean>('http.autoSubmit', true); // retained setting but manual submit loop removed (Option B)
  const agentEnabled = config.get<boolean>('agent.enabled', false);
  const agentMaxSteps = config.get<number>('agent.maxSteps', 12);
  const agentRoots = config.get<string[]>('agent.allowedRoots', ['src','web','README.md']);
  const agentRequireApproval = config.get<boolean>('agent.requireApproval', false);
  const agentPrefix = config.get<string>('agent.prefix', 'agent:');
    const persistenceEnabled = config.get<boolean>('persistence.enabled', true);
    const persistenceDirSetting = config.get<string>('persistence.directory', '');
    const persistenceMax = config.get<number>('persistence.maxMessagesPerSession', 500);

  bus = new MessageBus();
  proxy = new CopilotProxy(bus);

  // Register chat participant using bus + proxy
  const participant = registerChatParticipant(bus, proxy, context.extensionUri, undefined, agentPrefix); // agent injected later once created
  context.subscriptions.push(participant);

  // Start external server
  // If injecting into chat, we disable direct auto invoke to avoid duplicate model calls
  const effectiveAutoInvoke = injectIntoChat ? false : autoInvokeSetting;
  let agentController: AgentController | undefined;
  if (agentEnabled) {
      const tools = new AgentTools({ workspaceRoot: vscode.workspace.workspaceFolders?.[0].uri.fsPath || context.extensionPath, allowedRoots: agentRoots, requireApproval: agentRequireApproval, bus: { emitApprovalRequest: (r: any) => bus!.emitApprovalRequest(r), onApprovalDecision: (l: any) => bus!.onApprovalDecision(l) } });
    agentController = new AgentController(proxy, tools, bus);
    // Re-register participant with agent (dispose old one first)
    participant.dispose();
    const withAgent = registerChatParticipant(bus, proxy, context.extensionUri, agentController, agentPrefix);
    context.subscriptions.push(withAgent);
  }
    // Determine persistence directory (config override else global storage)
    let persistenceDir = persistenceDirSetting;
    if (!persistenceDir) {
        persistenceDir = context.globalStorageUri.fsPath;
    }
    try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(persistenceDir)); } catch { }

    externalServer = new ExternalServer({ port, host, allowOrigins, persistence: { enabled: persistenceEnabled, dir: persistenceDir, maxMessages: persistenceMax } }, bus, proxy, vscode.window.createOutputChannel('Copilot Anywhere'), context.extensionPath, effectiveAutoInvoke, agentController, agentEnabled);
  await externalServer.start();

  context.subscriptions.push({ dispose: () => externalServer?.dispose() });

  const testCmd = vscode.commands.registerCommand('copilotAnywhere.sendTest', async () => {
    const input = await vscode.window.showInputBox({ prompt: 'Message to send to Copilot Anywhere participant' });
    if (input) {
      bus?.emitInbound({ id: Date.now().toString(), text: input, source: 'command' });
    }
  });
  context.subscriptions.push(testCmd);

    const openWeb = vscode.commands.registerCommand('copilotAnywhere.openWeb', async () => {
      try {
        // Use localhost instead of 0.0.0.0 or :: for a clickable browser-friendly URL
        const displayHost = (host === '0.0.0.0' || host === '::' || host === '::1') ? 'localhost' : host;
        const url = `http://${displayHost}:${port}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to open web UI: ${e.message || e}`);
      }
    });
    context.subscriptions.push(openWeb);

    // Command invoked by chat approval buttons
    const decideApproval = vscode.commands.registerCommand('copilotAnywhere.approval.decide', async (approvalId: string, approved: boolean) => {
      try {
        bus?.emitApprovalDecision({ approvalId, approved });
        // Also POST to local server if running so web UI stays in sync
        if (externalServer) {
          try {
            const portHost = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
            await fetch(`${portHost}/approval`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ approvalId, approved }) });
          } catch { /* ignore */ }
        }
        vscode.window.showInformationMessage(`Approval ${approved? 'approved':'rejected'} for ${approvalId}`);
      } catch (e:any) {
        vscode.window.showErrorMessage(`Failed to process approval: ${e.message||e}`);
      }
    });
    context.subscriptions.push(decideApproval);

  // Listen for HTTP inbound messages and optionally inject into chat UI
  if (injectIntoChat) {
    bus?.onInbound(async (msg) => {
      if (msg.source !== 'http') return;
        const prompt = `@copilot-anywhere ${msg.text}`;
      try {
        // Open the chat UI with prefilled prompt (command arg usage is unofficial and may change)
        await vscode.commands.executeCommand('workbench.action.chat.open', prompt);
        // Option B: Do not force-submit to avoid duplicate turns. If VS Code build doesn't auto-submit,
        // user can press Enter (autoSubmit setting currently no-op without fallback loop).
      } catch (e: any) {
        vscode.window.showWarningMessage(`Failed to inject chat prompt: ${e.message || e}`);
      }
    });
  }
}

export function deactivate() {
  externalServer?.dispose();
}
