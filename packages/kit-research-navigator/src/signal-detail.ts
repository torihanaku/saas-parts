/**
 * シグナル詳細 — 単一シグナル + 紐づく context + 関連シグナルをまとめて返す。
 * フロントの「シグナルカード詳細モーダル」に必要な最小データセット。
 *
 * 出典: dev-dashboard-v2 server/lib/navigator/signal-detail.ts
 */
import type { ContextStore, SignalStore } from "./ports";
import type { Signal, SignalContext } from "./types";

export interface SignalDetailPayload {
  signal: Signal;
  context: SignalContext | null;
  related: Signal[];
}

export async function fetchSignalDetail(
  userId: string,
  signalId: string,
  deps: { signalStore: SignalStore; contextStore: ContextStore },
): Promise<SignalDetailPayload | null> {
  const signal = await deps.signalStore.getById(userId, signalId);
  if (!signal) return null;

  const context = await deps.contextStore.getBySignalId(userId, signalId);

  let related: Signal[] = [];
  if (context && context.relatedSignalIds.length > 0) {
    related = await deps.signalStore.listByIds(
      userId,
      context.relatedSignalIds,
    );
  }

  return { signal, context, related };
}
