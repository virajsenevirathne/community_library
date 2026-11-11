import { MemorySender } from "@community-library/adapters";
import { createApp } from "../app.ts";
import { JOIN_TOKEN_HEADER } from "../auth.ts";

export const ORIGIN = "http://localhost:5173";

/** The app plus an in-memory outbox, sharing one test database. */
export function createTestApp(env: Env) {
  const outbox = new MemorySender();
  const pending: Promise<unknown>[] = [];
  const app = createApp({ email: () => outbox, waitUntil: (p) => pending.push(p) });
  /** Waits for background work (such as sending email) started by earlier requests. */
  const settle = async () => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  return { app, outbox, env, settle };
}

/** A browser-like client for one person: keeps cookies between requests. */
let nextIp = 1;

export class TestClient {
  private cookies = new Map<string, string>();
  /** Each test person browses from their own address, like real parents on their own phones. */
  readonly ip = `10.0.${Math.floor(nextIp / 250) % 250}.${nextIp++ % 250}`;
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
