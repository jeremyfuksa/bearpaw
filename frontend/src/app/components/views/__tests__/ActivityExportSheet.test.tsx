import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { ActivityExportSheet } from "../../views/ActivityExportSheet";
import type { ActivityLogEntry } from "../../../types";
import { mockFetch, resetMockFetch, mockFetchError, mockFetchNetworkError } from "../../test/utils";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("../../../api/useApi", () => ({
  useAPI: vi.fn(),
}));

vi.mock("../../../store/useStore", () => ({
  useStore: vi.fn(),
}));

describe("ActivityExportSheet", () => {
  const mockProps = {
    isOpen: true,
    onClose: vi.fn(),
    hasActivity: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch({ entries: [] });
    global.URL.createObjectURL = vi.fn(() => "blob:mock-url");
    global.URL.revokeObjectURL = vi.fn();
    document.createElement = vi.fn((tag: string) => {
      if (tag === "a") {
        return { href: "", download: "", click: vi.fn() };
      }
      return {};
    }) as any;
  });

  afterEach(() => {
    resetMockFetch();
    vi.restoreAllMocks();
  });

  describe("Rendering", () => {
    it("should render when isOpen is true", () => {
      render(<ActivityExportSheet {...mockProps} />);
      expect(screen.getByText(/Export Activity Log/i)).toBeInTheDocument();
    });

    it("should not render when isOpen is false", () => {
      render(<ActivityExportSheet {...mockProps} isOpen={false} />);
      expect(screen.queryByText(/Export Activity Log/i)).not.toBeInTheDocument();
    });

    it("should render close button", () => {
      render(<ActivityExportSheet {...mockProps} />);
      expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
    });

    it("should render timeframe buttons", () => {
      render(<ActivityExportSheet {...mockProps} />);
      expect(screen.getByRole("button", { name: /today/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /week/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /month/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /all time/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /custom range/i })).toBeInTheDocument();
    });

    it("should render download button", () => {
      render(<ActivityExportSheet {...mockProps} />);
      expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
    });

    it("should disable download when hasActivity is false", () => {
      render(<ActivityExportSheet {...mockProps} hasActivity={false} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      expect(downloadButton).toBeDisabled();
    });

    it("should enable download when hasActivity is true", () => {
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      expect(downloadButton).not.toBeDisabled();
    });
  });

  describe("Timeframe Selection", () => {
    it("should default to today timeframe", () => {
      render(<ActivityExportSheet {...mockProps} />);
      expect(screen.getByRole("button", { name: /today/i })).toHaveClass("border-brand-primary/30");
    });

    it("should switch to week timeframe when clicked", async () => {
      render(<ActivityExportSheet {...mockProps} />);
      const weekButton = screen.getByRole("button", { name: /week/i });
      
      await userEvent.click(weekButton);
      
      expect(weekButton).toHaveClass("border-brand-primary/30");
      expect(screen.getByRole("button", { name: /today/i })).not.toHaveClass("border-brand-primary/30");
    });

    it("should switch to month timeframe when clicked", async () => {
      render(<ActivityExportSheet {...mockProps} />);
      const monthButton = screen.getByRole("button", { name: /month/i });
      
      await userEvent.click(monthButton);
      
      expect(monthButton).toHaveClass("border-brand-primary/30");
      expect(screen.getByRole("button", { name: /today/i })).not.toHaveClass("border-brand-primary/30");
    });

    it("should switch to all time when clicked", async () => {
      render(<ActivityExportSheet {...mockProps} />);
      const allButton = screen.getByRole("button", { name: /all time/i });
      
      await userEvent.click(allButton);
      
      expect(allButton).toHaveClass("border-brand-primary/30");
      expect(screen.getByRole("button", { name: /today/i })).not.toHaveClass("border-brand-primary/30");
    });

    it("should switch to custom timeframe when clicked", async () => {
      render(<ActivityExportSheet {...mockProps} />);
      const customButton = screen.getByRole("button", { name: /custom range/i });
      
      await userEvent.click(customButton);
      
      expect(customButton).toHaveClass("border-brand-primary/30");
      expect(screen.getByRole("button", { name: /today/i })).not.toHaveClass("border-brand-primary/30");
    });
  });

  describe("Custom Date Range Selection", () => {
    it("should show custom date range when custom timeframe selected", async () => {
      render(<ActivityExportSheet {...mockProps} />);
      const customButton = screen.getByRole("button", { name: /custom range/i });
      
      await userEvent.click(customButton);
      
      expect(screen.getByText(/Start Date/i)).toBeInTheDocument();
      expect(screen.getByText(/End Date/i)).toBeInTheDocument();
    });

    it("should not show custom date range when other timeframe selected", async () => {
      render(<ActivityExportSheet {...mockProps} />);
      const todayButton = screen.getByRole("button", { name: /today/i });
      
      await userEvent.click(todayButton);
      
      expect(screen.queryByText(/Start Date/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/End Date/i)).not.toBeInTheDocument();
    });

    it("should have month select dropdown", async () => {
      render(<ActivityExportSheet {...mockProps} />);
      const customButton = screen.getByRole("button", { name: /custom range/i });
      
      await userEvent.click(customButton);
      
      const selects = screen.getAllByRole("combobox");
      expect(selects.length).toBeGreaterThanOrEqual(2);
    });

    it("should have day select dropdown", async () => {
      render(<ActivityExportSheet {...mockProps} />);
      const customButton = screen.getByRole("button", { name: /custom range/i });
      
      await userEvent.click(customButton);
      
      const selects = screen.getAllByRole("combobox");
      expect(selects.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("Export Functionality", () => {
    it("should call API to export activity log", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: 1,
          alpha_tag: "Test Channel",
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      mockFetch({ entries: mockEntries });
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining("/api/v1/analytics/activity-log"),
          expect.objectContaining({ method: "GET" })
        );
      });
    });

    it("should show success toast on successful export", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: 1,
          alpha_tag: "Test Channel",
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      mockFetch({ entries: mockEntries });
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith("Channels exported successfully");
      });
    });

    it("should create CSV blob for download", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: 1,
          alpha_tag: "Test Channel",
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      mockFetch({ entries: mockEntries });
      const mockBlob = new Blob(["test"], { type: "text/csv" });
      global.Blob = vi.fn(() => mockBlob);
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(global.Blob).toHaveBeenCalledWith(
          expect.arrayContaining([expect.stringContaining(",")]),
          expect.objectContaining({ type: "text/csv" })
        );
      });
    });

    it("should create download link with correct filename", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: 1,
          alpha_tag: "Test Channel",
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      mockFetch({ entries: mockEntries });
      const mockURL = "blob:mock-url";
      global.URL.createObjectURL = vi.fn(() => mockURL);
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(global.URL.createObjectURL).toHaveBeenCalled();
      });
    });

    it("should click download link to trigger download", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: 1,
          alpha_tag: "Test Channel",
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      mockFetch({ entries: mockEntries });
      const mockClick = vi.fn();
      global.document.createElement = vi.fn((tag: string) => {
        if (tag === "a") {
          return { href: "", download: "", click: mockClick };
        }
        return {};
      }) as any;
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(mockClick).toHaveBeenCalled();
      });
    });

    it("should revoke object URL after download", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: 1,
          alpha_tag: "Test Channel",
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      mockFetch({ entries: mockEntries });
      const mockRevoke = vi.fn();
      global.URL.revokeObjectURL = mockRevoke;
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(mockRevoke).toHaveBeenCalled();
      });
    });

    it("should call onClose after successful download", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: 1,
          alpha_tag: "Test Channel",
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      mockFetch({ entries: mockEntries });
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(mockProps.onClose).toHaveBeenCalled();
      });
    });

    it("should show exporting state during download", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: 1,
          alpha_tag: "Test Channel",
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      let resolveFetch;
      const fetchPromise = new Promise((resolve) => {
        resolveFetch = resolve;
      });
      global.fetch = vi.fn(() => fetchPromise);
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      expect(screen.getByText(/Exporting\.\.\./i)).toBeInTheDocument();
    });

    it("should hide exporting state after download completes", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: 1,
          alpha_tag: "Test Channel",
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      mockFetch({ entries: mockEntries });
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(screen.queryByText(/Exporting\.\.\./i)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /download/i })).toHaveTextContent("Download CSV");
      });
    });
  });

  describe("Error Handling", () => {
    it("should show error toast on fetch failure", async () => {
      mockFetchError(500, "Failed to export activity log");
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("Failed to export activity log");
      });
    });

    it("should show error toast on network error", async () => {
      mockFetchNetworkError();
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("Failed to export activity log");
      });
    });

    it("should handle JSON parse errors", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.reject(new Error("Invalid JSON")),
        })
      );
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("Failed to export activity log");
      });
    });

    it("should not call onClose on error", async () => {
      mockFetchError(500, "Failed to export");
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(mockProps.onClose).not.toHaveBeenCalled();
      });
    });
  });

  describe("Close Button", () => {
    it("should call onClose when close button is clicked", async () => {
      render(<ActivityExportSheet {...mockProps} />);
      const closeButton = screen.getByRole("button", { name: /close/i });
      
      await userEvent.click(closeButton);
      
      expect(mockProps.onClose).toHaveBeenCalled();
    });
  });

  describe("Query Parameters", () => {
    it("should build correct query params for today timeframe", async () => {
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining("start_time"),
          expect.objectContaining({ method: "GET" })
        );
      });
    });

    it("should build correct query params for custom timeframe", async () => {
      render(<ActivityExportSheet {...mockProps} />);
      const customButton = screen.getByRole("button", { name: /custom range/i });
      await userEvent.click(customButton);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining("start_time"),
          expect.stringContaining("end_time"),
          expect.objectContaining({ method: "GET" })
        );
      });
    });
  });

  describe("CSV Format", () => {
    it("should include all required fields in CSV header", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: 1,
          alpha_tag: "Test Channel",
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      mockFetch({ entries: mockEntries });
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(global.Blob).toHaveBeenCalledWith(
          expect.stringContaining("timestamp,frequency,tag,channel,rssi,duration"),
          expect.objectContaining({ type: "text/csv" })
        );
      });
    });

    it("should format CSV rows correctly", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: 1,
          alpha_tag: "Test Channel",
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      mockFetch({ entries: mockEntries });
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(global.Blob).toHaveBeenCalledWith(
          expect.stringContaining("151.2500"),
          expect.stringContaining('"Test Channel"'),
          expect.objectContaining({ type: "text/csv" })
        );
      });
    });

    it("should escape commas in CSV values", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: 1,
          alpha_tag: "Test, Channel",
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      mockFetch({ entries: mockEntries });
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(global.Blob).toHaveBeenCalledWith(
          expect.stringContaining('"Test, Channel"'),
          expect.objectContaining({ type: "text/csv" })
        );
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty activity log", async () => {
      mockFetch({ entries: [] });
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(global.Blob).toHaveBeenCalledWith(
          expect.stringContaining("timestamp,frequency,tag,channel,rssi,duration"),
          expect.objectContaining({ type: "text/csv" })
        );
      });
    });

    it("should handle missing alpha_tag", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: null,
          alpha_tag: null,
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      mockFetch({ entries: mockEntries });
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(global.Blob).toHaveBeenCalledWith(
          expect.stringContaining('""'),
          expect.objectContaining({ type: "text/csv" })
        );
      });
    });

    it("should handle missing channel", async () => {
      const mockEntries: ActivityLogEntry[] = [
        {
          id: "test-1",
          timestamp: Date.now() / 1000,
          frequency: 151.25,
          channel: null,
          alpha_tag: "Test",
          type: "hit",
          rssi: 75,
          hasAudio: false,
          duration: 2.5,
          ended_at: Date.now() / 1000,
        },
      ];

      mockFetch({ entries: mockEntries });
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(global.Blob).toHaveBeenCalledWith(
          expect.stringContaining('""'),
          expect.objectContaining({ type: "text/csv" })
        );
      });
    });
  });
});
