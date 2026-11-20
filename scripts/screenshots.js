/**
 * Regenerate the README screenshots in docs/screenshots.
 *   npm run build && npm run screenshots
 * Needs Playwright's Chromium (`npx playwright install chromium`) or PLAYWRIGHT_CHANNEL=chrome.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DEMO_MODE: 'true', JOB_POLL_MS: '50' });
const { startServer } = await import('../server/app.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(out, { recursive: true });

const app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:' });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const CAMPUS = { latitude: 42.3505, longitude: -71.0726 };

async function open(email, { viewport = { width: 1400, height: 900 }, geolocation } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, ...(geolocation ? { geolocation, permissions: ['geolocation'] } : {}) });
  const page = await context.newPage();
  await page.goto(app.url);
  await page.fill('input[name=tenant]', 'northfield');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', 'orbit123');
  await page.click('form.login-form button[type=submit]');
  await page.waitForSelector('.conn-live');
  await page.waitForTimeout(400);
  return { context, page };
}
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(out, `${name}.png`), ...opts });

// Login
{
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(app.url);
  await page.waitForSelector('.demo-account');
  await shot(page, 'login');
  await context.close();
}

// Student check-in (before), then check in from the browser's real geolocation API.
const student = await open('ava@northfield.test', { geolocation: { latitude: CAMPUS.latitude + 0.0003, longitude: CAMPUS.longitude + 0.0002, accuracy: 12 } });
await student.page.getByRole('button', { name: 'Use my location' }).click();
await student.page.getByTestId('geo-preview').waitFor();
await student.page.waitForTimeout(600);
await shot(student.page, 'student-check-in', { clip: { x: 248, y: 0, width: 1152, height: 560 } });

const teacher = await open('m.reed@northfield.test');
await teacher.page.getByRole('link', { name: 'Open live board' }).click();
await teacher.page.getByTestId('here-count').waitFor();
await student.page.locator('.checkin-btn').click();
await teacher.page.waitForFunction(() => Number(document.querySelector('[data-testid=here-count]').textContent) >= 3);
await teacher.page.waitForTimeout(900);
await shot(teacher.page, 'teacher-live-board', { fullPage: true });
await student.context.close();

// Admin dashboard + integrations after a SIS sync.
const admin = await open('admin@northfield.test');
await shot(admin.page, 'admin-dashboard', { fullPage: true });
await admin.page.locator('.sidebar').getByRole('link', { name: 'Integrations' }).click();
await admin.page.getByTestId('integration-sis').getByRole('button', { name: 'Sync now' }).click();
await admin.page.getByTestId('integration-sis').getByTestId('job-status').filter({ hasText: 'Done' }).waitFor();
await admin.page.waitForTimeout(500);
await shot(admin.page, 'admin-integrations', { fullPage: true });
await admin.page.locator('.sidebar').getByRole('link', { name: 'Schedule' }).click();
await admin.page.waitForTimeout(800);
await shot(admin.page, 'schedule');
await admin.context.close();

// Messages
await teacher.page.locator('.sidebar').getByRole('link', { name: 'Messages' }).click();
await teacher.page.locator('.conv', { hasText: 'Rachel Johnson' }).click();
await teacher.page.getByTestId('message').first().waitFor();
await shot(teacher.page, 'messages');
await teacher.context.close();

// Phone
const phone = await open('rachel.johnson@northfield.test', { viewport: { width: 390, height: 844 } });
await shot(phone.page, 'parent-phone');
await phone.context.close();

await browser.close();
await app.close();
console.log(`Saved screenshots to ${path.relative(root, out)}`);
