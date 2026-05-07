import { vi } from 'vitest';
import type { WSMessage } from '../../types';

export type MockWebSocketState = {
  connected: boolean;
  messages: WSMessage[];
  subscribedTopics: string[];
  handlers: Map<string, Set<(msg: WSMessage) => void>>;
};

export const mockWebSocket = () => {
  const state: MockWebSocketState = {
    connected: false,
    messages: [],
    subscribedTopics: [],
    handlers: new Map(),
  };

  const mockWS = {
    connect: vi.fn(async () => {
      state.connected = true;
    }),
    disconnect: vi.fn(async () => {
      state.connected = false;
    }),
    send: vi.fn((message: WSMessage) => {
      state.messages.push(message);
    }),
    on: vi.fn((topic: string, handler: (msg: WSMessage) => void) => {
      if (!state.handlers.has(topic)) {
        state.handlers.set(topic, new Set());
      }
      state.handlers.get(topic)!.add(handler);
      return vi.fn(() => {
        state.handlers.get(topic)?.delete(handler);
      });
    }),
    subscribe: vi.fn((topics: string[]) => {
      state.subscribedTopics = [...new Set([...state.subscribedTopics, ...topics])];
    }),
    unsubscribe: vi.fn((topics: string[]) => {
      state.subscribedTopics = state.subscribedTopics.filter((t) => !topics.includes(t));
    }),
    emit: vi.fn((topic: string, message: WSMessage) => {
      const handlers = state.handlers.get(topic);
      if (handlers) {
        handlers.forEach((handler) => handler(message));
      }
    }),
    getState: () => ({ ...state }),
    reset: () => {
      state.connected = false;
      state.messages = [];
      state.subscribedTopics = [];
      state.handlers.clear();
      mockWS.connect.mockClear();
      mockWS.disconnect.mockClear();
      mockWS.send.mockClear();
      mockWS.on.mockClear();
      mockWS.subscribe.mockClear();
      mockWS.unsubscribe.mockClear();
      mockWS.emit.mockClear();
    },
  };

  return mockWS;
};
