import { expect, fn } from "storybook/test";

import InlineRename from "#/components/InlineRename";

import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  component: InlineRename,
  args: {
    value: "シート1",
    onCommit: fn(async () => true),
    onDone: fn(),
  },
} satisfies Meta<typeof InlineRename>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CommitsOnEnter: Story = {
  play: async ({ canvas, userEvent, args }) => {
    const input = canvas.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "  売上  {Enter}");
    await expect(args.onCommit).toHaveBeenCalledWith("売上");
    await expect(args.onDone).toHaveBeenCalled();
  },
};

export const CommitsOnBlur: Story = {
  play: async ({ canvas, userEvent, args }) => {
    const input = canvas.getByRole("textbox");
    await userEvent.type(input, "!");
    await userEvent.tab();
    await expect(args.onCommit).toHaveBeenCalledWith("シート1!");
    await expect(args.onDone).toHaveBeenCalled();
  },
};

export const CancelsOnEscape: Story = {
  play: async ({ canvas, userEvent, args }) => {
    const input = canvas.getByRole("textbox");
    await userEvent.type(input, "x{Escape}");
    await expect(args.onDone).toHaveBeenCalled();
    await expect(args.onCommit).not.toHaveBeenCalled();
  },
};

export const UnchangedNameSkipsCommit: Story = {
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.type(canvas.getByRole("textbox"), "{Enter}");
    await expect(args.onDone).toHaveBeenCalled();
    await expect(args.onCommit).not.toHaveBeenCalled();
  },
};

export const RejectedNameStaysOpen: Story = {
  args: { onCommit: fn(async () => false) },
  play: async ({ canvas, userEvent, args }) => {
    const input = canvas.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "重複{Enter}");
    await expect(args.onCommit).toHaveBeenCalledWith("重複");
    await expect(args.onDone).not.toHaveBeenCalled();
    await expect(input).toHaveClass("border-red-500");
    await expect(input).toHaveAttribute("title", "この名前は使えません（空・重複）");
    // typing again clears the failed state
    await userEvent.type(input, "2");
    await expect(input).not.toHaveClass("border-red-500");
  },
};

export const EmptyNameIsRejectedLocally: Story = {
  play: async ({ canvas, userEvent, args }) => {
    const input = canvas.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "{Enter}");
    await expect(args.onCommit).not.toHaveBeenCalled();
    await expect(args.onDone).not.toHaveBeenCalled();
    await expect(input).toHaveClass("border-red-500");
  },
};
