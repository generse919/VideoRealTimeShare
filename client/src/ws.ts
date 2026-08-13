import type { ClientMessage, ServerMessage } from "../../shared/messages.ts";

/** 自動再接続つき WebSocket クライアント */
export class SocketClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private stopped = false;

  constructor(
    private url: string,
    private onMessage: (msg: ServerMessage) => void,
    private onStateChange: (connected: boolean) => void,
  ) {}

  connect(): void {
    this.stopped = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onStateChange(true);
    };
    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(String(ev.data)) as ServerMessage);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      this.onStateChange(false);
      if (this.stopped) return;
      const delay = Math.min(1000 * 2 ** this.retry++, 10000);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
