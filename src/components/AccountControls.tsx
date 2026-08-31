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

  const { name, email, image } = session.user;
  const label = name || email;

  return (
    <div className="flex items-center gap-2">
      {image && (
        <img
          src={image}
          alt=""
          width={20}
          height={20}
          className="size-5 rounded-full border border-[var(--line)]"
        />
      )}
      <span className="text-xs text-[var(--sea-ink-soft)]" title={email}>
        {label}
      </span>
      <button
        type="button"
        onClick={() => void handleSignOut()}
        className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-0.5 text-xs text-[var(--sea-ink)] transition hover:border-[var(--palm)]"
      >
        ログアウト
      </button>
    </div>
  );
}
