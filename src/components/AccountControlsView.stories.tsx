import { expect, fn } from "storybook/test";

import AccountControlsView from "#/components/AccountControlsView";

import type { Meta, StoryObj } from "@storybook/react-vite";

// inline SVG so the story never reaches the network
const avatar =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#2f6a4a"/></svg>',
  );

const meta = {
  component: AccountControlsView,
  args: {
    user: { name: "真綾", email: "maaya@example.com", image: avatar },
    onSignOut: fn(),
  },
} satisfies Meta<typeof AccountControlsView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithAvatar: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("presentation")).toHaveAttribute("src", avatar);
    await expect(canvas.getByTitle("maaya@example.com")).toHaveTextContent("真綾");
  },
};

export const EmailOnly: Story = {
  args: { user: { email: "maaya@example.com" } },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("presentation")).not.toBeInTheDocument();
    await expect(canvas.getByTitle("maaya@example.com")).toHaveTextContent("maaya@example.com");
  },
};

export const SignsOut: Story = {
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: "ログアウト" }));
    await expect(args.onSignOut).toHaveBeenCalledTimes(1);
  },
};
