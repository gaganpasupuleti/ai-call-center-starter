import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('artifacts', { recursive: true });

const browser = await chromium.launch();
const consoleErrors = [];
const pageErrors = [];
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err)));

async function shot(hash, name) {
  await page.goto(`http://127.0.0.1:8787/${hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `artifacts/${name}.png`, fullPage: true });
}

const routes = [
  ['#/dashboard', 'final-dashboard-1366'],
  ['#/leads', 'final-leads-1366'],
  ['#/campaigns', 'final-campaigns-1366'],
  ['#/calls', 'final-calls-1366'],
  ['#/follow-ups', 'final-follow-ups-1366'],
  ['#/settings', 'final-settings-1366'],
];

for (const [hash, name] of routes) await shot(hash, name);

await page.setViewportSize({ width: 1024, height: 768 });
await shot('#/dashboard', 'final-dashboard-1024');
await page.setViewportSize({ width: 768, height: 900 });
await shot('#/dashboard', 'final-dashboard-768');

const result = {
  consoleErrors,
  pageErrors,
  screenshots: routes.length + 2,
  ok: consoleErrors.length === 0 && pageErrors.length === 0,
};
console.log(JSON.stringify(result, null, 2));
await browser.close();
if (!result.ok) process.exit(1);
