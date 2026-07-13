# @torihanaku/saml-sp

## 用途

SAML 2.0 Service Provider（SP）の薄いラッパー — アサーション検証・エラー正規化・SPメタデータXML生成・NameID/属性抽出を、DB非依存の注入型APIで提供する。

## 主要API

```ts
import {
  buildLoginRedirectUrl,   // SP-initiated ログインのリダイレクトURLを生成
  validateSamlResponse,    // HTTP-POST の SAMLResponse を検証 → SamlAssertion に正規化
  buildSpMetadataXml,      // IdP に渡す SP メタデータ XML を生成
  loadSamlConfig,          // 注入ストアから有効な SAML 設定を解決
  clearSamlInstanceCache,  // 設定更新後にキャッシュを破棄
  SamlValidationError,     // 安定エラーコード付き例外（invalid_signature / expired_assertion 等）
  type IdpConfig,
  type IdpConfigStore,
  type SamlAssertion,
} from "@torihanaku/saml-sp";

// 1. 設定は呼び出し側が注入する（DB行・KV・設定ファイル等、何でもよい）
const config: IdpConfig = {
  id: "okta-prod",
  provider_name: "Okta Production",
  protocol: "saml",
  enabled: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  attribute_mapping: { email: "email" },
  idp_entity_id: "https://idp.example.com/saml",
  idp_sso_url: "https://idp.example.com/saml/sso",
  idp_x509_cert: "-----BEGIN CERTIFICATE-----\nMIIC...FAKE...\n-----END CERTIFICATE-----",
  sp_entity_id: "https://app.example.com/sso/saml/okta-prod",   // SP entityID（Audience にも使用）
  sp_acs_url: "https://app.example.com/auth/saml/acs/okta-prod", // ACS URL
};

// 2. ログイン開始（IdP へリダイレクト）
const url = await buildLoginRedirectUrl(config, "/dashboard", req.headers.get("host") ?? "");

// 3. ACS エンドポイントで SAMLResponse を検証
const assertion = await validateSamlResponse(config, samlResponseBase64);
// assertion.nameId / assertion.attributes.email / assertion.sessionIndex ...

// 4. メタデータエンドポイント（IdP 側に登録してもらう XML）
const xml = buildSpMetadataXml(config, defaultEntityId, defaultAcsUrl);
// Content-Type: application/samlmetadata+xml; charset=utf-8 で返す

// 5. 設定の読み出しをストア注入で行う場合
const store: IdpConfigStore = {
  get: async (tenantId) => db.findIdpConfig(tenantId), // 実装は自由
};
const resolved = await loadSamlConfig(store, "tenant-1"); // saml かつ enabled のみ返す
```

`validateSamlResponse` の失敗は `SamlValidationError` に正規化される。`code` は
`missing_saml_response | invalid_signature | expired_assertion | audience_mismatch | issuer_mismatch | missing_name_id | missing_email | logged_out | unknown` の安定コード。

## 依存

- peerDependencies: `@node-saml/node-saml` `^5.0.0`（呼び出し側でインストール）

## 設定ポイント（何を注入するか）

すべて呼び出し側が `IdpConfig` として注入する。ライブラリ内で `process.env` は一切読まない。

| 注入項目 | フィールド | 説明 |
|---|---|---|
| ACS URL | `sp_acs_url` | 自アプリの Assertion Consumer Service URL（例: 環境変数 `SAML_SP_ACS_URL` から呼び出し側が渡す） |
| SP entityID | `sp_entity_id` | 自アプリの EntityID。Audience 検証にも使用（例: `SAML_SP_ENTITY_ID`） |
| IdP 証明書 | `idp_x509_cert` | IdP の署名検証用 X.509 証明書（PEM / base64 本体） |
| IdP SSO URL | `idp_sso_url` | ログインリダイレクト先 |
| IdP entityID | `idp_entity_id` | IdP の Issuer 検証に使用（任意） |
| 設定ストア | `IdpConfigStore` | 元実装の Supabase 永続化を置き換える注入インターフェース。`get(tenantId)` 必須・`save` 任意 |

固定の検証ポリシー（元実装を踏襲）: `wantAssertionsSigned` は既定 true、`validateInResponseTo: "never"`、クロックスキュー許容 30 秒。

## 想定ランタイム

node（Bun でも動作。`@node-saml/node-saml` が Node の crypto/XML 実装に依存するためブラウザ不可）

## 出典

- `実運用SaaS/server/lib/saml-sp.ts`（本体）
- `実運用SaaS/server/routes/auth/saml-helpers.ts`（`buildSpMetadataXml` のみ移植）
- `実運用SaaS/shared/types/sso.ts`（`SamlAssertion` 型）
- テスト: `実運用SaaS/tests/saml-sp.test.ts`, `tests/saml-routes.test.ts`（buildSpMetadataXml の3ケースのみ）
