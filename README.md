Welcome to your new TanStack Start app!

# Getting Started

To run this application:

```bash
pnpm install
pnpm db:migrate   # ローカル D1 にスキーマを当てる（初回と migration 追加時）
pnpm dev
```

初回は認証のセットアップが必要（下記）。アプリは Cloudflare Workers 上で動く前提で、ローカルでは `pnpm dev` が workerd（miniflare）で Worker を動かす。本番へは「Deploy」の節を参照。

# 認証

Better Auth による Google ログイン必須。未ログインではログイン画面だけが表示され、`/api/*` と WebSocket (`/api/stream`) は 401、`/mcp` は OAuth のチャレンジを返す。

## セットアップ

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) で OAuth 同意画面を設定し、「OAuth クライアント ID」を**ウェブアプリケーション**として作成する
2. 承認済みのリダイレクト URI に `http://localhost:3210/api/auth/callback/google` を追加する
3. 同意画面の「テストユーザー」に自分の Google アカウントを追加する（公開ステータスが「テスト中」の間、ログインできるのはここに載ったユーザーだけ）
4. age の秘密鍵を OS keychain に入れる（**リポジトリ外に出るのはこの鍵だけ**）

```bash
security add-generic-password -s fnox -a age-key -w '<AGE-SECRET-KEY-...>' -U
```

5. 設定を [fnox](https://github.com/jdx/fnox) の age プロバイダで暗号化して `fnox.toml` に入れる

```bash
openssl rand -base64 32 | fnox --no-daemon set BETTER_AUTH_SECRET
fnox --no-daemon set GOOGLE_CLIENT_ID
fnox --no-daemon set GOOGLE_CLIENT_SECRET
```

**`--no-daemon` は必須。**付けないと `✓ Set secret` と表示されるのに書き込まれず、あとで `not found` になる（fnox 1.32.0 で確認）。

6. ローカル D1 にスキーマを当てる（auth のテーブルもスプレッドシートと同じ D1 に同居する）

```bash
pnpm db:migrate
```

## 設定の持ち方

暗号化された値は `fnox.toml` に直接入っていて、復号できるのは age 秘密鍵を持つ人だけ。その鍵は OS keychain にあり、リポジトリには含まれない。age プロバイダの `identity = { provider = "keychain", value = "age-key" }` が keychain から鍵を取り出すので、事前に環境変数を用意する必要はない。

`pnpm dev` は先に `scripts/dev-vars.sh` を実行し、fnox から `BETTER_AUTH_SECRET` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` を取り出して `.dev.vars`（gitignore 済み、owner のみ読める）に書く。Cloudflare の Vite plugin がこれを Worker の secrets として読み込む。`BETTER_AUTH_URL` はローカルでは `http://localhost:3210` を同スクリプトが書き、本番では `wrangler.jsonc` の `vars` が持つ。`pnpm build` に設定は要らない。

本番の secrets は fnox ではなく `wrangler secret put` で Cloudflare に置く（Deploy の節）。

fnox 本体は `mise.toml` が固定する（npm パッケージではなく mise 経由で入る）。

**注意**: `fnox.toml` の暗号文は public リポジトリに載る。強度は age（X25519 + ChaCha20-Poly1305）と鍵の管理に依存する。平文の credentials は当然コミットしないこと。

## 仕組み

- auth のルートは Worker の `server/api.ts` が `/api/auth/*` を `auth.handler` に渡す。ブラウザ向けはセッション Cookie、`/mcp` は OAuth の bearer トークンで検証する
- auth のテーブルは D1 binding `DB` をそのまま Better Auth に渡して同居させる。スキーマは `migrations/0001_auth.sql` にあり、`pnpm auth:generate`（`server/auth.cli.ts` を Node の `node:sqlite` in-memory DB で読む）が生成する。Better Auth を上げてスキーマが変わったら、再生成した差分を新しい migration ファイルに切る
- `/consent` は MCP クライアントの認可を承認する画面。ブラウザから直接開くものではない

# Storage & MCP

## データの保存先

スプレッドシートのデータ（ブック・シート・セル・列幅）の SSoT は Cloudflare D1（SQLite）。ローカルでは miniflare が `.wrangler/state/`（gitignore 済み）に持つローカル D1 を使い、`pnpm db:migrate` で `migrations/*.sql` を当てる。ブラウザ側の collection はカスタム sync によるミラー（シートごとに 1 collection）で、タブ間同期は WebSocket（`/api/stream`）経由。接続はユーザーごとの Durable Object `SyncHub` が束ね、`server/db.ts` の書き込みが確定するたびにそこへ配信する。

## ブックとシート

データは `ブック > シート > セル` の 3 層。

- **ブック**はログインユーザーごとに分かれる。他人のブックは一覧に出ず、URL を直接開いても 404 を返す（403 ではないので、存在するかどうかも分からない）
- ブックは URL で表す（`/b/<bookId>`）。`/` を開くと自分の先頭ブックへリダイレクトし、1 冊も無ければ 1 冊作ってから飛ぶ
- ヘッダー左のブック名を押すと、作成・切替・リネーム・削除ができる。最後の 1 冊は削除できない
- **シート**はブックの中にあり、画面下部のタブバーから作成・切替・リネーム・削除できる。シート名の一意性はブック内なので、別のブックなら同じシート名を使える
- ブックを削除すると、その中のシート・セル・列幅・undo 履歴もまとめて消える
- ソート・フィルタ・undo 履歴・アクティブシートはタブローカル。アクティブシートはブックごとに憶える

`cells` / `sheet_meta` / `history` はシート id だけで引く（シート id は UUID でグローバルに一意）。ブックの所属を持つのは `sheets` テーブルだけで、権限判定は シート → ブック → owner と辿る。

- スキーマは `migrations/` の SQL で管理する（`0001_auth.sql` は生成物、`0002_spreadsheet.sql` は手書き）。変更は新しい番号のファイルを足し、ローカルは `pnpm db:migrate`、本番は `pnpm db:migrate:remote` で当てる
- 変更通知は `server/db.ts` を通った書き込みしか拾わない。`wrangler d1 execute` などで直接 D1 に書いた変更は、次の snapshot（タブの再接続）まで開いているタブには届かない

## MCP サーバー

Worker が `/mcp` に MCP エンドポイント（streamable HTTP）をホストする。ローカルは `http://localhost:3210/mcp`、本番は `https://<worker>/mcp`。Claude Code からの登録:

```bash
claude mcp add --transport http tanstack-spreadsheet http://localhost:3210/mcp
```

エンドポイントは OAuth で保護されている。初回接続時にクライアントが自分を動的登録（DCR）し、ブラウザが開いて Google ログイン → 認可画面へ進む。許可するとアクセストークンが発行され、以降はそれで接続する。トークンはログインしたユーザーに紐づく。

ツール:

| tool           | 説明                                                              |
| -------------- | ----------------------------------------------------------------- |
| `get_cell`     | セル 1 つの raw と評価値を取得                                    |
| `get_range`    | `"A1:C10"` 形式の範囲を 2 次元配列で取得                          |
| `set_cells`    | セルの一括書き込み（`raw: ""` で削除）。開いているタブに即時反映  |
| `get_snapshot` | 全非空セルの一覧（エクスポート向き）                              |
| `list_sheets`  | 1 つのブックのシート `{id, name}` 一覧（作成順）                  |
| `add_sheet`    | シート作成（name 省略時は「シート{N}」を自動採番）                |
| `list_books`   | 自分のブックの `{id, name}` 一覧（作成順）                        |
| `add_book`     | ブック作成（「シート1」が 1 枚ついてくる。name 省略時は自動採番） |

`list_books` / `add_book` 以外のツールは optional な `book` パラメータを取る（ブック id または名前で指定、省略時は先頭のブック）。セルを扱う 4 ツールと `add_sheet` はさらに optional な `sheet` を取る（省略時はそのブックの先頭シート）。

トークンはログインしたユーザーに紐づき、**全ツールがそのユーザーのブックしか触らない**。他人のブック id を渡しても `unknown book` になる。存在しないシートへの書き込みはエラーになる（暗黙作成はしない — 先に `add_sheet`）。

行・列の挿入・削除などの構造操作ツールは未実装（第 2 段の予定）。

# Building For Production

```bash
pnpm build      # dist/client (静的アセット) と dist/server (Worker) を出す
pnpm cf-typegen # wrangler.jsonc / .dev.vars から worker-configuration.d.ts を生成（type-check の前に）
```

# Deploy

Cloudflare Workers + D1 + Durable Objects で動く。設定は `wrangler.jsonc`。

初回だけ:

1. `pnpm exec wrangler login`
2. `pnpm exec wrangler d1 create tanstack-spreadsheet` を実行し、表示された `database_id` を `wrangler.jsonc` の `d1_databases[0].database_id` に入れる
3. `wrangler.jsonc` の `vars.BETTER_AUTH_URL` を本番の URL（`https://tanstack-spreadsheet.<account>.workers.dev`）にする
4. secrets を Cloudflare に置く（値は `fnox get <KEY>` で取り出す）

```bash
pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
```

5. Google Cloud Console の承認済みリダイレクト URI に `https://<worker>/api/auth/callback/google` を追加する

毎回:

```bash
pnpm db:migrate:remote  # migrations/ に未適用のものがあれば
pnpm deploy             # build + wrangler deploy
```

Durable Object の `SyncHub` は SQLite バックエンド（無料プランで可）。WebSocket Hibernation を使うので、タブを開いたまま放置しても DO は課金されない。

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

### Removing Tailwind CSS

If you prefer not to use Tailwind CSS:

1. Remove the demo pages in `src/routes/demo/`
2. Replace the Tailwind import in `src/styles.css` with your own styles
3. Remove `tailwindcss()` from the plugins array in `vite.config.ts`
4. Remove `@tailwindcss/vite` and `tailwindcss` from `package.json`

## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `src/routes`.

### Adding A Route

To add a new route to your application just add a new file in the `./src/routes` directory.

TanStack will automatically generate the content of the route file for you.

Now that you have two routes you can use a `Link` component to navigate between them.

### Adding Links

To use SPA (Single Page Application) navigation you will need to import the `Link` component from `@tanstack/react-router`.

```tsx
import { Link } from "@tanstack/react-router";
```

Then anywhere in your JSX you can use it like so:

```tsx
<Link to="/about">About</Link>
```

This will create a link that will navigate to the `/about` route.

More information on the `Link` component can be found in the [Link documentation](https://tanstack.com/router/v1/docs/framework/react/api/router/linkComponent).

### Using A Layout

In the File Based Routing setup the layout is located in `src/routes/__root.tsx`. Anything you add to the root route will appear in all the routes. The route content will appear in the JSX where you render `{children}` in the `shellComponent`.

Here is an example layout that includes a header:

```tsx
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "My App" },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/about">About</Link>
          </nav>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  ),
});
```

More information on layouts can be found in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Server Functions

TanStack Start provides server functions that allow you to write server-side code that seamlessly integrates with your client components.

```tsx
import { createServerFn } from "@tanstack/react-start";

const getServerTime = createServerFn({
  method: "GET",
}).handler(async () => {
  return new Date().toISOString();
});

// Use in a component
function MyComponent() {
  const [time, setTime] = useState("");

  useEffect(() => {
    getServerTime().then(setTime);
  }, []);

  return <div>Server time: {time}</div>;
}
```

## API Routes

You can create API routes by using the `server` property in your route definitions:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

export const Route = createFileRoute("/api/hello")({
  server: {
    handlers: {
      GET: () => json({ message: "Hello, World!" }),
    },
  },
});
```

## Data Fetching

There are multiple ways to fetch data in your application. You can use TanStack Query to fetch data from a server. But you can also use the `loader` functionality built into TanStack Router to load the data for a route before it's rendered.

For example:

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/people")({
  loader: async () => {
    const response = await fetch("https://swapi.dev/api/people");
    return response.json();
  },
  component: PeopleComponent,
});

function PeopleComponent() {
  const data = Route.useLoaderData();
  return (
    <ul>
      {data.results.map((person) => (
        <li key={person.name}>{person.name}</li>
      ))}
    </ul>
  );
}
```

Loaders simplify your data fetching logic dramatically. Check out more information in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).

# Demo files

Files prefixed with `demo` can be safely deleted. They are there to provide a starting point for you to play around with the features you've installed.

# Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

For TanStack Start specific documentation, visit [TanStack Start](https://tanstack.com/start).
