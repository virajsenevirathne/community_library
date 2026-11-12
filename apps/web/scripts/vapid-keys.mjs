// Makes the site's web push keys (VAPID), once. Then set them as secrets:
//   npx wrangler secret put VAPID_PUBLIC_KEY
//   npx wrangler secret put VAPID_PRIVATE_KEY
// For local development, put both in .dev.vars. Changing them later turns
// off every phone's notifications until people turn them on again.
import { generateVapidKeys } from "../../../packages/adapters/src/push.ts";

const keys = await generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
