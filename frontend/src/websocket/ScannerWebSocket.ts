import type { WSMessage } from '../types';

type Listener = (data: WSMessage | { status: string; error?: unknown }) => void;

export class ScannerWebSocket {
  private ws?: WebSocket;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;
  private listeners = new Map<string, Set<Listener>>();
  private url: string;
  private shouldReconnect = true;
  private debug = false;
  // Pending reconnect timer id (#144). Without storing it, disconnect()
  // couldn't cancel an already-scheduled reconnect; the surviving timer
  // called connect(), which re-armed shouldReconnect — a zombie socket
  // reconnecting after an explicit disconnect.
  private reconnectTimer: number | null = null;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.shouldReconnect = true;
    this.debug = typeof window !== 'undefined' && window.localStorage?.getItem('ws_debug') === '1';
    console.log('[ws] Connecting to:', this.url);
    this.emit('connection', { status: 'connecting' });
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      console.info('[ws] connected');
      this.emit('connection', { status: 'connected' });
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WSMessage;
        if (this.debug) {
          console.info('[ws]', message);
        }
        this.emit(message.type, message);
      } catch (error) {
        this.emit('error', { status: 'error', error });
      }
    };

    this.ws.onerror = (error) => {
      console.warn('[ws] error', error);
      this.emit('error', { status: 'error', error });
    };

    this.ws.onclose = () => {
      console.info('[ws] disconnected');
      this.emit('connection', { status: 'disconnected' });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  on(event: string, callback: Listener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    this.listeners.get(event)?.add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  private emit(event: string, data: WSMessage | { status: string; error?: unknown }): void {
    this.listeners.get(event)?.forEach((callback) => callback(data));
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.ws) return;

    const ws = this.ws;
    this.ws = undefined;

    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;

    if (ws.readyState === WebSocket.CONNECTING) {
      ws.onopen = () => ws.close();
      return;
    }

    ws.close();
  }
}
