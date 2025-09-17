export interface InboundMessage {
  id: string;
  text: string;
  source: 'chat' | 'http' | 'sse' | 'command';
  sessionId?: string; // optional project/session correlation
}

export interface OutboundFragment {
  id: string; // correlation id
  fragment: string;
  done?: boolean;
  model?: string;
}

export interface ApprovalRequest {
    approvalId: string;
    correlationId: string; // original inbound id / agent run id
    action: 'editFile' | 'createFile';
    path: string;
    diff?: string; // unified diff or preview
    contentPreview?: string; // for new files
}

export interface ApprovalDecision {
    approvalId: string;
    approved: boolean;
}

export type InboundListener = (msg: InboundMessage) => void;
export type OutboundListener = (frag: OutboundFragment) => void;
export type ApprovalRequestListener = (req: ApprovalRequest) => void;
export type ApprovalDecisionListener = (dec: ApprovalDecision) => void;

export class MessageBus {
  private inboundListeners = new Set<InboundListener>();
  private outboundListeners = new Set<OutboundListener>();
    private approvalRequestListeners = new Set<ApprovalRequestListener>();
    private approvalDecisionListeners = new Set<ApprovalDecisionListener>();

  emitInbound(msg: InboundMessage) {
    for (const l of this.inboundListeners) l(msg);
  }
  onInbound(l: InboundListener) { this.inboundListeners.add(l); return () => this.inboundListeners.delete(l); }

  emitOutbound(f: OutboundFragment) {
    for (const l of this.outboundListeners) l(f);
  }
  onOutbound(l: OutboundListener) { this.outboundListeners.add(l); return () => this.outboundListeners.delete(l); }

    emitApprovalRequest(r: ApprovalRequest) {
        for (const l of this.approvalRequestListeners) l(r);
    }
    onApprovalRequest(l: ApprovalRequestListener) { this.approvalRequestListeners.add(l); return () => this.approvalRequestListeners.delete(l); }

    emitApprovalDecision(d: ApprovalDecision) {
        for (const l of this.approvalDecisionListeners) l(d);
    }
    onApprovalDecision(l: ApprovalDecisionListener) { this.approvalDecisionListeners.add(l); return () => this.approvalDecisionListeners.delete(l); }
}
