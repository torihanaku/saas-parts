# @torihanaku/react-hooks

## 用途

SSR対応のビューポート判定・キャンセル対応fetch・a11yフォーカストラップ・フィーチャーフラグ・認証コンテキストの汎用 React フック集です。

## 主要API

### useIsMobile — モバイル判定（SSR安全）

```tsx
import { useIsMobile } from '@torihanaku/react-hooks';

const isMobile = useIsMobile();                    // 既定: (max-width: 768px)
const isNarrow = useIsMobile('(max-width: 480px)'); // ブレークポイント注入可
```

### useFetch — キャンセル・再取得つき汎用fetch

```tsx
import { useFetch } from '@torihanaku/react-hooks';

const { data, loading, error, refetch } = useFetch<User[]>('/api/users');
// url に null を渡すとフェッチをスキップ（条件付きフェッチ）
const skipped = useFetch<User[]>(ready ? '/api/users' : null);
```

### useFocusTrap — モーダル用フォーカストラップ

```tsx
import { useFocusTrap } from '@torihanaku/react-hooks';

function Modal({ open }: { open: boolean }) {
  const ref = useFocusTrap(open); // Tab/Shift+Tab を内部で循環、閉じると元の要素へ復帰
  return <div ref={ref}>…</div>;
}
```

### createFeatureFlags — フィーチャーフラグ（キャッシュつき）

```tsx
import { createFeatureFlags } from '@torihanaku/react-hooks';

const { useFeatureFlags, clearCache } = createFeatureFlags({
  defaults: { ai: true, billing: false },   // 取得前・取得失敗時の値
  endpoint: '/api/config/features',          // 既定エンドポイント（省略可）
  // fetcher: async () => myLoader(),        // 取得ロジックを丸ごと注入も可
});

function App() {
  const { flags, loading } = useFeatureFlags(); // 全コンシューマでfetchは1回
  return flags.ai ? <AiPanel /> : null;
}
```

### createAuthContext — 認証コンテキスト（ユーザー型はジェネリック）

```tsx
import { createAuthContext } from '@torihanaku/react-hooks';

interface MyUser { email: string; role: 'admin' | 'member' }
export const { AuthContext, useAuth } = createAuthContext<MyUser>();

// Provider は自前実装（Supabase/Clerk/自作セッション等どれでも）
<AuthContext.Provider value={{ status, user, error, refresh, logout, onLoginSuccess }}>
  {children}
</AuthContext.Provider>

// 消費側
const { status, user, logout } = useAuth();
```

## 依存

peerDependencies: `react >= 18`。それ以外の実行時依存なし。

## 設定ポイント（何を注入するか）

- `useIsMobile`: ブレークポイントのメディアクエリ文字列（省略可）
- `useFetch`: URL（`null` でスキップ）。認証つきAPIには `@torihanaku/api-client` を別途使う想定
- `createFeatureFlags`: `defaults`（必須）／`endpoint` または `fetcher`（元実装の `/api/config/features` 固定を分離）
- `createAuthContext<TUser>`: ユーザープロファイル型。バックエンド固有の Provider（元実装は Supabase）は各プロダクト側で実装する

## 想定ランタイム

ブラウザ（React 18+）。`useIsMobile` は SSR 環境でも安全（window 不在時は false）。テストは jsdom で実行。

## 出典

- `dev-dashboard-v2/src/hooks/useIsMobile.ts`
- `dev-dashboard-v2/src/hooks/useFetch.ts`
- `dev-dashboard-v2/src/hooks/useFocusTrap.ts`
- `dev-dashboard-v2/src/hooks/useFeatureFlags.ts`（フラグ一覧・URL固定を分離）
- `dev-dashboard-v2/src/contexts/AuthContext.ts`（UserProfile をジェネリック化。Supabase 依存の AuthProvider.tsx は未移植）
