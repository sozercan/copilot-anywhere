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

export type InboundListener = (msg: InboundMessage) => void;
export type OutboundListener = (frag: OutboundFragment) => void;

export class MessageBus {
  private inboundListeners = new Set<InboundListener>();
  private outboundListeners = new Set<OutboundListener>();

  emitInbound(msg: InboundMessage) {
    for (const l of this.inboundListeners) l(msg);
  }
  onInbound(l: InboundListener) { this.inboundListeners.add(l); return () => this.inboundListeners.delete(l); }

  emitOutbound(f: OutboundFragment) {
    for (const l of this.outboundListeners) l(f);
  }
  onOutbound(l: OutboundListener) { this.outboundListeners.add(l); return () => this.outboundListeners.delete(l); }
}
