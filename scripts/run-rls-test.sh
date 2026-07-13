#!/usr/bin/env bash
# RLS テナント分離テストの実行。
#   - CI:    PGHOST 等が設定済みの Postgres サービスに対して実行
#   - ローカル: 一時クラスタを initdb で作って実行し、後始末する
set -euo pipefail

SQL="$(cd "$(dirname "$0")/.." && pwd)/packages/sql-templates/test/rls_isolation.sql"

if [[ -n "${PGHOST:-}${DATABASE_URL:-}" ]]; then
  # CI: 既存の Postgres に接続（サービスコンテナ）
  psql -v ON_ERROR_STOP=1 -f "$SQL"
  exit $?
fi

# ローカル: 使い捨てクラスタ
PGDATA="$(mktemp -d)/pgdata"
SOCK="$(mktemp -d)"
PORT=55432
cleanup() { pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$PGDATA" "$SOCK"; }
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
pg_ctl -D "$PGDATA" -o "-p $PORT -k $SOCK -c listen_addresses=''" -w start >/dev/null
PGHOST="$SOCK" PGPORT="$PORT" PGUSER=postgres psql -v ON_ERROR_STOP=1 -d postgres -f "$SQL"
