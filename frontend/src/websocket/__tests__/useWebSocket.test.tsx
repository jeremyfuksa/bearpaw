import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitFor, act } from "@testing-library/react";
import { renderHook, render } from "@testing-library/react";
import { ScannerWebSocket } from "../ScannerWebSocket";
import { WebSocketProvider, useWebSocket } from "./useWebSocket";
import type { WSMessage } from "../types";

global.WebSocket = vi.fn() as any;

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
    global.WebSocket = vi.fn(() => mockWs) as any;
    ws = new ScannerWebSocket("ws://localhost:8000/ws");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Connection Management", () => {
    it("should create WebSocket connection", () => {
      expect(global.WebSocket).toHaveBeenCalledWith("ws://localhost:8000/ws");
    });

    it("should handle onopen event", () => {
      const openHandler = vi.fn();
      mockWs.onopen = openHandler;

      ws.connect();

      expect(openHandler).toHaveBeenCalled();
    });

    it("should send connection status on connect", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);
      ws.connect();

      expect(mockEmit).toHaveBeenCalledWith("connection", { status: "connecting" });
    });

    it("should send connected status when WebSocket opens", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);
      
      if (mockWs.onopen) {
        mockWs.onopen();
      }

      expect(mockEmit).toHaveBeenCalledWith("connection", { status: "connected" });
    });

    it("should send disconnected status when WebSocket closes", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);
      
      if (mockWs.onclose) {
        mockWs.onclose();
      }

      expect(mockEmit).toHaveBeenCalledWith("connection", { status: "disconnected" });
    });

    it("should close existing connection before connecting", () => {
      const existingWs = { close: vi.fn(), readyState: WebSocket.OPEN };
      (ws as any).ws = existingWs;
      
      ws.connect();

      expect(existingWs.close).toHaveBeenCalled();
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

      if (mockWs.onmessage) {
        mockWs.onmessage({ data: JSON.stringify(testMessage) } as MessageEvent);
      }

      expect(mockEmit).toHaveBeenCalledWith("state_update", testMessage);
    });

    it("should respond to ping messages with pong", () => {
      const testMessage: WSMessage = { type: "ping" };

      if (mockWs.onmessage) {
        mockWs.onmessage({ data: JSON.stringify(testMessage) } as MessageEvent);
      }

      expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ type: "pong" }));
    });

    it("should emit error events for JSON parse errors", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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
      ws.disconnect();

      expect(mockWs.close).toHaveBeenCalled();
    });

    it("should remove all event listeners", () => {
      ws.disconnect();

      expect(mockWs.onopen).toBeNull();
      expect(mockWs.onmessage).toBeNull();
      expect(mockWs.onerror).toBeNull();
      expect(mockWs.onclose).toBeNull();
    });

    it("should emit disconnected status", () => {
      const mockEmit = vi.spyOn(ws, "emit" as any);

      ws.disconnect();

      expect(mockEmit).toHaveBeenCalledWith("connection", { status: "disconnected" });
    });

    it("should schedule reconnect on disconnect", () => {
      vi.useFakeTimers();

      ws.disconnect();

      vi.advanceTimersByTime(101);

      expect(global.WebSocket).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });
  });

  describe("Subscription Management", () => {
    it("should subscribe to message type", () => {
      const listener = vi.fn();
      ws.on("state_update", listener);

      expect(listener).toHaveBeenCalled();
    });

    it("should unsubscribe from message type", () => {
      const unsubscribe = ws.on("state_update", vi.fn());
      unsubscribe();

      expect(unsubscribe).toHaveBeenCalled();
    });

    it("should allow multiple listeners for same type", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      ws.on("event", listener1);
      ws.on("event", listener2);

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

      if (mockWs.onmessage) {
        mockWs.onmessage({ data: JSON.stringify(testMessage) } as MessageEvent);
      }

      expect(listener1).toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
      expect(otherListener).toHaveBeenCalled();
    });
  });
});

describe("useWebSocket hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(contextData).toHaveTextContent(JSON.stringify(expect.objectContaining({
        ws: expect.any(Object),
        connected: expect.any(Boolean),
        connecting: expect.any(Boolean),
      })));
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
        onclose: () => {
          mockWsInstance.close();
        },
      };

      global.WebSocket = vi.fn(() => mockWsInstance);

      render(<WebSocketProvider url="ws://test"><div /></WebSocketProvider>);

      mockWsInstance.onclose();

      vi.advanceTimersByTime(50);

      expect(global.WebSocket).toHaveBeenCalledTimes(2);
    });

    it("should use exponential backoff for reconnection delays", () => {
      let callCount = 0;
      global.WebSocket = vi.fn(() => {
        callCount++;
        return {
          readyState: WebSocket.CLOSED,
          close: vi.fn(),
          onclose: () => {
            global.WebSocket();
          },
        };
      });

      render(<WebSocketProvider url="ws://test"><div /></WebSocketProvider>);

      vi.advanceTimersByTime(50);
      expect(callCount).toBe(1);
      vi.advanceTimersByTime(150);
      expect(callCount).toBe(2);
      vi.advanceTimersByTime(350);
      expect(callCount).toBe(3);
    });

    it("should limit max reconnect delay to 30000ms", () => {
      let callCount = 0;
      global.WebSocket = vi.fn(() => {
        callCount++;
        return {
          readyState: WebSocket.CLOSED,
          close: vi.fn(),
          onclose: () => {
            global.WebSocket();
          },
        };
      });

      render(<WebSocketProvider url="ws://test"><div /></WebSocketProvider>);

      vi.advanceTimersByTime(60000);

      expect(callCount).toBe(3);
      vi.advanceTimersByTime(50);

      expect(callCount).toBe(3);
    });

    it("should stop reconnection when connected", () => {
      let callCount = 0;
      global.WebSocket = vi.fn(() => {
        callCount++;
        return {
          readyState: callCount > 0 ? WebSocket.OPEN : WebSocket.CLOSED,
          close: vi.fn(),
          onopen: () => {
            global.WebSocket();
          },
        };
      });

      render(<WebSocketProvider url="ws://test"><div /></WebSocketProvider>);

      vi.advanceTimersByTime(50);
      expect(callCount).toBe(1);
      vi.advanceTimersByTime(50);

      expect(callCount).toBe(1);
    });
  });
});
