import {
  type BookMetadata,
  MemorySender,
  type MetadataProvider,
} from "@community-library/adapters";
import { createApp } from "../app.ts";
import { JOIN_TOKEN_HEADER } from "../auth.ts";

export const ORIGIN = "http://localhost:5173";

/** The app plus an in-memory outbox, sharing one test database. */
/** The fake lookup answers "unavailable" for this ISBN, like a rate-limited service. */
export const UNAVAILABLE_ISBN = "9781742990040";

export function createTestApp(env: Env) {
  const outbox = new MemorySender();
  const pending: Promise<unknown>[] = [];
  const books = new Map<string, BookMetadata>([
    [
      "9780140328721",
      {
        isbn: "9780140328721",
        title: "Fantastic Mr Fox",
        authors: ["Roald Dahl"],
        coverUrl: "https://covers.openlibrary.org/b/isbn/9780140328721-M.jpg",
        source: "fake",
      },
    ],
  ]);
  // A fake book lookup, so tests never call the internet.
  const metadata: MetadataProvider = {
    name: "fake",
    lookup: async (isbn) => (isbn === UNAVAILABLE_ISBN ? "unavailable" : (books.get(isbn) ?? null)),
  };
  // Phone notifications go to a list instead of a push service.
  const pushed: { endpoint: string; title: string; body: string; url: string }[] = [];
  const push = {
    gone: new Set<string>(),
    send: async (
      sub: { endpoint: string },
      message: { title: string; body: string; url: string },
    ) => {
      if (push.gone.has(sub.endpoint))
        return { ok: false as const, gone: true as const, status: 410 };
      pushed.push({ endpoint: sub.endpoint, ...message });
      return { ok: true as const };
    },
  };
  // Webhook posts go to a list; an address with "down" in it fails.
  const hooks: { url: string; headers: Headers; body: string }[] = [];
  const hookFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    hooks.push({ url, headers: new Headers(init?.headers), body: String(init?.body) });
    return new Response(null, { status: url.includes("down") ? 500 : 204 });
  };
  const app = createApp({
    fetch: hookFetch,
    email: () => outbox,
    metadata: [metadata],
    push: () => push,
    waitUntil: (p) => pending.push(p),
  });
  /** Waits for background work (such as sending email) started by earlier requests. */
  const settle = async () => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  return { app, outbox, env, settle, push, pushed, hooks, hookFetch };
}

/** A browser-like client for one person: keeps cookies between requests. */
let nextIp = 1;

export class TestClient {
  private cookies = new Map<string, string>();
  /** Each test person browses from their own address, like real parents on their own phones. */
  readonly ip = `10.0.${Math.floor(nextIp / 250) % 250}.${nextIp++ % 250}`;
  /**
   * The library this person's pages belong to, sent as the browser does
   * (the X-Library header). Null for site-wide pages only.
   */
  library: string | null = "lib-1";
  constructor(
    private readonly ctx: ReturnType<typeof createTestApp>,
    readonly email: string,
    private readonly origin = ORIGIN,
  ) {}

  async request(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const headers = new Headers(init.headers);
    headers.set("Origin", this.origin);
    if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", this.ip);
    if (this.library && !headers.has("X-Library")) headers.set("X-Library", this.library);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.cookies.size > 0) {
      headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const res = await this.ctx.app.request(
      `${this.origin}${path}`,
      {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      },
      this.ctx.env,
    );
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [key, ...value] = (pair ?? "").split("=");
      if (!key) continue;
      const joined = value.join("=");
      if (joined === "" || /max-age=0/i.test(cookie)) this.cookies.delete(key);
      else this.cookies.set(key, joined);
    }
    return res;
  }

  async json<T = Record<string, unknown>>(
    path: string,
    init: Parameters<TestClient["request"]>[1] = {},
  ) {
    const res = await this.request(path, init);
    return { status: res.status, body: (await res.json()) as T };
  }

  /** Asks for a sign-in code. Returns the code if an email was sent. */
  async requestCode(extraHeaders: Record<string, string> = {}): Promise<string | undefined> {
    const before = this.ctx.outbox.sent.length;
    await this.request("/api/auth/email-otp/send-verification-otp", {
      body: { email: this.email, type: "sign-in" },
      headers: extraHeaders,
    });
    // The email is sent in the background.
    await this.ctx.settle();
    const sent = this.ctx.outbox.sent.slice(before).findLast((m) => m.to === this.email);
    return sent?.subject.match(/^(\d{6})/)?.[1];
  }

  /** Full email-code sign-in. Pass a join token for people joining by link. */
  async signIn(joinToken?: string): Promise<void> {
    const code = await this.requestCode(joinToken ? { [JOIN_TOKEN_HEADER]: joinToken } : {});
    if (!code) throw new Error(`No sign-in code was sent to ${this.email}`);
    const res = await this.request("/api/auth/sign-in/email-otp", {
      body: { email: this.email, otp: code },
    });
    if (!res.ok)
      throw new Error(`Sign-in failed for ${this.email}: ${res.status} ${await res.text()}`);
  }
}
