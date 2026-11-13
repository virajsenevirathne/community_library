import { describe, expect, it } from "vitest";
import { MailjetSender, ResendSender } from "./email-providers.ts";

const from = { email: "library@example.org", name: "Library" };
const message = { to: "parent@example.com", subject: "Your code", text: "Your code is 123456" };
const answer = (body: unknown, status: number) =>
  (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch;
const failed = (result: { ok: boolean; error?: string }) => (result.ok ? "" : result.error);

describe("email providers", () => {
  it("say why a provider refused", async () => {
    const resend = new ResendSender(
      "key",
      from,
      answer({ message: "The example.org domain is not verified." }, 403),
    );
    const result = await resend.send(message);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(failed(result)).toBe("http_403: The example.org domain is not verified.");

    const mailjet = (body: unknown, status = 400) =>
      new MailjetSender("key", "secret", from, answer(body, status)).send(message);
    expect(
      failed(await mailjet({ Messages: [{ Errors: [{ ErrorMessage: "Sender not validated" }] }] })),
    ).toBe("http_400: Sender not validated");
    expect(failed(await mailjet({ ErrorMessage: "API key authentication failed" }, 401))).toBe(
      "http_401: API key authentication failed",
    );
    // A reason that isn't text is skipped for the next one.
    expect(failed(await mailjet({ message: { code: 1 }, ErrorMessage: "Bad request" }))).toBe(
      "http_400: Bad request",
    );
    // Busy: still worth trying again, or the next provider.
    expect(await mailjet({ ErrorMessage: "Too many requests" }, 429)).toMatchObject({
      retryable: true,
    });

    const page = await new ResendSender("key", from, answer("<html>Bad gateway</html>", 502)).send(
      message,
    );
    expect(page).toMatchObject({ ok: false, retryable: true });
    expect(failed(page)).toBe("http_502");
  });

  it("never log the message's contents or anyone's address", async () => {
    const echo = (reason: string) =>
      new ResendSender("key", from, answer({ message: reason }, 422)).send(message);
    const error = failed(
      await echo(
        "Can't send to parent@example.com or <tom @ example.com>:\nYour code is 123456, key re_abcdefghijklmnopqrstuvwxyz",
      ),
    );
    expect(error).not.toContain("example.com");
    expect(error).not.toContain("123456");
    expect(error).not.toContain("re_abc");
    expect(error).not.toContain("\n");
    expect(error).toBe(
      "http_422: Can't send to <address> or <address> Your code is <number>, key <token>",
    );
    expect(failed(await echo("so long ".repeat(60)))?.length).toBe("http_422: ".length + 150);
  });

  it("point at a key pasted with a stray character, without trying it", async () => {
    let asked = false;
    const spy = (async () => {
      asked = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    for (const result of [
      await new ResendSender("re_123\n", from, spy).send(message),
      await new MailjetSender("key”", "secret", from, spy).send(message),
      await new MailjetSender("key", "sec ret", from, spy).send(message),
    ]) {
      expect(result).toMatchObject({ ok: false, retryable: false });
      expect(failed(result)).toContain("bad_key");
    }
    expect(asked).toBe(false);
  });

  it("name what went wrong when the request fails", async () => {
    const offline = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const late = await new ResendSender("key", from, offline).send(message);
    expect(late).toMatchObject({
      ok: false,
      retryable: true,
      error: "request_failed: TimeoutError",
    });
  });

  it("count an accepted message as sent even when the answer can't be read", async () => {
    // Trying the next provider would send it twice.
    const garbled = answer("not json", 200);
    expect(await new ResendSender("key", from, garbled).send(message)).toEqual({
      ok: true,
      provider: "resend",
      id: "",
    });
    expect(await new MailjetSender("key", "secret", from, garbled).send(message)).toMatchObject({
      ok: true,
      id: "",
    });
    expect(
      await new ResendSender("key", from, answer({ id: "abc" }, 200)).send(message),
    ).toMatchObject({ ok: true, id: "abc" });
  });
});
