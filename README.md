Welcome to your new TanStack Start app!

# Getting Started

To run this application:

```bash
pnpm install
pnpm dev
```

# Storage & MCP

## データの保存先

スプレッドシートのデータ（シート・セル・列幅）の SSoT は dev server 内の SQLite（libsql）で、既定では `data/spreadsheet.db`（gitignore 済み）に保存される。ブラウザ側の collection はカスタム sync によるミラー（シートごとに 1 collection）で、タブ間同期は SSE（`/api/stream`）経由。**アプリの利用には dev server（`pnpm dev`）または preview server が必要。**

複数シートに対応しており、画面下部のタブバーから作成・切替・リネーム・削除できる。シート一覧はサーバーの `sheets` テーブルが正本で、既存の単一シート DB は初回起動時に「シート1」として引き継がれる。ソート・フィルタ・undo 履歴・アクティブシートはタブローカル（シート別）。

- `LIBSQL_URL` / `LIBSQL_AUTH_TOKEN` を設定すると Turso など外部の libsql に切替できる。ただし変更通知は同一プロセス内の書き込みしか拾わないため、外部から直接 DB に書いた変更をブラウザへ即時反映するにはポーリング等の追加実装が必要（将来課題）
- 旧 localStorage 形式のデータは、サーバー DB が空のとき初回ページ表示時に一度だけ自動インポートされる（localStorage 側は消さない）

## MCP サーバー

dev server が `http://localhost:3210/mcp` に MCP エンドポイント（streamable HTTP）をホストする。Claude Code からの登録:

```bash
claude mcp add --transport http tanstack-spreadsheet http://localhost:3210/mcp
```

ツール:

| tool           | 説明                                                             |
| -------------- | ---------------------------------------------------------------- |
| `get_cell`     | セル 1 つの raw と評価値を取得                                   |
| `get_range`    | `"A1:C10"` 形式の範囲を 2 次元配列で取得                         |
| `set_cells`    | セルの一括書き込み（`raw: ""` で削除）。開いているタブに即時反映 |
| `get_snapshot` | 全非空セルの一覧（エクスポート向き）                             |
| `list_sheets`  | 全シートの `{id, name}` 一覧（作成順）                           |
| `add_sheet`    | シート作成（name 省略時は「シート{N}」を自動採番）               |

セルを扱う 4 ツールは optional な `sheet` パラメータを取る（シート id または名前で指定、省略時は先頭のシート）。存在しないシートへの書き込みはエラーになる（暗黙作成はしない — 先に `add_sheet`）。

行・列の挿入・削除などの構造操作ツールは未実装（第 2 段の予定）。

# Building For Production

To build this application for production:

```bash
pnpm build
```

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
