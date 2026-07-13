import { describe, it, expect, vi } from "vitest";
import {
  uploadTenantAsset,
  isAllowedImageMime,
  extensionForImageMime,
  ALLOWED_IMAGE_MIME,
  assertSafePathSegment,
  type StorageUploadConfig,
} from "./index";

const config = (fetchImpl: typeof fetch, extra?: Partial<StorageUploadConfig>): StorageUploadConfig => ({
  supabaseUrl: "https://proj.supabase.co",
  serviceKey: "test-key",
  fetchImpl,
  ...extra,
});

describe("MIME allowlist", () => {
  it("allows PNG / SVG / JPG / WebP only", () => {
    expect(isAllowedImageMime("image/png")).toBe(true);
    expect(isAllowedImageMime("image/svg+xml")).toBe(true);
    expect(isAllowedImageMime("image/jpeg")).toBe(true);
    expect(isAllowedImageMime("image/webp")).toBe(true);
    expect(isAllowedImageMime("image/gif")).toBe(false);
    expect(isAllowedImageMime("application/pdf")).toBe(false);
    expect(ALLOWED_IMAGE_MIME.size).toBe(4);
  });

  it("maps MIME to extension (default png)", () => {
    expect(extensionForImageMime("image/svg+xml")).toBe("svg");
    expect(extensionForImageMime("image/jpeg")).toBe("jpg");
    expect(extensionForImageMime("image/webp")).toBe("webp");
    expect(extensionForImageMime("image/png")).toBe("png");
  });
});

describe("assertSafePathSegment", () => {
  it("accepts a plain single segment", () => {
    expect(() => assertSafePathSegment("filename", "logo.png")).not.toThrow();
    expect(() => assertSafePathSegment("tenantId", "tenant-123")).not.toThrow();
  });

  it("rejects empty, traversal, separators and control bytes", () => {
    expect(() => assertSafePathSegment("filename", "")).toThrow(/non-empty/);
    expect(() => assertSafePathSegment("filename", "..")).toThrow(/path traversal/);
    expect(() => assertSafePathSegment("filename", ".")).toThrow(/path traversal/);
    expect(() => assertSafePathSegment("filename", "a/b")).toThrow(/path separators/);
    expect(() => assertSafePathSegment("filename", "a\\b")).toThrow(/path separators/);
    expect(() => assertSafePathSegment("filename", "a\tb")).toThrow(/control characters/);
    expect(() => assertSafePathSegment("filename", "a\u0000b")).toThrow(/control characters/);
  });
});

describe("uploadTenantAsset", () => {
  it("POSTs to tenant-scoped path with auth/upsert headers and returns public URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const result = await uploadTenantAsset(
      config(fetchMock as unknown as typeof fetch),
      "tenant-123",
      bytes,
      "logo.png",
      "image/png",
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://proj.supabase.co/storage/v1/object/white-label-assets/tenant-123/logo.png",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    expect(init.headers.apikey).toBe("test-key");
    expect(init.headers["Content-Type"]).toBe("image/png");
    expect(init.headers["x-upsert"]).toBe("true");
    expect(init.body).toBe(bytes);

    expect(result).toEqual({
      storagePath: "tenant-123/logo.png",
      publicUrl:
        "https://proj.supabase.co/storage/v1/object/public/white-label-assets/tenant-123/logo.png",
    });
  });

  it("respects a custom bucket", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await uploadTenantAsset(
      config(fetchMock as unknown as typeof fetch, { bucket: "avatars" }),
      "t1",
      new Uint8Array([1]),
      "a.webp",
      "image/webp",
    );

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://proj.supabase.co/storage/v1/object/avatars/t1/a.webp",
    );
    expect(result.publicUrl).toBe(
      "https://proj.supabase.co/storage/v1/object/public/avatars/t1/a.webp",
    );
  });

  it("rejects a filename that escapes the tenant prefix (path traversal)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(
      uploadTenantAsset(
        config(fetchMock as unknown as typeof fetch),
        "tenant-A",
        new Uint8Array([1]),
        "../tenant-B/logo.png",
        "image/png",
      ),
    ).rejects.toThrow(/invalid filename: path separators/);
    // Must never reach the network — no cross-tenant write is attempted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an absolute-path filename and a NUL-byte filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(
      uploadTenantAsset(config(fetchMock as unknown as typeof fetch), "t1", new Uint8Array([1]), "/etc/passwd", "image/png"),
    ).rejects.toThrow(/invalid filename/);
    await expect(
      uploadTenantAsset(config(fetchMock as unknown as typeof fetch), "t1", new Uint8Array([1]), "logo\u007f.png", "image/png"),
    ).rejects.toThrow(/control characters/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a tenantId containing traversal or separators", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(
      uploadTenantAsset(config(fetchMock as unknown as typeof fetch), "..", new Uint8Array([1]), "logo.png", "image/png"),
    ).rejects.toThrow(/invalid tenantId: path traversal/);
    await expect(
      uploadTenantAsset(config(fetchMock as unknown as typeof fetch), "a/b", new Uint8Array([1]), "logo.png", "image/png"),
    ).rejects.toThrow(/invalid tenantId: path separators/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when supabaseUrl or serviceKey is missing", async () => {
    await expect(
      uploadTenantAsset(
        { supabaseUrl: "", serviceKey: "test-key" },
        "t1",
        new Uint8Array([1]),
        "a.png",
        "image/png",
      ),
    ).rejects.toThrow(/not configured/);
    await expect(
      uploadTenantAsset(
        { supabaseUrl: "https://proj.supabase.co", serviceKey: "" },
        "t1",
        new Uint8Array([1]),
        "a.png",
        "image/png",
      ),
    ).rejects.toThrow(/not configured/);
  });

  it("throws with status and truncated body on upload failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("bucket not found", { status: 404 }),
    );
    await expect(
      uploadTenantAsset(
        config(fetchMock as unknown as typeof fetch),
        "t1",
        new Uint8Array([1]),
        "a.png",
        "image/png",
      ),
    ).rejects.toThrow(/asset upload failed \(404\): bucket not found/);
  });
});
