import { createApp } from "./app.ts";
import { configuredSenders } from "./email.ts";
import { runHourlyJob } from "./jobs/reminders.ts";
import { QuotaMailer } from "./mailer.ts";

const app = createApp();

/** The site's public address for links in emails. APP_URL must be set in production. */
function siteUrl(env: Env): string {
  if (env.APP_URL) return new URL(env.APP_URL).origin;
  console.warn("APP_URL is not set; email links will point at localhost.");
  return "http://localhost:5173";
}

export default {
  fetch: app.fetch,

  // Hourly Cron Trigger: reminders, the weekly staff digest and privacy tidy-up.
  async scheduled(_controller, env, ctx) {
    const url = siteUrl(env);
    const mailer = new QuotaMailer(
      env.DB,
      configuredSenders(env, env.LIBRARY_NAME, new URL(url).hostname),
    );
    ctx.waitUntil(
      runHourlyJob({ DB: env.DB, env, mailer, siteUrl: url }).then(
        (r) => console.log(`Hourly job: ${r.libraries} libraries, ${r.sent} emails sent.`),
        (error) => console.error("Hourly job failed:", error),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
