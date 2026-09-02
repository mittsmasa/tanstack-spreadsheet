import "../src/styles.css";

import type { Decorator, Preview } from "@storybook/react-vite";

// The app's palette lives in CSS variables on :root and switches on
// data-theme (see src/styles.css), so the toolbar just flips that attribute.
const withTheme: Decorator = (Story, context) => {
  const theme = context.globals.theme as string;
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
  return Story();
};

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Color theme",
      toolbar: {
        title: "Theme",
        icon: "paintbrush",
        items: ["light", "dark"],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  decorators: [withTheme],
};

export default preview;
