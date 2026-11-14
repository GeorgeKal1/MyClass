import { CookieJar } from "tough-cookie";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 myClass/0.1";

export interface HttpResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  headers: Headers;
  /** Location of the last redirect that was NOT followed (e.g. custom scheme). */
  unfollowedLocation?: string;
  /** Underlying fetch response – body not yet consumed. */
  raw: Response;
  text(): Promise<string>;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  form?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  maxRedirects?: number;
  signal?: AbortSignal;
}

/**
 * A tiny fetch wrapper with a per-user cookie jar and manual redirect handling.
 * Manual redirects are required because CAS hops across domains and finally
 * redirects to a non-HTTP scheme (`eclass-token:`), which fetch can't follow.
 */
export class EclassHttp {
  constructor(public jar: CookieJar = new CookieJar()) {}

  static fromSerialized(json: string): EclassHttp {
    return new EclassHttp(CookieJar.deserializeSync(json));
  }

  serialize(): string {
    return JSON.stringify(this.jar.serializeSync());
  }

  async request(inputUrl: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    let url = inputUrl;
    let method = opts.method ?? "GET";
    let body: string | undefined;
    if (opts.form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) {
        if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
        else p.append(k, v);
      }
      body = p.toString();
    }
    const max = opts.maxRedirects ?? 15;

    for (let hop = 0; hop <= max; hop++) {
      const cookie = await this.jar.getCookieString(url);
      const headers: Record<string, string> = {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "el-GR,el;q=0.9,en;q=0.8",
        ...(opts.headers ?? {}),
      };
      if (cookie) headers.Cookie = cookie;
      if (body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";

      const res = await fetch(url, { method, headers, body, redirect: "manual", signal: opts.signal });

      for (const sc of res.headers.getSetCookie()) {
        try {
          await this.jar.setCookie(sc, url, { ignoreError: true });
        } catch {
          /* ignore malformed cookies */
        }
      }

      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        const next = new URL(loc, url);
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return wrap(res, url, loc);
        }
        await res.body?.cancel();
        url = next.toString();
        // 307/308 keep method+body, everything else becomes GET
        if (res.status !== 307 && res.status !== 308) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      return wrap(res, url);
    }
    throw new Error(`Too many redirects for ${inputUrl}`);
  }

  async getText(url: string, opts?: RequestOptions): Promise<{ url: string; html: string; status: number }> {
    const r = await this.request(url, opts);
    return { url: r.url, html: await r.text(), status: r.status };
  }
}

function wrap(res: Response, url: string, unfollowedLocation?: string): HttpResponse {
  return {
    status: res.status,
    url,
    headers: res.headers,
    unfollowedLocation,
    raw: res,
    text: () => res.text(),
  };
}
