/**
 * 環境変数の一元管理と起動時 Zod 検証（Fail-Fast ハーネス）。
 *
 * Ported from dev-dashboard-v2 `server/lib/env.ts`. The product's ~40 flag
 * definitions are NOT included — this package extracts the reusable harness:
 *
 * - Fail-fast validation at startup: on failure the aggregated issue list is
 *   logged (`console.error`) and the process exits with code 1, exactly like
 *   the source's `parseEnv()`. Pass `onFail: "throw"` to get an
 *   `EnvValidationError` instead (useful for tests / non-process runtimes).
 * - Required vs optional split: `defineEnv({ required, optional })` merges the
 *   two objects the same way the source merged `RequiredEnv.merge(OptionalEnv)`.
 * - Cloud Run quirk: unset env vars can arrive as "" (empty string).
 *   `optionalUrl` / `emptyToUndefined` normalise "" → undefined before
 *   validation (ported preprocess).
 * - Type-safe access: the returned object is fully inferred from the schema.
 *
 * Usage:
 *   const env = defineEnv({
 *     required: z.object({ DATABASE_URL: z.string().url() }),
 *     optional: z.object({ APP_URL: optionalUrl }),
 *   });
 *   env.DATABASE_URL // string
 */

import { z } from "zod";

// ─── Normalization helpers ───────────────────────────────────────────────────

/**
 * Cloud Run では未設定の env var が "" (空文字列) として渡されることがある。
 * "" を undefined に変換してから検証する preprocess ラッパー。
 */
export function emptyToUndefined<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (v === "" ? undefined : v), schema);
}

/**
 * オプションの URL。"" は undefined に正規化される（元 `optionalUrl`）。
 * `z.string().url().optional()` は "" を invalid URL と判定して失敗するため、
 * 先に "" → undefined 変換を挟む。
 */
export const optionalUrl = emptyToUndefined(z.string().url().optional());

/** 数字のみの文字列（PORT / 日数など。元: `z.string().regex(/^\d+$/)`）。 */
export const numericString = z.string().regex(/^\d+$/);

// ─── Error type ──────────────────────────────────────────────────────────────

export interface EnvIssue {
  path: string;
  message: string;
}

export class EnvValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: EnvIssue[],
  ) {
    super(message);
    this.name = "EnvValidationError";
  }
}

// ─── defineEnv ───────────────────────────────────────────────────────────────

export interface DefineEnvOptions {
  /** 検証対象。デフォルト: process.env */
  source?: Record<string, string | undefined>;
  /**
   * 失敗時の挙動。"exit"（デフォルト・元コード同様 console.error + process.exit(1)）
   * または "throw"（EnvValidationError を投げる）。
   */
  onFail?: "exit" | "throw";
  /** 失敗メッセージの出力先。デフォルト: console.error */
  logger?: (message: string) => void;
  /** exit 実装（テスト用に注入可能）。デフォルト: process.exit */
  exit?: (code: number) => void;
}

type AnyZodObject = z.ZodObject<z.ZodRawShape>;

export interface SplitEnvSchema<
  R extends z.ZodRawShape,
  O extends z.ZodRawShape,
> {
  /** 必須変数（欠落時は起動失敗） */
  required: z.ZodObject<R>;
  /** オプション変数（未設定でも起動可） */
  optional?: z.ZodObject<O>;
}

export function defineEnv<R extends z.ZodRawShape, O extends z.ZodRawShape>(
  schema: { required: z.ZodObject<R>; optional: z.ZodObject<O> },
  options?: DefineEnvOptions,
): z.output<z.ZodObject<R>> & z.output<z.ZodObject<O>>;
export function defineEnv<R extends z.ZodRawShape>(
  schema: { required: z.ZodObject<R> },
  options?: DefineEnvOptions,
): z.output<z.ZodObject<R>>;
export function defineEnv<S extends AnyZodObject>(
  schema: S,
  options?: DefineEnvOptions,
): z.output<S>;
export function defineEnv(
  schema: AnyZodObject | SplitEnvSchema<z.ZodRawShape, z.ZodRawShape>,
  options: DefineEnvOptions = {},
): unknown {
  const {
    source = process.env,
    onFail = "exit",
    logger = console.error,
    exit = (code: number) => process.exit(code),
  } = options;

  // 元コードの `RequiredEnv.merge(OptionalEnv)` 相当。
  const merged: AnyZodObject =
    schema instanceof z.ZodObject
      ? schema
      : schema.optional
        ? z.object({ ...schema.required.shape, ...schema.optional.shape })
        : schema.required;

  const result = merged.safeParse(source);
  if (!result.success) {
    // 元 parseEnv() のエラー集約フォーマットをそのまま移植。
    const issues = result.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`);
    const message = `\n[env] 環境変数の検証に失敗しました。起動を中止します。\n${issues.join("\n")}\n`;
    const structured: EnvIssue[] = result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));

    if (onFail === "throw") {
      throw new EnvValidationError(message, structured);
    }
    logger(message);
    exit(1);
    // 注入された exit が process を終了しない場合でも、不正な env を
    // 呼び出し側に返さないための保険。
    throw new EnvValidationError(message, structured);
  }
  return result.data;
}

/**
 * スキーマ外のキーを読む escape hatch（元 `getOptionalEnv`）。
 * 原則 defineEnv のスキーマに追加すること。
 */
export function getOptionalEnv(
  key: string,
  source: Record<string, string | undefined> = process.env,
): string | undefined {
  return source[key];
}
