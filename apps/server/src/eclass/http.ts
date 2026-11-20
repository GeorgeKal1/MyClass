import fs from "node:fs";
import tls from "node:tls";
import { CookieJar } from "tough-cookie";
import { Agent, FormData as UndiciFormData, fetch as undiciFetch } from "undici";
import { EXTRA_INTERMEDIATE_CAS } from "./extra-ca.js";
import { auditEclassRequest } from "./request-audit.js";
import { currentOrigin, eclassRequestPolicy, type RequestOrigin } from "./request-origin.js";

/**
 * Strict TLS for every eClass/CAS request: Node's root store, plus intermediates that some
 * eClass servers forget to send (see extra-ca.ts), plus NODE_EXTRA_CA_CERTS if configured.
 * Certificate verification is never disabled.
 */
function trustedCas(): string[] {
  const cas = [...tls.rootCertificates, ...EXTRA_INTERMEDIATE_CAS];
  const extraFile = process.env.NODE_EXTRA_CA_CERTS;
  if (extraFile) {
    try {
      cas.push(fs.readFileSync(extraFile, "utf8"));
    } catch {
      console.warn(`[tls] could not read NODE_EXTRA_CA_CERTS file ${extraFile}`);
    }
  }
  return cas;
}

const dispatcher = new Agent({ connect: { ca: trustedCas() } });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 myClass/0.1";

export interface HttpResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  headers: Headers;
  /** Location of the last redirect that was NOT followed (e.g. custom scheme). */
  unfollowedLocation?: string;
  /** Every URL requested on the way, the final one included (eClass logs a hit per course-page hop). */
  hops: string[];
  /** Underlying fetch response – body not yet consumed. */
  raw: Response;
  text(): Promise<string>;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  form?: Record<string, string | string[]>;
  /** multipart/form-data body (file uploads, e.g. assignment submissions). */
  multipart?: UndiciFormData;
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
  /** Mobile-API tokens per portal base URL (Open eClass `mlogin.php` / `mtoken.php` session ids). */
  public tokens: Record<string, string> = {};
  /** The myClass user this session belongs to (for the request audit only). */
  public owner?: string;

  constructor(public jar: CookieJar = new CookieJar()) {}

  static fromSerialized(json: string): EclassHttp {
    const parsed = JSON.parse(json) as { jar?: unknown; tokens?: Record<string, string> } & Record<string, unknown>;
    // v2 format: { jar, tokens }; v1 format: the bare tough-cookie jar
    if (parsed && typeof parsed === "object" && "jar" in parsed && parsed.jar) {
      const http = new EclassHttp(CookieJar.deserializeSync(parsed.jar as never));
      http.tokens = parsed.tokens ?? {};
      return http;
    }
    return new EclassHttp(CookieJar.deserializeSync(parsed as never));
  }

  serialize(): string {
    return JSON.stringify({ jar: this.jar.serializeSync(), tokens: this.tokens });
  }

  async request(inputUrl: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    let url = inputUrl;
    let method = opts.method ?? "GET";
    let body: string | UndiciFormData | undefined;
    if (opts.multipart) {
      body = opts.multipart;
    } else if (opts.form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) {
        if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
        else p.append(k, v);
      }
      body = p.toString();
    }
    const max = opts.maxRedirects ?? 15;
    const hops: string[] = [];
    const origin = currentOrigin();

    for (let hop = 0; hop <= max; hop++) {
      // Automated work never opens a page eClass counts as a course visit, not even via a redirect
      assertMaySend(url, method, origin, this.owner);
      hops.push(url);
      const cookie = await this.jar.getCookieString(url);
      const headers: Record<string, string> = {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "el-GR,el;q=0.9,en;q=0.8",
        ...(opts.headers ?? {}),
      };
      if (cookie) headers.Cookie = cookie;
      if (typeof body === "string") headers["Content-Type"] = "application/x-www-form-urlencoded";

      const res = (await undiciFetch(url, {
        method,
        headers,
        body: body as never,
        redirect: "manual",
        signal: opts.signal,
        dispatcher,
      })) as unknown as Response;

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
          return wrap(res, url, hops, loc);
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
      return wrap(res, url, hops);
    }
    throw new Error(`Too many redirects for ${inputUrl}`);
  }

  async getText(url: string, opts?: RequestOptions): Promise<{ url: string; html: string; status: number; hops: string[] }> {
    const r = await this.request(url, opts);
    return { url: r.url, html: await r.text(), status: r.status, hops: r.hops };
  }
}

/** Thrown instead of sending an automated request that eClass would (or might) log as a course visit. */
export class CountedVisitBlockedError extends Error {
  constructor(
    readonly url: string,
    readonly reason = "eClass counts this page as a course visit",
  ) {
    super(`myClass does not open this eClass page on its own (${reason})`);
    this.name = "CountedVisitBlockedError";
  }
}

/**
 * The student's eClass usage log must only ever show what the student did. Only requests the
 * student asked for in the app (origin "interactive") may reach a page that writes a hit into
 * eClass' `actions_daily`; background checks, the assistant, sign-in, statistics and anything of
 * unknown origin may only use the named hit-free endpoints (see `eclassRequestPolicy`). Checked
 * for every hop, so a redirect cannot lead there either. Every decision goes to the request audit.
 */
function assertMaySend(url: string, method: string, origin: RequestOrigin, owner?: string) {
  const verdict = eclassRequestPolicy(url, origin);
  let host = "";
  let path = url.split("?")[0];
  try {
    const u = new URL(url);
    host = u.host;
    path = u.pathname;
  } catch {
    /* relative or broken address: logged without its query */
  }
  auditEclassRequest({
    owner,
    origin,
    method,
    host,
    path,
    course: verdict.counted?.courseCode,
    counted: Boolean(verdict.counted),
    blocked: verdict.allow ? undefined : verdict.reason,
  });
  if (!verdict.allow) throw new CountedVisitBlockedError(url, verdict.reason);
}

function wrap(res: Response, url: string, hops: string[], unfollowedLocation?: string): HttpResponse {
  return {
    status: res.status,
    url,
    hops,
    headers: res.headers,
    unfollowedLocation,
    raw: res,
    text: () => res.text(),
  };
}
