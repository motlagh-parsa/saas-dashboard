// Regenerates the README screenshots (docs/screenshots/*.png) from a running
// app with the seeded demo:  node scripts/screenshots.mjs
import { writeFileSync } from "node:fs";

import { connectDb, launchBrowser, signInDemo, sleep } from "./e2e-lib.mjs";

const { one, close } = await connectDb();
const browser = await launchBrowser({ port: 9341 });
const { send, load, evaluate, setSession } = browser;

async function shot(name, path, { width = 1440, height = 900, theme = "light", full = false } = {}) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await send("Network.setCookie", { name: "meridian_theme", value: theme, domain: "localhost", path: "/" });
  await load(path, path.split("?")[0]);
  await sleep(1500);
  const clip = full
    ? { x: 0, y: 0, width, height: Math.min(await evaluate("document.documentElement.scrollHeight"), 2400), scale: 1 }
    : undefined;
  const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) });
  writeFileSync(`docs/screenshots/${name}.png`, Buffer.from(data, "base64"));
  console.log(`docs/screenshots/${name}.png`);
}

const northwind = await one(`SELECT id FROM "Organization" WHERE slug = 'northwind-analytics'`);
await setSession(null);
await shot("landing", "/");
await setSession(await signInDemo(), northwind.id);
await shot("overview", "/dashboard");
await shot("overview-dark", "/dashboard", { theme: "dark" });
await shot("revenue", "/dashboard/revenue");
const customer = await one(`SELECT id FROM "Customer" WHERE "organizationId" = $1 ORDER BY name LIMIT 1`, [northwind.id]);
await shot("customer", `/dashboard/customers/${customer.id}`);
await shot("import", "/dashboard/import");
await shot("integrations", "/dashboard/settings/integrations");
await shot("mobile", "/dashboard", { width: 390, height: 844 });

browser.close();
await close();
process.exit(0);
