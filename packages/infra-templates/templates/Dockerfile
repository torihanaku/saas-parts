# Multi-stage Bun build for Cloud Run.
# Template placeholders:
#   {{BUN_IMAGE}}         — 例: oven/bun:1.3.13-slim@sha256:<digest>（digest 固定推奨）
#   {{SERVER_ENTRYPOINT}} — 例: server-prod.ts
#   {{SERVER_DIR}}        — 例: server
#   {{HEALTHCHECK_PATH}}  — 例: /health

FROM {{BUN_IMAGE}} AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# CI が lint-and-build で生成した dist/ を COPY . . 経由で注入した場合はスキップ
RUN [ -f dist/index.html ] || bun run build

FROM {{BUN_IMAGE}}
WORKDIR /app
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY package.json .
COPY {{SERVER_ENTRYPOINT}} .
COPY {{SERVER_DIR}}/ {{SERVER_DIR}}/
# ⚠ サーバー側コードが相対 import する全ディレクトリをここに列挙すること。
#   COPY 漏れは Cloud Run 起動時の "Cannot find module" クラッシュになる
#   （scripts/check-dockerfile-coverage.sh が静的検証する）。
# 例:
#   COPY shared/ shared/
#   COPY src/utils/ src/utils/

# Create non-root user (support both Debian and Alpine)
RUN (groupadd --system --gid 1001 appgroup 2>/dev/null || addgroup --system --gid 1001 appgroup) && \
    (useradd --system --uid 1001 --gid appgroup --no-create-home appuser 2>/dev/null || adduser --system --uid 1001 --ingroup appgroup --no-create-home appuser) && \
    chown -R appuser:appgroup /app
USER appuser

EXPOSE 8080
# NOTE: bun:slim doesn't include curl/wget, so use bun's built-in fetch via eval
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const r=await fetch('http://localhost:8080{{HEALTHCHECK_PATH}}');process.exit(r.ok?0:1)" || exit 1
CMD ["bun", "run", "{{SERVER_ENTRYPOINT}}"]
