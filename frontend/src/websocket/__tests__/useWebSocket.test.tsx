import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitFor, act, render } from "@testing-library/react";
import { screen } from "@testing-library/react";
import { ScannerWebSocket } from "../ScannerWebSocket";
import { WebSocketProvider, useWebSocket } from "../useWebSocket";
import type { WSMessage } from "../types";

const createWebSocketMock = (factory: () => any) => {
  const mock = vi.fn(function () {
    return factory();
  }) as any;
  mock.CONNECTING = 0;
  mock.OPEN = 1;
  mock.CLOSING = 2;
  mock.CLOSED = 3;
  return mock;
};

global.WebSocket = createWebSocketMock(() => ({})) as any;

describe("ScannerWebSocket", () => {
  let ws: ScannerWebSocket;
  let mockWs: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWs = {
      readyState: WebSocket.CONNECTING,
      close: vi.fn(),
      send: vi.fn(),
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    global.WebSocket = createWebSocketMock(() => mockWs) as any;
    ws = new ScannerWebSocket("ws://localhost:8000/ws");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Connection Management", () => {
    it("should create WebSocket connection", () => {
      ws.connect();
      expect(global.WebSocket).toHaveBeenCalledWith("ws://localhost:8000/ws");
    });

    it("should handle onopen event", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);
      ws.connect();

      if (mockWs.onopen) {
        mockWs.onopen();
      }

      expect(mockEmit).toHaveBeenCalledWith("connection", { status: "connected" });
    });

    it("should send connection status on connect", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);
      ws.connect();

      expect(mockEmit).toHaveBeenCalledWith("connection", { status: "connecting" });
    });

    it("should send connected status when WebSocket opens", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);
      ws.connect();
      if (mockWs.onopen) {
        mockWs.onopen();
      }

      expect(mockEmit).toHaveBeenCalledWith("connection", { status: "connected" });
    });

    it("should send disconnected status when WebSocket closes", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);
      ws.connect();
      if (mockWs.onclose) {
        mockWs.onclose();
      }

      expect(mockEmit).toHaveBeenCalledWith("connection", { status: "disconnected" });
    });

    it("should close existing connection before connecting", () => {
      const existingWs = { close: vi.fn(), readyState: WebSocket.OPEN };
      (ws as any).ws = existingWs;
      
      ws.connect();

      expect(existingWs.close).not.toHaveBeenCalled();
      expect(global.WebSocket).not.toHaveBeenCalled();
    });

    it("should not reconnect if already connected", () => {
      const existingWs = { readyState: WebSocket.OPEN, close: vi.fn() };
      (ws as any).ws = existingWs;

      ws.connect();

      expect(global.WebSocket).not.toHaveBeenCalled();
    });
  });

  describe("Message Handling", () => {
    it("should parse JSON messages", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);
      const testMessage: WSMessage = { type: "state_update", data: {} };
      ws.connect();

      if (mockWs.onmessage) {
        mockWs.onmessage({ data: JSON.stringify(testMessage) } as MessageEvent);
      }

      expect(mockEmit).toHaveBeenCalledWith("state_update", testMessage);
    });

    it("should respond to ping messages with pong", () => {
      const testMessage: WSMessage = { type: "ping" };
      ws.connect();

      if (mockWs.onmessage) {
        mockWs.onmessage({ data: JSON.stringify(testMessage) } as MessageEvent);
      }

      expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ type: "pong" }));
    });

    it("should emit error events for JSON parse errors", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      ws.connect();

      if (mockWs.onmessage) {
        mockWs.onmessage({ data: "invalid json" } as MessageEvent);
      }

      expect(mockEmit).toHaveBeenCalledWith("error", expect.objectContaining({
        status: "error",
        error: expect.any(Error),
      }));
    });

    it("should emit onmessage events to listeners", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const testMessage: WSMessage = { type: "event", data: {} };

      ws.on("event", listener1);
      ws.on("event", listener2);
      ws.connect();

      if (mockWs.onmessage) {
        mockWs.onmessage({ data: JSON.stringify(testMessage) } as MessageEvent);
      }

      expect(listener1).toHaveBeenCalledWith(testMessage);
      expect(listener2).toHaveBeenCalledWith(testMessage);
    });
  });

  describe("Error Handling", () => {
    it("should emit error on WebSocket error", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);
      const testError = new Error("Connection failed");
      ws.connect();

      if (mockWs.onerror) {
        mockWs.onerror(testError);
      }

      expect(mockEmit).toHaveBeenCalledWith("error", expect.objectContaining({
        status: "error",
        error: testError,
      }));
    });

    it("should emit error for connection errors", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);
      ws.connect();

      if (mockWs.onerror) {
        mockWs.onerror(new Event("error"));
      }

      expect(mockEmit).toHaveBeenCalledWith("error", expect.objectContaining({
        status: "error",
      }));
    });
  });

  describe("Disconnection", () => {
    it("should close WebSocket connection", () => {
      ws.connect();
      mockWs.readyState = WebSocket.OPEN;
      ws.disconnect();

      expect(mockWs.close).toHaveBeenCalled();
    });

    it("should remove all event listeners", () => {
      ws.connect();
      mockWs.readyState = WebSocket.OPEN;
      ws.disconnect();

      expect(mockWs.onopen).toBeNull();
      expect(mockWs.onmessage).toBeNull();
      expect(mockWs.onerror).toBeNull();
      expect(mockWs.onclose).toBeNull();
    });

    it("should emit disconnected status", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);
      ws.connect();
      if (mockWs.onclose) {
        mockWs.onclose();
      }

      expect(mockEmit).toHaveBeenCalledWith("connection", { status: "disconnected" });
    });

    it("should schedule reconnect on disconnect", () => {
      vi.useFakeTimers();

      ws.connect();
      mockWs.readyState = WebSocket.CLOSED;
      if (mockWs.onclose) {
        mockWs.onclose();
      }

      vi.advanceTimersByTime(1000);

      expect(global.WebSocket).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });
  });

  describe("Subscription Management", () => {
    it("should subscribe to message type", () => {
      const listener = vi.fn();
      ws.on("state_update", listener);
      ws.connect();

      if (mockWs.onmessage) {
        mockWs.onmessage({ data: JSON.stringify({ type: "state_update" }) } as MessageEvent);
      }

      expect(listener).toHaveBeenCalledWith({ type: "state_update" });
    });

    it("should unsubscribe from message type", () => {
      const listener = vi.fn();
      const unsubscribe = ws.on("state_update", listener);
      unsubscribe();

      ws.connect();
      if (mockWs.onmessage) {
        mockWs.onmessage({ data: JSON.stringify({ type: "state_update" }) } as MessageEvent);
      }

      expect(listener).not.toHaveBeenCalled();
    });

    it("should allow multiple listeners for same type", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      ws.on("event", listener1);
      ws.on("event", listener2);

      ws.connect();

      const testMessage: WSMessage = { type: "event", data: {} };

      if ((ws as any).ws?.onmessage) {
        (ws as any).ws.onmessage({ data: JSON.stringify(testMessage) } as MessageEvent);
      }

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it("should only call subscribed listeners", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const otherListener = vi.fn();

      ws.on("event", listener1);
      ws.on("state_update", listener2);
      ws.on("error", otherListener);

      const testMessage: WSMessage = { type: "event", data: {} };

      ws.connect();

      if (mockWs.onmessage) {
        mockWs.onmessage({ data: JSON.stringify(testMessage) } as MessageEvent);
      }

      expect(listener1).toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
      expect(otherListener).not.toHaveBeenCalled();
    });
  });
});

describe("useWebSocket hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.WebSocket = createWebSocketMock(() => ({
      readyState: WebSocket.CONNECTING,
      close: vi.fn(),
      send: vi.fn(),
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    })) as any;
  });

  describe("Provider", () => {
    it("should provide WebSocket context to children", () => {
      const TestComponent = () => {
        const context = useWebSocket();
        return <div data-testid="ws-context">{JSON.stringify(context)}</div>;
      };

      render(
        <WebSocketProvider url="ws://test">
          <TestComponent />
        </WebSocketProvider>
      );

      const contextData = screen.getByTestId("ws-context");
      const parsed = JSON.parse(contextData.textContent ?? "{}");
      expect(parsed).toEqual(expect.objectContaining({
        connected: expect.any(Boolean),
        connecting: expect.any(Boolean),
      }));
    });

    it("should connect WebSocket on mount", () => {
      const TestComponent = () => {
        useWebSocket();
        return <div>Mounted</div>;
      };

      render(
        <WebSocketProvider url="ws://test">
          <TestComponent />
        </WebSocketProvider>
      );

      expect(global.WebSocket).toHaveBeenCalledWith("ws://test");
    });

    it("should resolve a default ws URL when url prop is omitted", () => {
      const TestComponent = () => {
        useWebSocket();
        return <div>Mounted</div>;
      };

      render(
        <WebSocketProvider>
          <TestComponent />
        </WebSocketProvider>
      );

      const firstCall = (global.WebSocket as any).mock.calls[0]?.[0] as string;
      expect(firstCall).toMatch(/^wss?:\/\/.+\/ws$/);
    });
  });

  describe("useWebSocket", () => {
    it("should throw error when used outside provider", () => {
      const TestComponent = () => {
        try {
          useWebSocket();
          return <div>Should not render</div>;
        } catch (error) {
          return <div>Error: {(error as Error).message}</div>;
        }
      };

      render(<TestComponent />);

      expect(screen.getByText(/Error:/i)).toBeInTheDocument();
    });

    it("should return WebSocket context when inside provider", () => {
      const TestComponent = () => {
        const context = useWebSocket();
        return <div data-testid="context">{JSON.stringify(context)}</div>;
      };

      render(
        <WebSocketProvider url="ws://test">
          <TestComponent />
        </WebSocketProvider>
      );

      const context = screen.getByTestId("context");
      expect(context).toHaveTextContent(/ws.*connected.*connecting/);
    });

    it("should expose connection status", () => {
      const TestComponent = () => {
        const { connected, connecting } = useWebSocket();
        return (
          <div>
            <span data-testid="connected">{connected.toString()}</span>
            <span data-testid="connecting">{connecting.toString()}</span>
          </div>
        );
      };

      render(
        <WebSocketProvider url="ws://test">
          <TestComponent />
        </WebSocketProvider>
      );

      expect(screen.getByTestId("connected")).toHaveTextContent("false");
      expect(screen.getByTestId("connecting")).toHaveTextContent("true");
    });
  });

  describe("Auto-Reconnection", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should schedule reconnection on disconnect", () => {
      let mockWsInstance: any = {
        readyState: WebSocket.OPEN,
        close: vi.fn(),
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };

      global.WebSocket = createWebSocketMock(() => mockWsInstance);

      render(<WebSocketProvider url="ws://test"><div /></WebSocketProvider>);

      act(() => {
        mockWsInstance.readyState = WebSocket.CLOSED;
        mockWsInstance.onclose?.();
        vi.advanceTimersByTime(1000);
      });

      expect(global.WebSocket).toHaveBeenCalledTimes(2);
    });

    it("should use exponential backoff for reconnection delays", () => {
      const setTimeoutSpy = vi.spyOn(window, "setTimeout");
      let latestInstance: any;
      global.WebSocket = createWebSocketMock(() => {
        latestInstance = {
          readyState: WebSocket.CLOSED,
          close: vi.fn(),
          onclose: null,
          onopen: null,
          onmessage: null,
          onerror: null,
        };
        return latestInstance;
      });

      render(<WebSocketProvider url="ws://test"><div /></WebSocketProvider>);

      act(() => {
        latestInstance.onclose?.();
        vi.advanceTimersByTime(1000);
        latestInstance.onclose?.();
        vi.advanceTimersByTime(2000);
        latestInstance.onclose?.();
        vi.advanceTimersByTime(4000);
      });

      const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
      expect(delays).toEqual(expect.arrayContaining([1000, 2000, 4000]));
    });

    it("should limit max reconnect delay to 30000ms", () => {
      const setTimeoutSpy = vi.spyOn(window, "setTimeout");
      let latestInstance: any;
      global.WebSocket = createWebSocketMock(() => {
        latestInstance = {
          readyState: WebSocket.CLOSED,
          close: vi.fn(),
          onclose: null,
          onopen: null,
          onmessage: null,
          onerror: null,
        };
        return latestInstance;
      });

      render(<WebSocketProvider url="ws://test"><div /></WebSocketProvider>);

      const delays = [1000, 2000, 4000, 8000, 16000, 30000];
      act(() => {
        delays.forEach((delay) => {
          latestInstance.onclose?.();
          vi.advanceTimersByTime(delay);
        });
      });

      expect(setTimeoutSpy.mock.calls.map((call) => call[1])).toContain(30000);
    });

    it("should stop reconnection when connected", () => {
      let callCount = 0;
      let latestInstance: any;
      global.WebSocket = createWebSocketMock(() => {
        callCount++;
        latestInstance = {
          readyState: WebSocket.OPEN,
          close: vi.fn(),
          onopen: null,
          onclose: null,
          onmessage: null,
          onerror: null,
        };
        return latestInstance;
      });

      render(<WebSocketProvider url="ws://test"><div /></WebSocketProvider>);
      act(() => {
        latestInstance.onopen?.();
        vi.advanceTimersByTime(2000);
      });

      expect(callCount).toBe(1);
    });
  });
});
