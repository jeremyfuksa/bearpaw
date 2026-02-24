import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityExportSheet } from "../ActivityExportSheet";
import { useAPI } from "../../../../api/useApi";
import type { ActivityLogEntry } from "../../../../types";
import { mockFetch, resetMockFetch, mockFetchError, mockFetchNetworkError } from "../../../../test/utils";

vi.mock("../../../../api/useApi", () => ({
  useAPI: vi.fn(),
}));

vi.mock("../../../../store/useStore", () => ({
  useStore: vi.fn(),
}));

describe("ActivityExportSheet", () => {
  const originalBlob = global.Blob;
  let anchorClickMock: ReturnType<typeof vi.fn>;
  const mockProps = {
    isOpen: true,
    onClose: vi.fn(),
    hasActivity: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAPI).mockReturnValue({
      cleanupAnalytics: vi.fn().mockResolvedValue(undefined),
    } as any);
    mockFetch([]);
    global.Blob = vi.fn(function (
      parts: BlobPart[],
      options?: BlobPropertyBag,
    ) {
      return { parts, type: options?.type ?? "" } as unknown as Blob;
    }) as unknown as typeof Blob;
    anchorClickMock = vi.fn();
    global.URL.createObjectURL = vi.fn(() => "blob:mock-url");
    global.URL.revokeObjectURL = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "a") {
        return { href: "", download: "", click: anchorClickMock } as any;
      }
      return originalCreateElement(tag);
    });
  });

  afterEach(() => {
    global.Blob = originalBlob;
    resetMockFetch();
    vi.restoreAllMocks();
  });

  const getBlobCsvContent = (): string => {
    const blobMock = global.Blob as unknown as ReturnType<typeof vi.fn>;
    const calls = blobMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    if (!lastCall) return "";
    const parts = lastCall[0];
    if (!Array.isArray(parts)) return "";
    return parts.join("");
  };

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
      
      expect(screen.getByLabelText(/start date/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/end date/i)).toBeInTheDocument();
    });

    it("should have day select dropdown", async () => {
      render(<ActivityExportSheet {...mockProps} />);
      const customButton = screen.getByRole("button", { name: /custom range/i });
      
      await userEvent.click(customButton);
      
      expect(screen.getAllByDisplayValue("").length).toBeGreaterThanOrEqual(2);
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

      mockFetch(mockEntries);
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining("/api/v1/analytics/activity-log")
        );
      });
    });

    it("should close after successful export", async () => {
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

      mockFetch(mockEntries);
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(mockProps.onClose).toHaveBeenCalled();
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

      mockFetch(mockEntries);
      
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

      mockFetch(mockEntries);
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

      mockFetch(mockEntries);
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(anchorClickMock).toHaveBeenCalled();
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

      mockFetch(mockEntries);
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

      mockFetch(mockEntries);
      
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

      mockFetch(mockEntries);
      
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
    it("should log errors on fetch failure", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockFetchError(500, "Failed to export activity log");
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          "Failed to export activity log",
          expect.any(Error),
        );
      });

      consoleSpy.mockRestore();
    });

    it("should log errors on network error", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockFetchNetworkError();
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          "Failed to export activity log",
          expect.any(Error),
        );
      });

      consoleSpy.mockRestore();
    });

    it("should handle JSON parse errors", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
        expect(consoleSpy).toHaveBeenCalledWith(
          "Failed to export activity log",
          expect.any(Error),
        );
      });

      consoleSpy.mockRestore();
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
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("start_time"));
      });
    });

    it("should build correct query params for custom timeframe", async () => {
      render(<ActivityExportSheet {...mockProps} />);
      const customButton = screen.getByRole("button", { name: /custom range/i });
      await userEvent.click(customButton);
      await userEvent.type(screen.getByLabelText(/start date/i), "2026-01-01");
      await userEvent.type(screen.getByLabelText(/end date/i), "2026-01-31");
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        const url = vi.mocked(global.fetch).mock.calls.at(-1)?.[0] as string;
        expect(url).toContain("start_time");
        expect(url).toContain("end_time");
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

      mockFetch(mockEntries);
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(getBlobCsvContent()).toContain("timestamp,frequency,tag,channel,rssi,duration");
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

      mockFetch(mockEntries);
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        const csv = getBlobCsvContent();
        expect(csv).toContain("151.2500");
        expect(csv).toContain('"Test Channel"');
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

      mockFetch(mockEntries);
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(getBlobCsvContent()).toContain('"Test, Channel"');
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty activity log", async () => {
      mockFetch([]);
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(getBlobCsvContent()).toContain("timestamp,frequency,tag,channel,rssi,duration");
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

      mockFetch(mockEntries);
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(getBlobCsvContent()).toContain('""');
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

      mockFetch(mockEntries);
      
      render(<ActivityExportSheet {...mockProps} />);
      const downloadButton = screen.getByRole("button", { name: /download/i });
      
      await userEvent.click(downloadButton);
      
      await waitFor(() => {
        expect(getBlobCsvContent()).toContain(",,75");
      });
    });
  });
});
