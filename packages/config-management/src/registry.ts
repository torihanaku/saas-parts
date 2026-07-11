/**
 * Centralized configuration registry.
 * Single source of truth for all environment variables with validation.
 *
 * 変更点（移植元: dev-dashboard-v2 server/lib/config-registry.ts）:
 * - 製品固有の CONFIG_REGISTRY 定数 → 呼び出し側が ConfigVar[] を渡す方式
 * - env アクセス → 注入された getValue(key) 関数（process.env 非依存）
 * - category は固定 union → 任意文字列（呼び出し側が定義）
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** 設定値の取得関数。通常は `(key) => process.env[key]` を渡す。 */
export type GetConfigValue = (key: string) => string | undefined;

export interface ConfigVar {
  key: string;
  category: string;
  required: boolean;
  description: string;
  descriptionJa: string;
  defaultValue?: string;
  sensitive: boolean;
  featureFlag?: string;
  dependsOn?: string[];
}

export interface ConfigStatus {
  key: string;
  category: string;
  configured: boolean;
  maskedValue?: string;
  required: boolean;
  featureFlag?: string;
}

export interface ConfigValidationError {
  key: string;
  message: string;
}

export interface EnvTemplateOptions {
  /** オプション変数もテンプレートに含めるか（default: true） */
  includeOptional?: boolean;
  /** テンプレート冒頭のタイトル行 */
  title?: string;
  /** カテゴリの出力順。省略時はレジストリの出現順 */
  categoryOrder?: string[];
  /** カテゴリ見出しラベル。省略時はカテゴリ名をそのまま使用 */
  categoryLabels?: Record<string, string>;
}

// ─── Example Registry ───────────────────────────────────────────────────────

/**
 * 使い方のサンプル（移植元の製品固有変数を汎用名にリネームした抜粋）。
 * 実プロダクトでは自前の ConfigVar[] を定義して各関数に渡す。
 */
export const EXAMPLE_CONFIG_REGISTRY: ConfigVar[] = [
  { key: "APP_URL", category: "core", required: true, description: "Application base URL (e.g. https://your-domain.com)", descriptionJa: "アプリケーションのベースURL", sensitive: false },
  { key: "SESSION_SECRET", category: "core", required: true, description: "Secret key for session cookie encryption (min 32 chars)", descriptionJa: "セッションCookie暗号化キー（32文字以上）", sensitive: true },
  { key: "DATABASE_URL", category: "database", required: true, description: "Primary database connection URL", descriptionJa: "データベース接続URL", sensitive: true },
  { key: "MAIL_API_KEY", category: "integration", required: false, description: "Transactional mail provider API key", descriptionJa: "メール送信APIキー", featureFlag: "email", sensitive: true },
  { key: "MAIL_FROM", category: "integration", required: false, description: "Email sender address", descriptionJa: "メール送信元アドレス", defaultValue: "noreply@example.com", sensitive: false, dependsOn: ["MAIL_API_KEY"] },
];

// ─── Functions ──────────────────────────────────────────────────────────────

/** Validate all required config vars are set. Returns list of errors. */
export function validateConfig(registry: ConfigVar[], getValue: GetConfigValue): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  for (const v of registry) {
    const value = getValue(v.key);

    if (v.required && !value && !v.defaultValue) {
      errors.push({ key: v.key, message: `Required environment variable ${v.key} is not set. ${v.description}` });
    }

    // Check dependency pairs: if dependsOn vars are set but this var is not
    if (v.dependsOn && value) {
      for (const dep of v.dependsOn) {
        const depVar = registry.find(c => c.key === dep);
        if (depVar && !getValue(dep) && !depVar.defaultValue) {
          errors.push({ key: v.key, message: `${v.key} is set but depends on ${dep} which is missing` });
        }
      }
    }
  }

  return errors;
}

/** Get config status for all vars (values masked for sensitive vars). */
export function getConfigStatus(registry: ConfigVar[], getValue: GetConfigValue): Record<string, ConfigStatus[]> {
  const result: Record<string, ConfigStatus[]> = {};

  for (const v of registry) {
    const value = getValue(v.key) || v.defaultValue || "";
    const configured = !!value;
    const maskedValue = !configured ? undefined : v.sensitive ? maskValue(value) : value;

    const bucket = result[v.category] ?? (result[v.category] = []);
    bucket.push({
      key: v.key,
      category: v.category,
      configured,
      maskedValue,
      required: v.required,
      featureFlag: v.featureFlag,
    });
  }

  return result;
}

/** Check if a specific feature flag's required vars are all configured. */
export function isConfigured(registry: ConfigVar[], getValue: GetConfigValue, featureFlag: string): boolean {
  const vars = registry.filter(v => v.featureFlag === featureFlag);
  if (vars.length === 0) return false;
  return vars.some(v => !!(getValue(v.key) || v.defaultValue));
}

/** Generate a .env template string with comments. */
export function generateEnvTemplate(registry: ConfigVar[], options: EnvTemplateOptions = {}): string {
  const includeOptional = options.includeOptional ?? true;
  const title = options.title ?? "Environment Configuration";

  const lines: string[] = [
    "# ============================================",
    `# ${title}`,
    "# ============================================",
    "# Required vars are marked with [REQUIRED]",
    "# Optional vars can be omitted to disable features",
    "",
  ];

  const categories = options.categoryOrder ?? uniqueCategories(registry);
  const categoryLabels = options.categoryLabels ?? {};

  for (const cat of categories) {
    const vars = registry.filter(v => v.category === cat);
    if (!includeOptional) {
      const required = vars.filter(v => v.required);
      if (required.length === 0) continue;
    }

    lines.push(`# --- ${categoryLabels[cat] ?? cat} ---`);
    for (const v of vars) {
      if (!includeOptional && !v.required) continue;
      const tag = v.required ? "[REQUIRED]" : "[optional]";
      lines.push(`# ${tag} ${v.description}`);
      lines.push(`# ${v.descriptionJa}`);
      if (v.featureFlag) lines.push(`# Enables feature: ${v.featureFlag}`);
      lines.push(`${v.key}=${v.defaultValue || ""}`);
      lines.push("");
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function maskValue(value: string): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

function uniqueCategories(registry: ConfigVar[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of registry) {
    if (!seen.has(v.category)) {
      seen.add(v.category);
      out.push(v.category);
    }
  }
  return out;
}
