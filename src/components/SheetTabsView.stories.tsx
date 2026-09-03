import { expect, fn } from "storybook/test";

import SheetTabsView from "#/components/SheetTabsView";

import type { Meta, StoryObj } from "@storybook/react-vite";

const sheets = [
  { id: "s1", name: "シート1" },
  { id: "s2", name: "シート2" },
  { id: "s3", name: "とても長い名前のシートなので途中で省略される" },
];

const meta = {
  component: SheetTabsView,
  args: {
    sheets,
    activeId: "s2",
    onSelect: fn(),
    onCreate: fn(),
    onRename: fn(async () => true),
    onDelete: fn(),
  },
} satisfies Meta<typeof SheetTabsView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SingleSheet: Story = {
  args: { sheets: [sheets[0]!], activeId: "s1" },
  play: async ({ canvas }) => {
    // the last sheet cannot be deleted, so no ✕ is offered
    await expect(canvas.queryByTitle(/を削除$/)).not.toBeInTheDocument();
  },
};

export const SelectsOnClick: Story = {
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: "シート1" }));
    await expect(args.onSelect).toHaveBeenCalledWith("s1");
  },
};

export const CreatesOnPlus: Story = {
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByTitle("シートを追加"));
    await expect(args.onCreate).toHaveBeenCalledTimes(1);
  },
};

export const RenamesOnDoubleClick: Story = {
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.dblClick(canvas.getByRole("button", { name: "シート2" }));
    const input = canvas.getByRole("textbox");
    await expect(input).toHaveValue("シート2");
    await userEvent.clear(input);
    await userEvent.type(input, "集計{Enter}");
    await expect(args.onRename).toHaveBeenCalledWith("s2", "集計");
    // the container's next sheets prop carries the new name; the input closes
    await expect(canvas.queryByRole("textbox")).not.toBeInTheDocument();
  },
};

export const DeleteAsksForConfirmation: Story = {
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByTitle("シート2 を削除"));
    const confirm = canvas.getByRole("button", { name: "削除?" });
    await expect(args.onDelete).not.toHaveBeenCalled();
    await userEvent.click(confirm);
    await expect(args.onDelete).toHaveBeenCalledWith("s2");
    await expect(canvas.queryByRole("button", { name: "削除?" })).not.toBeInTheDocument();
  },
};

export const ConfirmationCancelsOnOutsideClick: Story = {
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByTitle("シート2 を削除"));
    await expect(canvas.getByRole("button", { name: "削除?" })).toBeInTheDocument();
    await userEvent.click(document.body);
    await expect(canvas.queryByRole("button", { name: "削除?" })).not.toBeInTheDocument();
    await expect(args.onDelete).not.toHaveBeenCalled();
  },
};
