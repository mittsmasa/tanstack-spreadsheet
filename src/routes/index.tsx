import { createFileRoute } from "@tanstack/react-router";

import Spreadsheet from "#/components/Spreadsheet";

export const Route = createFileRoute("/")({
  // cell data lives in localStorage, so render client-side only to avoid
  // hydration mismatches against the empty server-side fallback storage
  ssr: false,
  component: Spreadsheet,
});
