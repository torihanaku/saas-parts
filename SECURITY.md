# セキュリティポリシー / Security Policy

## 脆弱性の報告 / Reporting a Vulnerability

セキュリティ上の問題を見つけた場合は、**公開の Issue を作らず**、GitHub の
[Security Advisories（Report a vulnerability）](https://github.com/torihanaku/saas-parts/security/advisories/new)
から非公開でご報告ください。

If you find a security issue, please **do not open a public issue**. Report it
privately via [GitHub Security Advisories](https://github.com/torihanaku/saas-parts/security/advisories/new).

- 初回応答の目安 / Target first response: **7日以内 / within 7 days**
- 再現手順・影響範囲・該当パッケージを添えていただけると助かります。

## サポート範囲 / Scope

- 本リポジトリの `packages/*` のコードが対象です。
- これらは**依存注入式の部品**であり、実運用時のセキュリティは**利用側アプリの配線**（テナントスコープ・RLS・secret 管理など）にも依存します。利用側の設定不備は本リポの対象外です。

## 継続的なセキュリティ検査 / Continuous checks

本リポジトリでは以下を CI で常時実行しています:

- 全パッケージの型チェック＋テスト（`ci.yml`）
- RLS テナント分離テスト（`rls-test.yml`）
- 秘密スキャン gitleaks・SAST Semgrep（`security-scan.yml`）
- CodeQL データフロー解析（`codeql.yml`）
- 依存脆弱性 Dependabot

設計・レビュー時のセキュリティ観点は [AGENTS.md](./AGENTS.md) のチェックリストを参照してください。
