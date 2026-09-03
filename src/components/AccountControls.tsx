import AccountControlsView from "#/components/AccountControlsView";
import { signOut, useSession } from "#/lib/auth-client";

async function handleSignOut() {
  await signOut();
  // Reload rather than re-render: the sheet collections and the SSE stream hold
  // data this user should no longer see.
  window.location.href = "/";
}

export default function AccountControls() {
  const { data: session } = useSession();
  if (!session) return null;
  return <AccountControlsView user={session.user} onSignOut={() => void handleSignOut()} />;
}
