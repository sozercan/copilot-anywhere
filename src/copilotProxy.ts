import * as vscode from 'vscode';
import { MessageBus } from './messageBus';

export class CopilotProxy {
  constructor(private bus: MessageBus) {}

  async sendToModel(request: vscode.ChatRequest, context: vscode.ChatContext, token: vscode.CancellationToken, onFragment: (f: string) => void, correlationId?: string) {
    const messages: vscode.LanguageModelChatMessage[] = [];
    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
    const id = correlationId || Date.now().toString();
    const model = request.model ?? await this.pickFirstModel();
    const chatResponse = await model.sendRequest(messages, {}, token);
    let full = '';
    for await (const part of chatResponse.text) {
      full += part;
      onFragment(part);
      this.bus.emitOutbound({ id, fragment: part, model: model.name });
    }
    this.bus.emitOutbound({ id, fragment: '', done: true, model: model.name });
    return { full, model: model.name, id };
  }

  // Direct prompt execution without an originating ChatRequest (used for HTTP autoInvoke)
  async runPromptDirect(prompt: string, correlationId?: string) {
    const id = correlationId || Date.now().toString();
    const model = (await this.pickFirstModel());
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const chatResponse = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    let full = '';
    for await (const part of chatResponse.text) {
      full += part;
      this.bus.emitOutbound({ id, fragment: part, model: model.name });
    }
    this.bus.emitOutbound({ id, fragment: '', done: true, model: model.name });
    return { full, model: model.name, id };
  }

  private async pickFirstModel(): Promise<vscode.LanguageModelChat> {
    // naive: pick first available
    const models = await vscode.lm.selectChatModels({});
    if (!models || models.length === 0) {
      throw new Error('No chat models available. Ensure GitHub Copilot is enabled.');
    }
    return models[0];
  }

  async rawModelCall(messages: vscode.LanguageModelChatMessage[]) {
    const model = await this.pickFirstModel();
    const chatResponse = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    let full = '';
    for await (const part of chatResponse.text) {
      full += part;
    }
    return { model: model.name, full };
  }
}
