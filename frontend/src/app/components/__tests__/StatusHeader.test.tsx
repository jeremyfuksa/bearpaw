import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { StatusHeader } from "../ScannerUI";

describe("StatusHeader", () => {
  const defaultProps = {
    volume: 10,
    onVolumeChange: vi.fn(),
    isHolding: false,
    onHoldToggle: vi.fn(),
    onLockout: vi.fn(),
    isRecording: false,
    onRecordingToggle: vi.fn(),
    isDashboardMode: false,
    onDashboardToggle: vi.fn(),
  };

  describe("rendering", () => {
    it("should render volume button with current volume", () => {
      render(<StatusHeader {...defaultProps} />);
      const volumeButton = screen.getByRole("button", { name: /VOL 10/i });
      expect(volumeButton).toBeInTheDocument();
    });

    it("should render L/O button", () => {
      render(<StatusHeader {...defaultProps} />);
      const lockoutButton = screen.getByRole("button", { name: /L\/O/i });
      expect(lockoutButton).toBeInTheDocument();
    });


    it("should render HOLD button", () => {
      render(<StatusHeader {...defaultProps} />);
      const holdButton = screen.getByRole("button", { name: /HOLD/i });
      expect(holdButton).toBeInTheDocument();
    });

    it("should render recording button with correct label", () => {
      render(<StatusHeader {...defaultProps} />);
      const recordingButton = screen.getByRole("button", { name: /REC/i });
      expect(recordingButton).toBeInTheDocument();
    });

    it("should apply recording styles when isRecording is true", () => {
      render(<StatusHeader {...defaultProps} isRecording={true} />);
      const recordingButton = screen.getByRole("button", { name: /REC/i });
      expect(recordingButton).toHaveClass("bg-red-500/20");
    });

    it("should apply HOLD styles when isHolding is true", () => {
      render(<StatusHeader {...defaultProps} isHolding={true} />);
      const holdButton = screen.getByRole("button", { name: /HOLD/i });
      expect(holdButton).toHaveClass("bg-scanner-bg-semiDark");
    });
  });

  describe("user interactions", () => {
    it("should call onLockout with 'temporary' on single L/O click", async () => {
      const onLockout = vi.fn();
      render(<StatusHeader {...defaultProps} onLockout={onLockout} />);

      const lockoutButton = screen.getByRole("button", { name: /L\/O/i });
      await userEvent.click(lockoutButton);

      expect(onLockout).toHaveBeenCalledWith("temporary");
    });

    it("should call onLockout with 'permanent' on double L/O click", async () => {
      const onLockout = vi.fn();
      render(<StatusHeader {...defaultProps} onLockout={onLockout} />);

      const lockoutButton = screen.getByRole("button", { name: /L\/O/i });
      await userEvent.dblClick(lockoutButton);

      expect(onLockout).toHaveBeenCalledWith("permanent");
    });

    it("should call onHoldToggle when HOLD button is clicked", async () => {
      const onHoldToggle = vi.fn();
      render(<StatusHeader {...defaultProps} onHoldToggle={onHoldToggle} />);

      const holdButton = screen.getByRole("button", { name: /HOLD/i });
      await userEvent.click(holdButton);

      expect(onHoldToggle).toHaveBeenCalledTimes(1);
    });


    it("should call onRecordingToggle when recording button is clicked", async () => {
      const onRecordingToggle = vi.fn();
      render(<StatusHeader {...defaultProps} onRecordingToggle={onRecordingToggle} />);

      const recordingButton = screen.getByRole("button", { name: /REC/i });
      await userEvent.click(recordingButton);

      expect(onRecordingToggle).toHaveBeenCalledTimes(1);
    });
  });
});
