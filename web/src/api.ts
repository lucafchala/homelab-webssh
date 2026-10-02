export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

let csrfToken = '';
export const setCsrf = (t: string) => {
  csrfToken = t;
};

type Handler = (err: ApiError) => void;
let onAuthLost: Handler | null = null;
let onRequirement: Handler | null = null;
export const onUnauthorized = (h: Handler) => (onAuthLost = h);
export const onSecurityRequirement = (h: Handler) => (onRequirement = h);

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['content-type'] = 'application/json';
  if (csrfToken) h['x-csrf-token'] = csrfToken;
  return h;
}

async function handle<T>(res: Response, path: string): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const b = body as { error?: string; code?: string } | null;
    const err = new ApiError(res.status, b?.error ?? `${res.status} ${res.statusText}`, b?.code, body);
    if (res.status === 401 && !path.startsWith('/api/auth/')) onAuthLost?.(err);
    if (res.status === 403 && (err.code === 'MFA_SETUP_REQUIRED' || err.code === 'PASSWORD_CHANGE_REQUIRED')) onRequirement?.(err);
    throw err;
  }
  return body as T;
}

export async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: headers(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  return handle<T>(res, path);
}

export const api = {
  get: <T = unknown>(p: string) => request<T>('GET', p),
  post: <T = unknown>(p: string, b: unknown = {}) => request<T>('POST', p, b),
  put: <T = unknown>(p: string, b: unknown = {}) => request<T>('PUT', p, b),
  patch: <T = unknown>(p: string, b: unknown = {}) => request<T>('PATCH', p, b),
  del: <T = unknown>(p: string) => request<T>('DELETE', p),
};

/** Upload with progress (fetch has no upload progress events). */
export function uploadFile(url: string, file: File, onProgress: (pct: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('x-csrf-token', csrfToken);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body: { error?: string; code?: string } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new ApiError(xhr.status, body?.error ?? `Upload failed (${xhr.status})`, body?.code));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

/** POST that returns a Server-Sent Events stream; calls onEvent for every `data:` JSON payload. */
export async function streamSse(path: string, body: unknown, onEvent: (e: any) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(path, { method: 'POST', headers: headers(true), body: JSON.stringify(body), signal, credentials: 'same-origin' });
  if (!res.ok || !res.body) {
    await handle(res, path);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) {
          try {
            onEvent(JSON.parse(line.slice(5).trim()));
          } catch {
            /* ignore malformed */
          }
        }
      }
    }
  }
}
