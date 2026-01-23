import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { ChannelsTab } from "../views/ChannelsTab";
import { createTestChannel, createTestChannelDraft, mockApiResponses, mockApiErrors } from "../../test/fixtures";
import { createMockApiClient, createMockStore } from "../../test/mocks";
import type { ChannelData } from "../../../types";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("../../api/useApi", () => ({
  useAPI: vi.fn(() => createMockApiClient()),
}));

vi.mock("../../../store/useStore", () => ({
  useStore: vi.fn(),
}));

describe("ChannelsTab", () => {
  let mockApiClient: ReturnType<typeof createMockApiClient>;
  let mockChannels: ChannelData[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient = createMockApiClient();
    mockChannels = [
      createTestChannel({ index: 1, frequency: 151.25, bank: 1, alpha_tag: "Channel 1" }),
      createTestChannel({ index: 51, frequency: 155.5, bank: 2, alpha_tag: "Channel 51" }),
      createTestChannel({ index: 101, frequency: 160.75, bank: 3, alpha_tag: "Channel 101" }),
    ];
    mockApiClient.updateChannel = vi.fn().mockResolvedValue(mockChannels[0]);
    mockApiClient.getChannels = vi.fn().mockResolvedValue(mockChannels);

    vi.mocked("../../../store/useStore").useStore
      .mockReturnValue(createMockStore({ channels: mockChannels }));
  });

  describe("Bank Navigation", () => {
    it("should render 10 bank buttons", () => {
      render(<ChannelsTab />);
      const bankButtons = screen.getAllByRole("button", { name: /Bank \d+/i });
      expect(bankButtons).toHaveLength(10);
    });

    it("should highlight active bank", () => {
      render(<ChannelsTab />);
      const bank1 = screen.getByRole("button", { name: /Bank 1/i });
      expect(bank1).toHaveClass("bg-brand-primary/20");
    });

    it("should set active bank when button clicked", async () => {
      render(<ChannelsTab />);
      const bank2 = screen.getByRole("button", { name: /Bank 2/i });
      await userEvent.click(bank2);

      expect(bank2).toHaveClass("bg-brand-primary/20");
    });

    it("should filter channels by bank", () => {
      render(<ChannelsTab />);
      const bank2 = screen.getByRole("button", { name: /Bank 2/i });
      await userEvent.click(bank2);

      expect(screen.getByText(/Channel 51/i)).toBeInTheDocument();
      expect(screen.queryByText(/Channel 1/i)).not.toBeInTheDocument();
    });
  });

  describe("Search Functionality", () => {
    it("should filter channels by frequency", async () => {
      render(<ChannelsTab />);
      const searchInput = screen.getByPlaceholderText(/search frequency or tag/i);
      await userEvent.type(searchInput, "151");

      expect(screen.getByText(/151\.2500/i)).toBeInTheDocument();
    });

    it("should filter channels by tag", async () => {
      render(<ChannelsTab />);
      const searchInput = screen.getByPlaceholderText(/search frequency or tag/i);
      await userEvent.type(searchInput, "Channel 51");

      expect(screen.getByText(/Channel 51/i)).toBeInTheDocument();
    });

    it("should show all channels when search is cleared", async () => {
      render(<ChannelsTab />);
      const searchInput = screen.getByPlaceholderText(/search frequency or tag/i);
      await userEvent.type(searchInput, "151");
      await userEvent.clear(searchInput);

      expect(screen.getByText(/Channel 1/i)).toBeInTheDocument();
      expect(screen.getByText(/Channel 51/i)).toBeInTheDocument();
    });

    it("should show no results message for non-matching search", async () => {
      render(<ChannelsTab />);
      const searchInput = screen.getByPlaceholderText(/search frequency or tag/i);
      await userEvent.type(searchInput, "nonexistent");

      expect(screen.getByText(/No channels match your filters/i)).toBeInTheDocument();
    });
  });

  describe("Channel List Display", () => {
    it("should render channel list", () => {
      render(<ChannelsTab />);
      expect(screen.getByText(/Channel 1/i)).toBeInTheDocument();
      expect(screen.getByText(/Channel 51/i)).toBeInTheDocument();
    });

    it("should render channel index", () => {
      render(<ChannelsTab />);
      expect(screen.getByText(/CH 1/i)).toBeInTheDocument();
      expect(screen.getByText(/CH 51/i)).toBeInTheDocument();
    });

    it("should render frequency", () => {
      render(<ChannelsTab />);
      expect(screen.getByText(/151\.2500/i)).toBeInTheDocument();
      expect(screen.getByText(/155\.5000/i)).toBeInTheDocument();
    });

    it("should render alpha tag", () => {
      render(<ChannelsTab />);
      expect(screen.getByText(/Channel 1/i)).toBeInTheDocument();
      expect(screen.getByText(/Channel 51/i)).toBeInTheDocument();
    });

    it("should show dash for empty alpha tag", () => {
      const mockChannels = [createTestChannel({ index: 1, alpha_tag: "" })];
      vi.mocked("../../../store/useStore").useStore
        .mockReturnValue(createMockStore({ channels: mockChannels }));

      render(<ChannelsTab />);
      const row = screen.getByText(/CH 1/i).closest("div");
      expect(within(row!).getByText("—")).toBeInTheDocument();
    });

    it("should render modulation", () => {
      render(<ChannelsTab />);
      expect(screen.getByText(/FM/i)).toBeInTheDocument();
    });

    it("should render delay", () => {
      render(<ChannelsTab />);
      expect(screen.getByText(/2s/i)).toBeInTheDocument();
    });

    it("should render lockout icon when channel is locked out", () => {
      const lockedChannel = createTestChannel({ index: 1, lockout: true });
      vi.mocked("../../../store/useStore").useStore
        .mockReturnValue(createMockStore({ channels: [lockedChannel] }));

      render(<ChannelsTab />);
      const lockIcon = screen.getByRole("img", { name: /lock/i });
      expect(lockIcon).toBeInTheDocument();
    });

    it("should render priority indicator when channel has priority", () => {
      const priorityChannel = createTestChannel({ index: 1, priority: true });
      vi.mocked("../../../store/useStore").useStore
        .mockReturnValue(createMockStore({ channels: [priorityChannel] }));

      render(<ChannelsTab />);
      const priorityIndicator = screen.getByRole("img", { name: /priority/i });
      expect(priorityIndicator).toBeInTheDocument();
    });

    it("should show locked channels with reduced opacity", () => {
      const lockedChannel = createTestChannel({ index: 1, lockout: true });
      vi.mocked("../../../store/useStore").useStore
        .mockReturnValue(createMockStore({ channels: [lockedChannel] }));

      render(<ChannelsTab />);
      const row = screen.getByText(/151\.2500/i).closest("div");
      expect(row).toHaveClass("opacity-50");
    });
  });

  describe("Channel Editing", () => {
    it("should open edit sheet when channel row is clicked", async () => {
      render(<ChannelsTab />);
      const channelRow = screen.getByText(/Channel 1/i).closest("div");
      if (channelRow) {
        await userEvent.click(channelRow);
        expect(screen.getByText(/Edit Channel/i)).toBeInTheDocument();
      }
    });

    it("should set editing channel index", async () => {
      render(<ChannelsTab />);
      const channelRow = screen.getByText(/Channel 1/i).closest("div");
      if (channelRow) {
        await userEvent.click(channelRow);
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      }
    });
  });

  describe("Import CSV", () => {
    it("should create file input when import button clicked", async () => {
      render(<ChannelsTab />);
      const importButton = screen.getByRole("button", { name: /Import CSV/i });
      await userEvent.click(importButton);

      const input = document.querySelector('input[type="file"]');
      expect(input).toBeInTheDocument();
    });

    it("should show success toast on successful import", async () => {
      mockApiClient.getChannels = vi.fn().mockResolvedValue([...mockChannels, createTestChannel({ index: 2 })]);
      
      render(<ChannelsTab />);
      const importButton = screen.getByRole("button", { name: /Import CSV/i });
      await userEvent.click(importButton);

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalled();
      });
    });

    it("should show error toast on failed import", async () => {
      mockApiClient.getChannels = vi.fn().mockRejectedValue(new Error("Import failed"));
      
      render(<ChannelsTab />);
      const importButton = screen.getByRole("button", { name: /Import CSV/i });
      await userEvent.click(importButton);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });
    });
  });

  describe("Export CSV", () => {
    it("should trigger download when export button clicked", async () => {
      const mockBlob = new Blob(["test"], { type: "text/csv" });
      global.URL.createObjectURL = vi.fn(() => "blob:mock-url");
      global.URL.revokeObjectURL = vi.fn();
      document.createElement = vi.fn((tag) => {
        if (tag === "a") {
          const anchor = { href: "", download: "", click: vi.fn() };
          return anchor as any;
        }
        return document.createElement(tag);
      });

      render(<ChannelsTab />);
      const exportButton = screen.getByRole("button", { name: /Export CSV/i });
      await userEvent.click(exportButton);

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith("Channels exported successfully");
      });
    });

    it("should show error toast on failed export", async () => {
      document.createElement = vi.fn((tag) => {
        if (tag === "a") {
          const anchor = { href: "", download: "", click: vi.fn() };
          return anchor as any;
        }
        return document.createElement(tag);
      });

      render(<ChannelsTab />);
      const exportButton = screen.getByRole("button", { name: /Export CSV/i });
      await userEvent.click(exportButton);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("Failed to export channels");
      });
    });
  });

  describe("Table Header", () => {
    it("should render table headers", () => {
      render(<ChannelsTab />);
      expect(screen.getByText(/CH/i)).toBeInTheDocument();
      expect(screen.getByText(/FREQ/i)).toBeInTheDocument();
      expect(screen.getByText(/TAG/i)).toBeInTheDocument();
      expect(screen.getByText(/MODE/i)).toBeInTheDocument();
      expect(screen.getByText(/TONE/i)).toBeInTheDocument();
      expect(screen.getByText(/DLY/i)).toBeInTheDocument();
      expect(screen.getByText(/L\/O/i)).toBeInTheDocument();
      expect(screen.getByText(/PRIO/i)).toBeInTheDocument();
    });
  });
});
