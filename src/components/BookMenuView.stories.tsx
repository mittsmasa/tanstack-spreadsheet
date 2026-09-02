import { expect, fn } from "storybook/test";

import BookMenuView from "#/components/BookMenuView";

import type { Meta, StoryObj } from "@storybook/react-vite";

const books = [
  { id: "b1", name: "ブック1" },
  { id: "b2", name: "家計簿" },
];

const meta = {
  component: BookMenuView,
  args: {
    books,
    activeId: "b1",
    onOpen: fn(),
    onCreate: fn(),
    onRename: fn(async () => true),
    onDelete: fn(),
  },
} satisfies Meta<typeof BookMenuView>;

export default meta;

type Story = StoryObj<typeof meta>;

const trigger = (canvas: { getByTitle: (title: string) => HTMLElement }) =>
  canvas.getByTitle("ブックを切り替える");

export const Closed: Story = {
  play: async ({ canvas }) => {
    await expect(trigger(canvas)).toHaveTextContent("ブック1");
    await expect(trigger(canvas)).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.queryByRole("button", { name: "家計簿" })).not.toBeInTheDocument();
  },
};

export const Open: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(trigger(canvas));
    await expect(trigger(canvas)).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByRole("button", { name: "家計簿" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "＋ ブックを追加" })).toBeInTheDocument();
  },
};

export const OpensAnotherBook: Story = {
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(trigger(canvas));
    await userEvent.click(canvas.getByRole("button", { name: "家計簿" }));
    await expect(args.onOpen).toHaveBeenCalledWith("b2");
    await expect(trigger(canvas)).toHaveAttribute("aria-expanded", "false");
  },
};

export const CreatesBook: Story = {
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(trigger(canvas));
    await userEvent.click(canvas.getByRole("button", { name: "＋ ブックを追加" }));
    await expect(args.onCreate).toHaveBeenCalledTimes(1);
    await expect(trigger(canvas)).toHaveAttribute("aria-expanded", "false");
  },
};

export const RenamesBook: Story = {
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(trigger(canvas));
    await userEvent.click(canvas.getByTitle("家計簿 の名前を変える"));
    const input = canvas.getByRole("textbox");
    await expect(input).toHaveValue("家計簿");
    await userEvent.clear(input);
    await userEvent.type(input, "2026 家計簿{Enter}");
    await expect(args.onRename).toHaveBeenCalledWith("b2", "2026 家計簿");
    await expect(canvas.queryByRole("textbox")).not.toBeInTheDocument();
    // renaming does not close the menu
    await expect(trigger(canvas)).toHaveAttribute("aria-expanded", "true");
  },
};

export const DeleteAsksForConfirmation: Story = {
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(trigger(canvas));
    await userEvent.click(canvas.getByTitle("家計簿 を削除（中のシートも消えます）"));
    await expect(args.onDelete).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "削除?" }));
    await expect(args.onDelete).toHaveBeenCalledWith("b2");
  },
};

export const SingleBookHasNoDelete: Story = {
  args: { books: [books[0]!] },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(trigger(canvas));
    await expect(canvas.getByTitle("ブック1 の名前を変える")).toBeInTheDocument();
    await expect(canvas.queryByTitle(/を削除/)).not.toBeInTheDocument();
  },
};

export const ClosesOnEscape: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(trigger(canvas));
    await expect(trigger(canvas)).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    await expect(trigger(canvas)).toHaveAttribute("aria-expanded", "false");
  },
};

export const ClosesOnOutsideClick: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(trigger(canvas));
    await userEvent.click(document.body);
    await expect(trigger(canvas)).toHaveAttribute("aria-expanded", "false");
  },
};
