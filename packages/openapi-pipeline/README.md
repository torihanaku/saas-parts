# @torihanaku/openapi-pipeline

## 用途

クライアント（React）とサーバー（Hono / Node）で **API の型と契約を 1 か所に集約して共有する仕組み**の雛形集です。`shared/` を単一ソースにして、コンパイル対象のコードではなく、**新規プロジェクトのリポジトリ直下にコピーして相対構造のまま使うテンプレート**を `templates/shared/` に収録しています（`src/` を持たないため saas-parts の tsc / vitest の対象外）。

出典: `dev-dashboard-v2/shared/`。秘密情報・実プロジェクト ID は含みません（型定義・スキーマ・OpenAPI 契約のみ）。

## この「型共有パイプライン」の仕組み（3 層）

このリポでは自動コード生成ツールに依存せず、**3 種類の成果物を `shared/` に置き、クライアントとサーバーが同じ相対パスから import する**ことで型のズレを防いでいます。ビルド時の `tsc --noEmit`（`bun run build` が client/server 両 tsconfig で実行）が、3 層のどこかがズレた瞬間にコンパイルエラーで検知するのが肝です。

```
                 ┌─────────────────────────────┐
                 │  shared/  （単一ソース）      │
                 ├─────────────────────────────┤
  ① 契約         │ openapi/*.yaml              │  ← 人間・外部向けの API 契約ドキュメント
  （ドキュメント） │   OpenAPI 3.1 でエンドポイント │     （リクエスト/レスポンス/エラー/認証方式）
                 ├─────────────────────────────┤
  ② 実行時検証   │ schemas/*.ts （Zod）         │  ← サーバーが受信ボディを parse して検証
                 │                             │     クライアントも同じ enum/制約を再利用
                 ├─────────────────────────────┤
  ③ 型           │ types/*.ts （interface）     │  ← client / server 双方が import する
                 │                             │     コンパイル時の型（実行時コストゼロ）
                 └─────────────────────────────┘
        server/ が ①②③ を import        src/ が ①(参照)②③ を import
```

- **① `openapi/user.yaml`** — API の「契約」を OpenAPI 3.1 で明文化。実装から自動生成したものではなく、**人間・フロント担当・外部連携先が読む正**として手で維持します。エンドポイント / 認証（セッション Cookie）/ エラーレスポンス（Unauthorized・Forbidden・BadRequest）まで定義。
- **② `schemas/navigator.ts`（Zod）** — リクエストボディの**実行時バリデーション**の単一ソース。サーバーのルートで `Schema.parse(body)` して弾き、フロントも同じ enum（`status` の取りうる値など）を import することで、値集合の二重定義を防ぎます。
- **③ `types/navigator.ts` / `types/user.ts`（interface）** — DB 行・API レスポンスの**コンパイル時の型**。`server/lib/*` と `src/pages/*` が同一ファイルを import するため、片方だけ型を変えると即コンパイルエラーになります。

### なぜ「生成スクリプト」が入っていないか

このリポの型共有は **codegen ツール（openapi-typescript 等）ではなく「単一ソースを両側から import する規律」で実現**されています。よって同梱すべき生成スクリプトは存在せず、パイプラインの本体は「`shared/` の配置ルール」＋「client/server 両方の `tsc --noEmit` を CI/pre-push で必須にすること」です（インフラ側の CI 雛形は `@torihanaku/infra-templates` を参照）。openapi-typescript による型自動生成を足したい場合の手順は下記「拡張」に記載します。

## 収録ファイル一覧

```
templates/shared/
├── openapi/
│   └── user.yaml            # OpenAPI 3.1 契約（/user/me, /user/plan, /user/usage, /plans）
├── schemas/
│   └── navigator.ts         # Zod スキーマ（リクエスト検証 + enum の単一ソース）
└── types/
    ├── user.ts              # user.yaml と対を成す共有 interface（plan / limits / config）
    ├── navigator.ts         # ドメイン型（UseCaseCard / Stack / Signal 等）
    └── navigator-signals.ts # navigator.ts が re-export する派生型（同梱で自己完結）
```

`navigator` と `user` の 2 ドメインを、①契約・②Zod・③型 がどう対応するかの**実例セット**として収録しています。

## 新規プロジェクトへの適用手順

1. `templates/shared/` をリポジトリ直下へ相対構造のままコピー
2. `navigator` / `user` の中身を自プロダクトのドメインに置換（`openapi/` を 1 API 1 yaml、`schemas/` を 1 ドメイン 1 ファイルで増やす運用）
3. サーバー側ルートで `import { XxxRequestSchema } from "../../shared/schemas/xxx"` → `Schema.parse(body)` で検証
4. クライアント・サーバー両方から `shared/types/*` を型 import（`import type`）
5. **client / server 両方の `tsc --noEmit` を CI と pre-push の必須ゲートにする**（これがズレ検知の実体。`@torihanaku/infra-templates` の ci.yml / pre-push が対応）
6. `openapi/*.yaml` は実装変更のたびに手で更新（Spectral 等の lint を CI に足すと劣化を防げる）

### 拡張: OpenAPI から型を自動生成したい場合

`shared/types/*` を手書きせず `openapi/*.yaml` から生成する構成にもできます。`openapi-typescript` を devDependency に入れ、`"gen:api": "openapi-typescript shared/openapi/user.yaml -o shared/types/user.gen.ts"` のような script を足し、生成物を CI で `git diff --exit-code` して「yaml と型のズレ」を検知します。その場合 ①→③ が機械生成になり、②（Zod）は実行時検証として引き続き手書きで併存させます（OpenAPI は実行時に値を弾けないため）。

## 依存 / 想定ランタイム

`schemas/*.ts` は `zod`（v4 系）に依存します。`types/*.ts` は依存なしの純粋な型。`openapi/*.yaml` はドキュメントで実行時依存なし。TypeScript 5+/6 系を想定。

## 出典

`dev-dashboard-v2/shared/`（openapi 1 / schemas 1 / types 3 ファイル）。
