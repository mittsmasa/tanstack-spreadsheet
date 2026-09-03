import { expect, fn } from "storybook/test";

import LoginScreenView from "#/components/LoginScreenView";

import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  component: LoginScreenView,
  parameters: { layout: "fullscreen" },
  args: {
    error: null,
    onSignIn: fn(),
  },
} satisfies Meta<typeof LoginScreenView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Google でログイン" }));
    await expect(args.onSignIn).toHaveBeenCalledTimes(1);
  },
};

export const WithError: Story = {
  args: { error: "ログインに失敗しました" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("ログインに失敗しました")).toBeInTheDocument();
  },
};
