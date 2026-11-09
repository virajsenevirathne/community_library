/**
 * Email sender interface. Resend (primary) and Mailjet (fallback) implement it;
 * the quota and fallback logic lives in VIR-24.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Used by providers that support it, so a retried send is not delivered twice. */
  idempotencyKey?: string;
}

export type SendResult =
  | { ok: true; provider: string; id: string }
  | { ok: false; provider: string; retryable: boolean; error: string };

export interface EmailSender {
  readonly name: string;
  send(message: EmailMessage): Promise<SendResult>;
}
