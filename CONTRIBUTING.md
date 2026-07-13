# Contributing

## 開発

```bash
bun install
bun run test        # 全パッケージのテスト（vitest）
bun run typecheck   # 型チェック
```

## 部品追加のルール（要点）

1. **自己完結**: 他の `@torihanaku/*` を import しない。共有が必要なら最小インターフェースをローカル定義する
2. **依存注入**: `process.env` を直読みしない。secret の値をコード/テスト/README に書かない（キー名は可）。DB/Redis/LLM 等は最小インターフェースで注入する
3. **構成**: `package.json`（`@torihanaku/<name>`, `type:module`, `exports→src/index.ts`）/ `tsconfig.json` / `src/index.ts` / `src/*.test.ts` / `README.md`
4. **検証**: `bunx tsc --noEmit -p packages/<name>/tsconfig.json` と `bunx vitest run packages/<name>` が通ること

詳細と、認証・課金・テナント分離・削除・入力検証に触るときの **セキュリティ・チェックリスト** は [AGENTS.md](./AGENTS.md) を参照してください。

## PR

- `main` をベースにブランチを切る（例: `fix/...`, `chore/...`）
- CI（型チェック・全テスト・RLS分離テスト・秘密スキャン・SAST・CodeQL）が緑になること
- 変更に対応するテストを添える（バグ修正なら回帰テスト）

## ライセンス

コントリビューションは [MIT License](./LICENSE) の下で受け入れられます。
