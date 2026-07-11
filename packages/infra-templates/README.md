# @torihanaku/infra-templates

## 用途

Bun + Cloud Run 構成の SaaS 向けインフラ雛形集です。コンパイル対象のコードではなく、**新規プロジェクトにコピーして `{{PLACEHOLDER}}` を置換して使うテンプレートファイル**を `templates/` 以下に元リポジトリと同じ相対構造で収録しています（tsc / vitest の対象外）。

出典: `dev-dashboard-v2`（Dockerfile / scripts / .github/workflows/ci.yml / .husky/pre-push / .devcontainer / .pre-commit-config.yaml / .prettierrc.json）。秘密情報は含みません（元ファイルも Secret Manager / GitHub Secrets 参照のみで、値の直書きなしを確認済み）。

## 収録ファイル一覧

```
templates/
├── Dockerfile
├── scripts/
│   ├── docker-smoke-test.sh
│   ├── check-phantom-imports.sh
│   ├── check-dockerfile-coverage.sh
│   └── check-named-exports.sh
├── .github/workflows/ci.yml
├── .husky/pre-push
├── .devcontainer/devcontainer.json   # Bun + Node 22 の VS Code / Codespaces devcontainer
├── .pre-commit-config.yaml           # gitleaks の pre-commit フック
└── .prettierrc.json                  # Prettier 設定（semi / singleQuote / printWidth 100 等）
```

---

### templates/Dockerfile

マルチステージの Bun ビルド。builder ステージで `bun install` + `bun run build`（CI が dist/ を注入済みならスキップ）、final ステージは dist / node_modules / サーバーコードのみ COPY。非 root ユーザー（uid 1001）で実行し、bun 内蔵 fetch で HEALTHCHECK します（bun:slim には curl が無いため）。

| プレースホルダ | 意味 | 例 |
|---|---|---|
| `{{BUN_IMAGE}}` | ベースイメージ（digest 固定推奨） | `oven/bun:1.3.13-slim@sha256:…` |
| `{{SERVER_ENTRYPOINT}}` | 本番サーバーの起動ファイル | `server-prod.ts` |
| `{{SERVER_DIR}}` | サーバーコードのディレクトリ | `server` |
| `{{HEALTHCHECK_PATH}}` | ヘルスチェックのパス | `/health` |

**適用時の注意**: サーバーが相対 import する全ディレクトリ（`shared/` 等）の COPY 行を追加すること。漏れると Cloud Run 起動時に `Cannot find module` でクラッシュします（下記 check-dockerfile-coverage.sh が検出）。

---

### templates/scripts/docker-smoke-test.sh

ビルド直後のイメージをローカル（CI ランナー）で起動し、120 秒以内に起動完了ログが出るかを確認します。COPY 漏れ・import 切れを「イメージ push → Cloud Run 起動失敗（5分超）」の前に約30秒で検出するためのものです。使い方: `bash scripts/docker-smoke-test.sh <IMAGE>`。

| プレースホルダ | 意味 |
|---|---|
| `{{READY_LOG_PATTERN}}` | 起動完了ログの grep パターン（例: `server running on port`） |
| `{{STUB_ENV_1}}`, `{{STUB_ENV_2}}` … | 起動時バリデーションを満たすスタブ env（`KEY=fake-value` 形式）。必要な数だけ `-e` 行を増減。**実クレデンシャル禁止** |

---

### templates/scripts/check-phantom-imports.sh

diff に追加された相対 import の参照先ファイルが実在するかを検証します（rebase / merge 事故で「import だけ残ってファイルが無い」状態を検出）。**プレースホルダなし・そのまま使用可**。pre-push と CI の両方から呼ぶことで `--no-verify` をすり抜けさせない設計です。使い方: `bash scripts/check-phantom-imports.sh [MERGE_BASE] [HEAD_REF]`。

---

### templates/scripts/check-dockerfile-coverage.sh

Dockerfile final stage の COPY 命令を解析し、サーバー側 TS ファイルの相対 import がすべてイメージ内に含まれるかを静的検証します（type-only import は除外）。

| プレースホルダ | 意味 |
|---|---|
| `{{SERVER_ENTRYPOINT}}`, `{{SERVER_DIR}}` | 検査起点（Dockerfile に COPY されるサーバー側エントリポイント/ディレクトリ）。ヒアドキュメント内 Python の `SCAN_ROOTS` に設定 |

---

### templates/scripts/check-named-exports.sh

サーバーエントリポイントをスタブ env で最大4秒だけ実行し、「ファイルは存在するが named export が無い」クラスのバグ（phantom-import 検査では捕まらない）を起動ログの `Export named X not found` / `Cannot find module` で検出します。env バリデーション起因のクラッシュは合格扱いです。

| プレースホルダ | 意味 |
|---|---|
| `{{SERVER_ENTRYPOINT}}` | 実行するサーバーファイル |
| `{{READY_LOG_PATTERN}}` | 起動完了ログの grep パターン |
| `{{STUB_ENV_1}}`, `{{STUB_ENV_2}}` … | スタブ env（`KEY=stub` の行を必要数並べる。**実クレデンシャル禁止**） |

---

### templates/.github/workflows/ci.yml

lint → build → test → コンテナビルド + ローカルスモーク → ステージング Cloud Run デプロイ →（workflow_dispatch 時のみ）本番デプロイ、のパイプライン。認証は **Workload Identity Federation**（キー JSON 不使用、`id-token: write` 権限）。本番デプロイはスモーク失敗時に直前リビジョンへ自動ロールバックし、成功時は `cloud-run-deployed` タグを更新します。

| プレースホルダ | 意味 |
|---|---|
| `{{BUN_VERSION}}` | Bun のバージョン（例: `1.3.8`） |
| `{{GCP_PROJECT_ID}}` | GCP プロジェクトID |
| `{{GCP_REGION}}` | リージョン（例: `asia-northeast1`） |
| `{{GAR_REPOSITORY}}` / `{{IMAGE_NAME}}` | Artifact Registry リポジトリ名 / イメージ名 |
| `{{SERVICE_NAME}}` / `{{SERVICE_NAME_STAGING}}` | Cloud Run サービス名（本番 / ステージング） |
| `{{STAGING_URL}}` | ステージング公開URL（スモークテスト先） |
| `{{HEALTHCHECK_PATH}}` | ヘルスチェックパス（例: `/health`） |
| `{{STAGING_ENV_VARS}}` / `{{PROD_ENV_VARS}}` | `--update-env-vars` に渡すカンマ区切り `KEY=VALUE` 列 |
| `{{STAGING_SECRETS}}` / `{{PROD_SECRETS}}` | `--set-secrets` に渡す `ENV=SecretManager名:latest` 列 |
| `{{VPC_CONNECTOR}}` | VPC コネクタ名（不要なら `--vpc-*` 2行を削除） |

**GitHub Secrets の準備**: `WIF_PROVIDER`（`projects/<番号>/locations/global/workloadIdentityPools/...` 形式）と `WIF_SERVICE_ACCOUNT` をリポジトリ Secrets に設定。env / secret の実値はワークフローに直書きせず、GitHub Secrets か Secret Manager 参照にすること。

---

### templates/.husky/pre-push

push 前ゲート: ①build ②phantom-import 検査 ③Dockerfile COPY coverage 検査 ④named-export 検査 ⑤テスト（コード変更がある場合は coverage 90% 閾値つき、main は素のテスト）⑥PR の AI レビューコメント確認（返信なし解決を検出、未対応コメントは自動修正スクリプトを起動）。②〜④は CI と同じスクリプトを呼ぶため `--no-verify` でもCI側で捕捉されます。

| プレースホルダ | 意味 |
|---|---|
| `{{GITHUB_OWNER}}` / `{{GITHUB_REPO_NAME}}` | GraphQL でレビュースレッドを引くリポジトリ |
| `{{AI_REVIEW_FIX_SCRIPT}}` | AIレビュー自動修正スクリプトのパス。運用しない場合は「AI レビューコメント確認」ブロック（`PR_NUMBER=` 以降）を丸ごと削除可 |

前提: `bun run build` / `test` / `test:coverage` スクリプトと `gh` CLI・`python3`。

---

### templates/.devcontainer/devcontainer.json

VS Code / GitHub Codespaces 用の開発コンテナ定義。ベースは `javascript-node:22` に GitHub CLI と Bun の features を足した構成。推奨拡張（Biome / ESLint / Tailwind / Prettier / TypeScript next / Vitest）・保存時フォーマット・フロント/API 用のポートフォワード（5173 / 3333）・`postCreateCommand` に `bun install` を設定済みです。

| プレースホルダ | 意味 | 例 |
|---|---|---|
| `{{PROJECT_NAME}}` | devcontainer の表示名 | `my-saas` |
| `{{BUN_VERSION}}` | 導入する Bun のバージョン | `1.3.8` |
| `{{SERVER_ENTRYPOINT}}` | 起動ヒントに出す本番サーバーファイル | `server-prod.ts` |

**適用時の注意**: `forwardPorts` / `portsAttributes` は Vite(5173) + API(3333) 前提。自プロジェクトのポート構成に合わせて書き換えてください。

---

### templates/.pre-commit-config.yaml

`pre-commit` フレームワーク用の設定。commit 時にローカルで gitleaks（v8.22.1 固定）を走らせ、secret の混入を push 前に止めます。CI 側の security-check（ops-playbooks 収録）と対で使うと二重防御になります。**プレースホルダなし・そのまま使用可**。導入は `pip install pre-commit && pre-commit install`。gitleaks の `rev` は必要に応じて更新。

---

### templates/.prettierrc.json

Prettier のフォーマット設定（`semi: true` / `singleQuote: true` / `tabWidth: 2` / `trailingComma: all` / `printWidth: 100`）。devcontainer の `editor.defaultFormatter` とも整合します。**プレースホルダなし**。チームの規約に合わせて数値を調整可。

---

## 新規プロジェクトへの適用手順

1. `templates/` の中身をプロジェクトルートへ相対構造のままコピー
2. `grep -rn '{{' .` で全プレースホルダを洗い出し、上記の表に従って置換
3. Dockerfile の COPY 行と smoke/named-exports 用スタブ env をプロジェクトの構成に合わせて増減
4. GitHub Secrets（WIF_PROVIDER / WIF_SERVICE_ACCOUNT ほか）と Secret Manager を設定
5. `bash -n scripts/*.sh` で構文確認 → PR を1本作って CI が通ることを確認

注意: `docker inspect -f '{{.State.Running}}'` など Go テンプレートの `{{...}}` はプレースホルダではないので置換しないこと。
