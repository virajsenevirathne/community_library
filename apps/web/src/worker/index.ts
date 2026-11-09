import { createApp } from "./app.ts";

const app = createApp();

export default {
  fetch: app.fetch,

  // Daily Cron Trigger. Reminder sending is built in VIR-14 and VIR-23.
  async scheduled(controller, _env, _ctx) {
    console.log(`Reminder job triggered by cron "${controller.cron}"; nothing to send yet.`);
  },
} satisfies ExportedHandler<Env>;
