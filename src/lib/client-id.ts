// The undo-history owner id. Stored in localStorage, so every tab of the same
// browser shares one id — which is exactly the undo scope we want: "my" edits
// are undoable from any of my tabs and survive reloads. Other browsers (and
// the MCP endpoint, which uses the fixed id "mcp") have their own histories.

const CLIENT_ID_KEY = "tanstack-spreadsheet.client-id";

let memoryFallback: string | null = null;

export function getClientId(): string {
  if (typeof window === "undefined") return "ssr";
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    // storage unavailable (private mode etc.) — undo history lasts one tab session
    memoryFallback ??= crypto.randomUUID();
    return memoryFallback;
  }
}
