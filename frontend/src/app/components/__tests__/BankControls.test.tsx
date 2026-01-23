import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { BankControls } from "../ScannerUI";

describe("BankControls", () => {
  const defaultProps = {
    activeBanks: [true, true, true, true, true, true, true, true, true, true],
    onToggleBank: vi.fn(),
  };

  describe("rendering", () => {
    it("should render 10 bank buttons", () => {
      render(<BankControls {...defaultProps} />);
      const buttons = screen.getAllByRole("button");
      expect(buttons).toHaveLength(10);
    });

    it("should render bank numbers 1-0", () => {
      render(<BankControls {...defaultProps} />);
      expect(screen.getByRole("button", { name: "1" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "5" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "0" })).toBeInTheDocument();
    });

    it("should apply active styles to enabled banks", () => {
      render(<BankControls {...defaultProps} activeBanks={[true, false, false, false, false, false, false, false, false, false]} />);
      const bank1 = screen.getByRole("button", { name: "1" });
      const bank2 = screen.getByRole("button", { name: "2" });
      expect(bank1).toHaveClass("bg-scanner-bg-semiDark");
      expect(bank1).toHaveClass("border-brand-primary");
      expect(bank2).toHaveClass("bg-scanner-default");
      expect(bank2).toHaveClass("border-scanner-border");
    });

    it("should apply inactive styles to disabled banks", () => {
      render(<BankControls {...defaultProps} activeBanks={[false, true, true, true, true, true, true, true, true, true]} />);
      const bank1 = screen.getByRole("button", { name: "1" });
      expect(bank1).toHaveClass("bg-scanner-default");
      expect(bank1).toHaveClass("border-scanner-border");
      expect(bank1).toHaveClass("shadow-button");
    });
  });

  describe("user interactions", () => {
    it("should call onToggleBank with correct index when bank button is clicked", async () => {
      const onToggleBank = vi.fn();
      render(<BankControls {...defaultProps} onToggleBank={onToggleBank} />);

      const bank3 = screen.getByRole("button", { name: "3" });
      await userEvent.click(bank3);

      expect(onToggleBank).toHaveBeenCalledWith(2);
    });

    it("should call onToggleBank with index 9 when bank 10 (button 0) is clicked", async () => {
      const onToggleBank = vi.fn();
      render(<BankControls {...defaultProps} onToggleBank={onToggleBank} />);

      const bank0 = screen.getByRole("button", { name: "0" });
      await userEvent.click(bank0);

      expect(onToggleBank).toHaveBeenCalledWith(9);
    });

    it("should allow toggling each bank independently", async () => {
      const onToggleBank = vi.fn();
      render(<BankControls {...defaultProps} onToggleBank={onToggleBank} />);

      for (let i = 0; i < 10; i++) {
        const label = i === 9 ? "0" : (i + 1).toString();
        const button = screen.getByRole("button", { name: label });
        await userEvent.click(button);
        expect(onToggleBank).toHaveBeenNthCalledWith(i + 1, i);
      }
    });
  });

  describe("edge cases", () => {
    it("should handle all banks enabled", () => {
      const allEnabled = Array.from({ length: 10 }, () => true);
      render(<BankControls {...defaultProps} activeBanks={allEnabled} />);

      const buttons = screen.getAllByRole("button");
      buttons.forEach((button) => {
        expect(button).toHaveClass("bg-scanner-bg-semiDark");
      });
    });

    it("should handle all banks disabled", () => {
      const allDisabled = Array.from({ length: 10 }, () => false);
      render(<BankControls {...defaultProps} activeBanks={allDisabled} />);

      const buttons = screen.getAllByRole("button");
      buttons.forEach((button) => {
        expect(button).toHaveClass("bg-scanner-default");
      });
    });

    it("should handle mixed bank states", () => {
      const mixed = [true, false, true, false, true, false, true, false, true, false];
      render(<BankControls {...defaultProps} activeBanks={mixed} />);

      const buttons = screen.getAllByRole("button");
      buttons.forEach((button, index) => {
        if (mixed[index]) {
          expect(button).toHaveClass("bg-scanner-bg-semiDark");
        } else {
          expect(button).toHaveClass("bg-scanner-default");
        }
      });
    });
  });
});
