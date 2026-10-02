/* eslint-disable @typescript-eslint/no-explicit-any */
/** Tiny browser-like client: cookie jar, CSRF header, Origin header. */
export class Client {
  cookies = new Map<string, string>();
  csrf = '';
  constructor(readonly base: string) {}

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async req(method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { origin: this.base, cookie: this.cookieHeader() };
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    Object.assign(headers, extra);
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (v === '' || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  get = (u: string) => this.req('GET', u);
  post = (u: string, b?: unknown) => this.req('POST', u, b ?? {});
  put = (u: string, b?: unknown) => this.req('PUT', u, b ?? {});
  del = (u: string) => this.req('DELETE', u);

  async refreshCsrf() {
    const me = await this.get('/api/me');
    this.csrf = me.json?.csrf ?? '';
    return me;
  }
}

