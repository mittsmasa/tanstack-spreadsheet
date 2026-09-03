import { expect } from "storybook/test";

import ThemeToggle from "#/components/ThemeToggle";

import type { Meta, StoryObj } from "@storybook/react-vite";

// The toggle reads localStorage on mount and writes the document root, so
// every story starts from a clean slate and leaves one behind.
function reset() {
  localStorage.removeItem("theme");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.style.colorScheme = "";
}

const meta = {
  component: ThemeToggle,
  beforeEach: () => {
    reset();
    return reset;
  },
} satisfies Meta<typeof ThemeToggle>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CyclesAutoLightDark: Story = {
  play: async ({ canvas, userEvent }) => {
    const root = document.documentElement;
    const button = canvas.getByRole("button");
    await expect(button).toHaveTextContent("Auto");

    await userEvent.click(button);
    await expect(button).toHaveTextContent("Light");
    await expect(root).toHaveAttribute("data-theme", "light");
    await expect(root).toHaveClass("light");
    await expect(localStorage.getItem("theme")).toBe("light");

    await userEvent.click(button);
    await expect(button).toHaveTextContent("Dark");
    await expect(root).toHaveAttribute("data-theme", "dark");
    await expect(root).toHaveClass("dark");
    await expect(localStorage.getItem("theme")).toBe("dark");

    await userEvent.click(button);
    await expect(button).toHaveTextContent("Auto");
    await expect(root).not.toHaveAttribute("data-theme");
    await expect(localStorage.getItem("theme")).toBe("auto");
  },
};

export const RestoresStoredMode: Story = {
  beforeEach: () => {
    localStorage.setItem("theme", "dark");
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button")).toHaveTextContent("Dark");
  },
};
