/**
 * Tenant-scoped binary asset upload to Supabase Storage.
 *
 * Uploads a binary asset (logo / favicon / hero images) to a Supabase Storage
 * bucket, scoped under the tenant_id prefix so RLS-equivalent path isolation
 * is enforced even if a tenant ever gains storage read access.
 *
 * Uses the raw Storage REST API via fetch (no supabase-js dependency),
 * mirroring the source implementation.
 *
 * Ported from dev-dashboard-v2 `server/lib/white-label/asset-upload.ts`.
 * Changes from source: Supabase URL / service key / bucket are injected via
 * `StorageUploadConfig` (no env reads); the image MIME allowlist that lived
 * in the white-label route is exported here as a reusable helper.
 */

const DEFAULT_BUCKET = "white-label-assets";

/** PNG / SVG / JPG / WebP — allowlist from the source white-label route. */
export const ALLOWED_IMAGE_MIME: ReadonlySet<string> = new Set([
  "image/png",
  "image/svg+xml",
  "image/jpeg",
  "image/webp",
]);

/** Check a content type against the PNG/SVG/JPG/WebP allowlist. */
export function isAllowedImageMime(contentType: string): boolean {
  return ALLOWED_IMAGE_MIME.has(contentType);
}

/** File extension for an allowed image MIME (source route's mapping; default "png"). */
export function extensionForImageMime(contentType: string): string {
  return contentType === "image/svg+xml" ? "svg" :
         contentType === "image/jpeg" ? "jpg" :
         contentType === "image/webp" ? "webp" : "png";
}

export interface StorageUploadConfig {
  /** Supabase project URL, e.g. "https://xxxx.supabase.co" (required). */
  supabaseUrl: string;
  /** Supabase service role key (required). Inject from your secret layer. */
  serviceKey: string;
  /** Storage bucket name (default: "white-label-assets"). */
  bucket?: string;
  /** fetch implementation override for tests (default: globalThis.fetch). */
  fetchImpl?: typeof fetch;
}

export interface UploadAssetResult {
  publicUrl: string;
  storagePath: string;
}

/**
 * Upload a binary asset under `{tenantId}/{filename}` in the configured
 * bucket (upsert), returning the storage path and public URL.
 */
export async function uploadTenantAsset(
  config: StorageUploadConfig,
  tenantId: string,
  file: Uint8Array | ArrayBuffer,
  filename: string,
  contentType: string,
): Promise<UploadAssetResult> {
  const { supabaseUrl, serviceKey } = config;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Supabase storage not configured (supabaseUrl + serviceKey required)");
  }
  const bucket = config.bucket ?? DEFAULT_BUCKET;
  const fetchImpl = config.fetchImpl ?? fetch;

  const storagePath = `${tenantId}/${filename}`;
  const objectUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${storagePath}`;

  const res = await fetchImpl(objectUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: file as BodyInit,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`asset upload failed (${res.status}): ${errText.slice(0, 200)}`);
  }

  return {
    storagePath,
    publicUrl: `${supabaseUrl}/storage/v1/object/public/${bucket}/${storagePath}`,
  };
}
