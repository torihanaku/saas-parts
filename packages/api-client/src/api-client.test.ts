import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, isAiNotConfigured } from './api-client';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

/** Stub global fetch with a typed mock so call args keep their types. */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callOf(mock: ReturnType<typeof stubFetch>, i = 0): { url: string; init: RequestInit } {
  const call = mock.mock.calls[i];
  if (!call) throw new Error(`fetch call ${i} not recorded`);
  return { url: call[0], init: call[1] ?? {} };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createApiClient', () => {
  it('GET requests the baseUrl-prefixed path and parses JSON', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ ok: true }));

    const api = createApiClient();
    const result = await api.get<{ ok: boolean }>('/users');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = callOf(fetchMock);
    expect(url).toBe('/api/users');
    expect(init.method).toBe('GET');
  });

  it('respects a custom baseUrl', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({}));

    const api = createApiClient({ baseUrl: 'https://example.com/v1' });
    await api.get('/ping');

    expect(callOf(fetchMock).url).toBe('https://example.com/v1/ping');
  });

  it('injects Authorization header from getToken', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({}));

    const api = createApiClient({ getToken: async () => 'tok-123' });
    await api.get('/me');

    const headers = callOf(fetchMock).init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-123');
  });

  it('omits Authorization header when getToken returns null', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({}));

    const api = createApiClient({ getToken: () => null });
    await api.get('/me');

    const headers = callOf(fetchMock).init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('POST serializes the JSON body and sets Content-Type', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ id: 1 }));

    const api = createApiClient();
    await api.post('/items', { name: 'a' });

    const { init } = callOf(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'a' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('PATCH / PUT / DELETE use the right methods', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({}));

    const api = createApiClient();
    await api.patch('/x', { a: 1 });
    await api.put('/x', { b: 2 });
    await api.del('/x');

    const methods = [0, 1, 2].map((i) => callOf(fetchMock, i).init.method);
    expect(methods).toEqual(['PATCH', 'PUT', 'DELETE']);
  });

  it('throws ApiError with status and parsed body on non-OK responses', async () => {
    stubFetch(async () =>
      jsonResponse({ error: 'not_found' }, { status: 404, statusText: 'Not Found' }));

    const api = createApiClient();
    const err = await api.get('/missing').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).body).toEqual({ error: 'not_found' });
  });

  it('calls onUsageLimit with a Japanese message on 403 usage_limit_exceeded', async () => {
    stubFetch(async () =>
      jsonResponse(
        { error: 'usage_limit_exceeded', action: 'aiAnalysis', used: 5, limit: 5 },
        { status: 403, statusText: 'Forbidden' },
      ));

    const onUsageLimit = vi.fn();
    const onError = vi.fn();
    const api = createApiClient({ onUsageLimit, onError });

    await expect(api.post('/analyze')).rejects.toBeInstanceOf(ApiError);
    expect(onUsageLimit).toHaveBeenCalledWith(
      'aiAnalysis の1日の上限（5/5）に達しました',
      expect.objectContaining({ error: 'usage_limit_exceeded' }),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('uses the action-less message when 403 body has no action', async () => {
    stubFetch(async () =>
      jsonResponse(
        { error: 'usage_limit_exceeded', used: 3, limit: 3 },
        { status: 403, statusText: 'Forbidden' },
      ));

    const onUsageLimit = vi.fn();
    const api = createApiClient({ onUsageLimit });

    await expect(api.get('/x')).rejects.toBeInstanceOf(ApiError);
    expect(onUsageLimit).toHaveBeenCalledWith(
      '使用量の上限（3/3）に達しました',
      expect.anything(),
    );
  });

  it('calls onError with permission message on plain 403', async () => {
    stubFetch(async () =>
      jsonResponse({ error: 'forbidden' }, { status: 403, statusText: 'Forbidden' }));

    const onError = vi.fn();
    const onUsageLimit = vi.fn();
    const api = createApiClient({ onError, onUsageLimit });

    await expect(api.get('/x')).rejects.toBeInstanceOf(ApiError);
    expect(onError).toHaveBeenCalledWith('この操作に必要な権限がありません', expect.any(ApiError));
    expect(onUsageLimit).not.toHaveBeenCalled();
  });

  it('returns undefined for empty bodies (204 semantics)', async () => {
    stubFetch(async () => new Response('', { status: 200 }));

    const api = createApiClient();
    await expect(api.get('/empty')).resolves.toBeUndefined();
  });

  it('returns plain text when the body is not JSON', async () => {
    stubFetch(async () => new Response('plain text', { status: 200 }));

    const api = createApiClient();
    await expect(api.get<string>('/text')).resolves.toBe('plain text');
  });

  it('aborts via internal timeout when no signal is passed', async () => {
    stubFetch((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')));
      }));

    const api = createApiClient({ timeoutMs: 20 });
    const err = await api.get('/slow').catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('AbortError');
  });

  it('upload posts FormData without a JSON Content-Type', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ uploaded: true }));

    const api = createApiClient({ getToken: () => 'tok' });
    const fd = new FormData();
    fd.set('file', 'x');
    const result = await api.upload('/files', fd);

    expect(result).toEqual({ uploaded: true });
    const { init } = callOf(fetchMock);
    expect(init.body).toBe(fd);
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['Authorization']).toBe('Bearer tok');
  });

  it('sendBeacon posts a JSON blob to the prefixed path', () => {
    const beacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });

    const api = createApiClient();
    api.sendBeacon('/track', { event: 'unload' });

    expect(beacon).toHaveBeenCalledTimes(1);
    const call = beacon.mock.calls[0];
    expect(call?.[0]).toBe('/api/track');
    expect(call?.[1]).toBeInstanceOf(Blob);
  });

  it('raw merges auth headers without overriding caller headers', async () => {
    const fetchMock = stubFetch(async () => new Response('ok'));

    const api = createApiClient({ getToken: () => 'tok' });
    await api.raw('/download', { headers: { Authorization: 'Bearer caller' } });

    const { init } = callOf(fetchMock);
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer caller');
  });
});

describe('isAiNotConfigured', () => {
  it('detects the ANTHROPIC_API_KEY-not-set error body', () => {
    const e = new ApiError(500, 'Internal', { error: 'ANTHROPIC_API_KEY not set' });
    expect(isAiNotConfigured(e)).toBe(true);
  });

  it('returns false for other errors', () => {
    expect(isAiNotConfigured(new ApiError(500, 'Internal', { error: 'other' }))).toBe(false);
    expect(isAiNotConfigured(new Error('x'))).toBe(false);
  });
});
