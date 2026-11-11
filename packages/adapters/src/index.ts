export type { EmailMessage, EmailSender, SendResult } from "./email.ts";
export {
  ConsoleSender,
  type FromAddress,
  MailjetSender,
  MemorySender,
  ResendSender,
} from "./email-providers.ts";
