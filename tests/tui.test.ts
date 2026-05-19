import { afterEach, describe, expect, it, vi } from "vitest";

const cancelSymbol = Symbol("cancel");

const promptsMock = vi.hoisted(() => ({
  confirm: vi.fn(),
  isCancel: vi.fn((value: unknown) => value === cancelSymbol),
  select: vi.fn(),
  text: vi.fn()
}));

vi.mock("@clack/prompts", () => promptsMock);

import { ask, confirm, PromptCancelledError, selectMenu } from "../src/tui.js";

describe("TUI prompts", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses clack text prompts for freeform input", async () => {
    promptsMock.text.mockResolvedValue("  example  ");

    await expect(ask("Machine name", "fallback")).resolves.toBe("example");
    expect(promptsMock.text).toHaveBeenCalledWith({
      message: "Machine name",
      defaultValue: "fallback",
      placeholder: "fallback"
    });
  });

  it("throws a cancellation error when text input is cancelled", async () => {
    promptsMock.text.mockResolvedValue(cancelSymbol);

    await expect(ask("Pairing code")).rejects.toBeInstanceOf(PromptCancelledError);
  });

  it("uses clack confirm prompts for yes/no decisions", async () => {
    promptsMock.confirm.mockResolvedValue(true);

    await expect(confirm("Replace meter?", false)).resolves.toBe(true);
    expect(promptsMock.confirm).toHaveBeenCalledWith({
      message: "Replace meter?",
      initialValue: false,
      active: "Yes",
      inactive: "No"
    });
  });

  it("treats cancelled confirmations as a negative answer", async () => {
    promptsMock.confirm.mockResolvedValue(cancelSymbol);

    await expect(confirm("Replace meter?", true)).resolves.toBe(false);
  });

  it("uses clack select prompts for single-choice menus", async () => {
    promptsMock.select.mockResolvedValue("sync");

    await expect(
      selectMenu(
        "Choose an action",
        [
          { label: "View status", value: "status" },
          { label: "Sync now", value: "sync" },
          { label: "Quit", value: "quit" }
        ],
        1
      )
    ).resolves.toBe("sync");
    expect(promptsMock.select).toHaveBeenCalledWith({
      message: "Choose an action",
      initialValue: "sync",
      options: [
        { label: "View status", value: "status" },
        { label: "Sync now", value: "sync" },
        { label: "Quit", value: "quit" }
      ]
    });
  });

  it("returns undefined when a selection is cancelled", async () => {
    promptsMock.select.mockResolvedValue(cancelSymbol);

    await expect(selectMenu("Choose an action", [{ label: "Quit", value: "quit" }])).resolves.toBeUndefined();
  });
});
