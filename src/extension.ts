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
    const tools = new AgentTools({ workspaceRoot: vscode.workspace.workspaceFolders?.[0].uri.fsPath || context.extensionPath, allowedRoots: agentRoots, requireApproval: agentRequireApproval });
    agentController = new AgentController(proxy, tools, bus);
    // Re-register participant with agent (dispose old one first)
    participant.dispose();
    const withAgent = registerChatParticipant(bus, proxy, context.extensionUri, agentController, agentPrefix);
    context.subscriptions.push(withAgent);
  }
  externalServer = new ExternalServer({ port, host, allowOrigins }, bus, proxy, vscode.window.createOutputChannel('Copilot Anywhere'), context.extensionPath, effectiveAutoInvoke, agentController, agentEnabled);
  await externalServer.start();

  context.subscriptions.push({ dispose: () => externalServer?.dispose() });

  const testCmd = vscode.commands.registerCommand('copilotAnywhere.sendTest', async () => {
    const input = await vscode.window.showInputBox({ prompt: 'Message to send to Copilot Anywhere participant' });
    if (input) {
      bus?.emitInbound({ id: Date.now().toString(), text: input, source: 'command' });
    }
  });
  context.subscriptions.push(testCmd);

  // Listen for HTTP inbound messages and optionally inject into chat UI
  if (injectIntoChat) {
    bus?.onInbound(async (msg) => {
      if (msg.source !== 'http') return;
      const prompt = `@CopilotAnywhere ${msg.text}`;
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
