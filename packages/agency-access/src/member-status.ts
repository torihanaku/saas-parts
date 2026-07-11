/**
 * Team member status healing (#739 fix).
 *
 * 移植元: dev-dashboard-v2 server/routes/team-members.ts の GET ハンドラ内ロジックを
 * 純関数として抽出したもの。
 *
 * SAML/OAuth 経由でログインしたメンバー (invite-accept フローを通らない) は
 * status が "invited" のまま残る。last_active が joined_at と異なる = 実際に
 * ログイン済みとみなし、"active" へ自動補正する。
 *
 * 返り値の staleIds は DB 側も self-heal するための対象 id 一覧
 * (元実装は各 id を PATCH status=active していた — 永続化は呼び出し側の責務)。
 */

export interface HealableMember {
  id?: unknown;
  status?: unknown;
  joined_at?: unknown;
  last_active?: unknown;
  [key: string]: unknown;
}

export interface HealMemberStatusesResult<T extends HealableMember> {
  /** 補正後のメンバー配列 (入力をインプレース変更したもの)。 */
  healed: T[];
  /** status を補正した行の id (DB 側 PATCH 対象)。 */
  staleIds: string[];
}

/**
 * "invited" のまま残った実アクティブメンバーの status を "active" に補正する。
 * last_active / joined_at のどちらかが欠けている行は変更しない。
 */
export function healMemberStatuses<T extends HealableMember>(
  members: T[],
): HealMemberStatusesResult<T> {
  const staleIds: string[] = [];
  for (const m of members) {
    if (
      m.status === "invited" &&
      m.last_active &&
      m.joined_at &&
      m.last_active !== m.joined_at
    ) {
      m.status = "active";
      if (m.id) staleIds.push(String(m.id));
    }
  }
  return { healed: members, staleIds };
}
