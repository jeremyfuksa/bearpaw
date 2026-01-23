import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { DeviceTab } from "../views/DeviceTab";
import { mockApiResponses, mockApiErrors } from "../../test/fixtures";
import { createMockApiClient } from "../../test/mocks";
import { createTestLiveState, createTestDeviceInfo, createTestChannel } from "../../test/fixtures";

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

describe("DeviceTab", () => {
  let mockApiClient: ReturnType<typeof createMockApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient = createMockApiClient();
    vi.mocked("../../api/useApi").useAPI.mockReturnValue(mockApiClient);
  });

  describe("Sync category", () => {
    it("should render Start Sync button", () => {
      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);
      expect(screen.getByText(/Start Sync/i)).toBeInTheDocument();
    });

    it("should call onMemorySync when Start Sync button is clicked", async () => {
      const onMemorySync = vi.fn();
      render(<DeviceTab isMemorySyncing={false} onMemorySync={onMemorySync} />);

      const syncButton = screen.getByRole("button", { name: /Start Sync/i });
      await userEvent.click(syncButton);

      expect(onMemorySync).toHaveBeenCalledOnce();
    });

    it("should disable Start Sync button when syncing", () => {
      render(<DeviceTab isMemorySyncing={true} onMemorySync={vi.fn()} />);
      const syncButton = screen.getByRole("button", { name: /Syncing/i });
      expect(syncButton).toBeDisabled();
    });

    it("should show sync in progress state", () => {
      render(<DeviceTab isMemorySyncing={true} onMemorySync={vi.fn()} />);
      expect(screen.getByText(/Syncing/i)).toBeInTheDocument();
    });
  });

  describe("Locked Channels category", () => {
    it("should render channel list when category selected", async () => {
      const mockChannels = [
        createTestChannel({ index: 1, frequency: 151.25, bank: 1 }),
        createTestChannel({ index: 5, frequency: 155.5, bank: 2 }),
      ];
      mockApiClient.getChannels = vi.fn().mockResolvedValue(mockChannels);
      mockApiClient.getLockouts = vi.fn().mockResolvedValue({
        channels: [1, 5],
        frequencies: [],
        temporary_channels: [],
      });

      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);

      await waitFor(() => screen.getByText(/Locked Channels/i));

      expect(screen.getByText(/1 locked/i)).toBeInTheDocument();
      expect(screen.getByText(/CH 1/i)).toBeInTheDocument();
      expect(screen.getByText(/151.2500/i)).toBeInTheDocument();
    });

    it("should call unlock when Unlock Selected button clicked", async () => {
      const mockChannels = [createTestChannel({ index: 1 })];
      mockApiClient.getChannels = vi.fn().mockResolvedValue(mockChannels);
      mockApiClient.clearChannelLockouts = vi.fn().mockResolvedValue({
        cleared: [1],
        failed: [],
      });

      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);

      await waitFor(() => {
        const checkbox = screen.getByRole("checkbox");
        await userEvent.click(checkbox);
      });

      const unlockButton = screen.getByRole("button", { name: /Unlock Selected/i });
      await userEvent.click(unlockButton);

      await waitFor(() => {
        expect(mockApiClient.clearChannelLockouts).toHaveBeenCalledWith([1]);
      });
    });

    it("should call unlock all when Unlock All button clicked", async () => {
      mockApiClient.getLockouts = vi.fn().mockResolvedValue({
        channels: [1, 2, 3],
        frequencies: [],
        temporary_channels: [],
      });
      mockApiClient.clearChannelLockouts = vi.fn().mockResolvedValue({
        cleared: [1, 2, 3],
        failed: [],
      });

      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);

      await waitFor(() => screen.getByRole("button", { name: /Unlock All/i }));
      await userEvent.click(screen.getByRole("button", { name: /Unlock All/i }));

      expect(mockApiClient.clearChannelLockouts).toHaveBeenCalled();
    });
  });

  describe("Device Config - Volume", () => {
    it("should update volume when slider changes", async () => {
      mockApiClient.setVolume = vi.fn().mockResolvedValue(undefined);

      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);

      const slider = screen.getByRole("slider");
      await userEvent.click(slider);

      expect(mockApiClient.setVolume).toHaveBeenCalled();
    });
  });

  describe("Device Config - Backlight", () => {
    it("should call setBacklight when option selected", async () => {
      mockApiClient.setBacklight = vi.fn().mockResolvedValue(undefined);

      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);

      const selectTrigger = screen.getByRole("combobox", { name: /Backlight/i });
      await userEvent.click(selectTrigger);

      const option = screen.getByRole("option", { name: /Always On/i });
      await userEvent.click(option);

      expect(mockApiClient.setBacklight).toHaveBeenCalledWith("AO");
    });
  });

  describe("Device Config - Priority Mode", () => {
    it("should call setPrioritySettings when option selected", async () => {
      mockApiClient.setPrioritySettings = vi.fn().mockResolvedValue(undefined);

      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);

      const selectTrigger = screen.getByRole("combobox", { name: /Priority Mode/i });
      await userEvent.click(selectTrigger);

      const option = screen.getByRole("option", { name: /On/i });
      await userEvent.click(option);

      expect(mockApiClient.setPrioritySettings).toHaveBeenCalledWith(1);
    });
  });

  describe("Device Config - Close Call", () => {
    it("should call setCloseCallSettings when mode changed", async () => {
      mockApiClient.setCloseCallSettings = vi.fn().mockResolvedValue(undefined);

      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);

      const selectTrigger = screen.getByRole("combobox", { name: /Mode/i });
      await userEvent.click(selectTrigger);

      const option = screen.getByRole("option", { name: /CC DND/i });
      await userEvent.click(option);

      expect(mockApiClient.setCloseCallSettings).toHaveBeenCalled();
    });

    it("should toggle lockout switch", async () => {
      mockApiClient.setCloseCallSettings = vi.fn().mockResolvedValue(undefined);

      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);

      const lockoutSwitch = screen.getByRole("switch", { name: /Lockout/i });
      await userEvent.click(lockoutSwitch);

      expect(mockApiClient.setCloseCallSettings).toHaveBeenCalled();
    });

    it("should toggle beep switch", async () => {
      mockApiClient.setCloseCallSettings = vi.fn().mockResolvedValue(undefined);

      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);

      const beepSwitch = screen.getByRole("switch", { name: /Alert Beep/i });
      await userEvent.click(beepSwitch);

      expect(mockApiClient.setCloseCallSettings).toHaveBeenCalled();
    });

    it("should toggle light switch", async () => {
      mockApiClient.setCloseCallSettings = vi.fn().mockResolvedValue(undefined);

      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);

      const lightSwitch = screen.getByRole("switch", { name: /Alert Light/i });
      await userEvent.click(lightSwitch);

      expect(mockApiClient.setCloseCallSettings).toHaveBeenCalled();
    });
  });

  describe("Service Search", () => {
    it("should toggle service search group", async () => {
      mockApiClient.setServiceSearchSettings = vi.fn().mockResolvedValue(undefined);

      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);

      const switch = screen.getAllByRole("switch").find(s => s.getAttribute("id")?.includes("service"));
      if (switch) {
        await userEvent.click(switch);
        expect(mockApiClient.setServiceSearchSettings).toHaveBeenCalled();
      }
    });
  });

  describe("Custom Search", () => {
    it("should toggle search range enable", async () => {
      mockApiClient.setCustomSearchSettings = vi.fn().mockResolvedValue(undefined);

      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);

      const switches = screen.getAllByRole("switch").filter(s => s.getAttribute("id")?.includes("range"));
      if (switches[0]) {
        await userEvent.click(switches[0]);
        expect(mockApiClient.setCustomSearchSettings).toHaveBeenCalled();
      }
    });

    it("should update range label", async () => {
      mockApiClient.setCustomSearchRange = vi.fn().mockResolvedValue(undefined);

      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);

      const inputs = screen.getAllByRole("textbox").filter(i => i.getAttribute("id")?.includes("label"));
      if (inputs[0]) {
        await userEvent.type(inputs[0], "Test Label");
      }

      await waitFor(() => {
        expect(mockApiClient.setCustomSearchRange).toHaveBeenCalled();
      });
    });
  });

  describe("Preferences category", () => {
    it("should render preference controls", () => {
      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);
      expect(screen.getByText(/Preferences/i)).toBeInTheDocument();
    });

    it("should render external links", () => {
      render(<DeviceTab isMemorySyncing={false} onMemorySync={vi.fn()} />);
      expect(screen.getByRole("link", { name: /Help/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /GitHub/i })).toBeInTheDocument();
    });
  });
});
