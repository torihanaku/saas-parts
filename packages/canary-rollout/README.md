# @torihanaku/canary-rollout

## 用途

テナントIDの決定的ハッシュ（0-99バケット）による段階的ロールアウト判定。同じテナントは常に同じ判定になるため、プロセス再起動や複数インスタンス間でも状態共有なしに一貫した canary 振り分けができる。

## 主要API（コード例）

```ts
import { isTenantInRollout, type RolloutConfig } from "@torihanaku/canary-rollout";

const config: RolloutConfig = {
  percentage: 10,                      // 0〜100
  canaryTenantIds: ["tenant-vip-001"], // 明示的に先行させるテナント（省略可）
};

if (isTenantInRollout(tenantId, config)) {
  // 新実装パス
} else {
  // 旧実装パス
}
```

## 判定ロジック

1. `percentage >= 100` → 全テナント許可
2. `canaryTenantIds` に含まれる → 許可（percentage が 0 でも先行投入できる）
3. `percentage <= 0` → 拒否
4. それ以外 → tenantId の 32bit ハッシュを 0-99 に正規化し、`< percentage` なら許可

ハッシュは決定的なので、percentage を 10 → 50 → 100 と上げていくと、既に含まれていたテナントは含まれ続ける（単調拡大）。

## 特性・注意

- **純粋関数・依存ゼロ**: env 読み取りなし、I/Oなし。設定は呼び出し側が注入する
- percentage の保存場所（feature flag / DB / env）はこのパッケージの関知外。`@torihanaku/feature-flags` と組み合わせる場合は flag 値を `RolloutConfig.percentage` に写像する
- ハッシュは暗号学的ではない（分布はテストで 50%±20pt を保証する程度）。厳密な比率が必要な場合は別途設計する

## 出自

`実運用SaaS/server/services/canaryRollout.ts`（32 LOC）の純粋移植。ロジック変更なし。
