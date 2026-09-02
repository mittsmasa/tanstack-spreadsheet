export type AccountUser = {
  name?: string | null;
  email: string;
  image?: string | null;
};

/** The signed-in user chip with a sign-out button. Pure: AccountControls
 * feeds it the session. */
export default function AccountControlsView({
  user,
  onSignOut,
}: {
  user: AccountUser;
  onSignOut: () => void;
}) {
  const { name, email, image } = user;
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
        onClick={onSignOut}
        className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-0.5 text-xs text-[var(--sea-ink)] transition hover:border-[var(--palm)]"
      >
        ログアウト
      </button>
    </div>
  );
}
