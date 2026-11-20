/**
 * End-to-end tests in a real browser (Playwright + Chromium).
 * Run `npx playwright install chromium` once, then `npm run test:e2e`.
 * Set PLAYWRIGHT_CHANNEL=chrome to use an installed Google Chrome instead.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer } from '../helpers.js';

const CAMPUS = { latitude: 42.3505, longitude: -71.0726 };
let app, browser;
const pageErrors = [];

before(async () => {
  app = await startTestServer();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
});
after(async () => {
  await browser?.close();
  await app?.close();
});

async function signIn(email, { tenant = 'northfield', viewport, geolocation } = {}) {
  const context = await browser.newContext({
    viewport: viewport ?? { width: 1360, height: 900 },
    ...(geolocation ? { geolocation, permissions: ['geolocation'] } : {}),
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${email}: ${e.message}`));
  await page.goto(app.url);
  await page.fill('input[name=tenant]', tenant);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', 'orbit123');
  await page.click('form.login-form button[type=submit]');
  await page.waitForSelector('.sidebar');
  await page.waitForSelector('.conn-live'); // WebSocket connected
  return { context, page };
}

describe('sign-in', () => {
  test('wrong password shows a clear error; demo buttons sign straight in', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(app.url);
    await page.fill('input[name=tenant]', 'northfield');
    await page.fill('input[name=email]', 'ava@northfield.test');
    await page.fill('input[name=password]', 'nope');
    await page.click('form.login-form button[type=submit]');
    await page.getByText('Incorrect school code, email or password').waitFor();

    await page.click('.demo-account[data-role="teacher"]');
    await page.getByRole('heading', { name: /Marcus/ }).waitFor();
    // A reload restores the session from the httpOnly refresh cookie.
    await page.reload();
    await page.getByRole('heading', { name: /Marcus/ }).waitFor();
    await page.click('button.signout');
    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    await context.close();
  });
});

describe('live attendance', () => {
  test('a student checks in with real browser geolocation and the teacher’s board updates live', async () => {
    const teacher = await signIn('m.reed@northfield.test');
    await teacher.page.getByRole('link', { name: 'Open live board' }).click();
    const count = teacher.page.getByTestId('here-count');
    await count.waitFor();
    const before = Number(await count.textContent());

    // Ava's browser reports a position ~40 m from the campus center.
    const student = await signIn('ava@northfield.test', { geolocation: { latitude: CAMPUS.latitude + 0.0003, longitude: CAMPUS.longitude + 0.0002, accuracy: 12 } });
    await student.page.getByRole('heading', { name: 'Check in to Algebra I' }).waitFor();
    await student.page.getByRole('button', { name: 'Use my location' }).click();
    await student.page.getByTestId('geo-preview').filter({ hasText: 'inside' }).waitFor();
    await student.page.locator('.checkin-btn').click();
    await student.page.getByRole('heading', { name: 'You’re checked in' }).waitFor();
    assert.match(await student.page.locator('.checkin-done').textContent(), /Late|Present/);

    // No reload on the teacher side — the WebSocket delivers it.
    await teacher.page.waitForFunction((n) => Number(document.querySelector('[data-testid=here-count]').textContent) === n + 1, before);
    const row = teacher.page.getByTestId('roster-Ava Johnson');
    await row.locator('button[aria-pressed=true]').waitFor();
    assert.match(await row.textContent(), /Checked in/);
    await teacher.page.locator('.orbit-dot').first().waitFor();
    await student.context.close();
    await teacher.context.close();
  });

  test('checking in from off campus is refused with the distance', async () => {
    const student = await signIn('liam@northfield.test');
    await student.page.getByRole('heading', { name: 'Check in to Algebra I' }).waitFor();
    await student.page.selectOption('select[aria-label^="Simulate"]', 'outside');
    await student.page.getByTestId('geo-preview').filter({ hasText: 'from campus' }).waitFor();
    await student.page.locator('.checkin-btn').click();
    await student.page.locator('.error-note').filter({ hasText: /m from Northfield/ }).waitFor();
    await student.page.selectOption('select[aria-label^="Simulate"]', 'weak');
    await student.page.locator('.checkin-btn').click();
    await student.page.locator('.error-note').filter({ hasText: /too imprecise/ }).waitFor();
    await student.page.selectOption('select[aria-label^="Simulate"]', 'edge');
    await student.page.getByTestId('geo-preview').filter({ hasText: 'inside' }).waitFor();
    await student.page.locator('.checkin-btn').click();
    await student.page.getByRole('heading', { name: 'You’re checked in' }).waitFor();
    await student.context.close();
  });

  test('teacher marks a student by hand, then finalizes the session', async () => {
    const teacher = await signIn('m.reed@northfield.test');
    await teacher.page.getByRole('link', { name: 'Open live board' }).click();
    const noah = teacher.page.getByTestId('roster-Noah Williams');
    await noah.getByRole('button', { name: 'Excused' }).click();
    await noah.locator('button.on.st-excused').waitFor();
    await teacher.page.getByRole('button', { name: 'Finalize attendance' }).click();
    await teacher.page.getByText('Attendance finalized', { exact: true }).waitFor();
    await teacher.page.getByTestId('job-status').filter({ hasText: 'Done' }).waitFor();
    await teacher.context.close();
  });
});

describe('messaging and requests', () => {
  test('a parent’s message appears in the teacher’s open thread in real time', async () => {
    const teacher = await signIn('m.reed@northfield.test');
    const parent = await signIn('rachel.johnson@northfield.test');
    await parent.page.locator('.sidebar').getByRole('link', { name: 'Messages' }).click();
    await parent.page.locator('.conv', { hasText: 'Marcus Reed' }).click();
    await teacher.page.locator('.sidebar').getByRole('link', { name: 'Messages' }).click();
    await teacher.page.locator('.conv', { hasText: 'Rachel Johnson' }).click();

    await parent.page.fill('#composer', 'Thanks for the practice set!');
    await parent.page.keyboard.press('Enter');
    await teacher.page.getByTestId('message').filter({ hasText: 'Thanks for the practice set!' }).waitFor();
    await teacher.page.fill('#composer', 'You’re welcome — see you Friday.');
    await teacher.page.getByRole('button', { name: 'Send' }).click();
    await parent.page.getByTestId('message').filter({ hasText: 'see you Friday' }).waitFor();
    await teacher.context.close();
    await parent.context.close();
  });

  test('a teacher approves a flex request and the student sees it complete live', async () => {
    const student = await signIn('liam@northfield.test');
    await student.page.locator('.sidebar').getByRole('link', { name: 'Flex & requests' }).click();
    const row = student.page.getByTestId('request-row').filter({ hasText: 'Math Lab' });
    await row.filter({ hasText: 'Waiting for decision' }).waitFor();

    const teacher = await signIn('m.reed@northfield.test');
    await teacher.page.locator('.sidebar').getByRole('link', { name: 'Requests' }).click();
    await teacher.page.getByTestId('request-row').filter({ hasText: 'Liam Chen' }).click();
    await teacher.page.getByRole('button', { name: 'Approve' }).click();
    await teacher.page.locator('.events li', { hasText: 'Completed' }).waitFor();

    await row.filter({ hasText: 'Done' }).waitFor();
    await student.page.locator('.flex-blocks li', { hasText: 'Math Lab' }).getByText('You’re in').waitFor();
    await student.context.close();
    await teacher.context.close();
  });

  test('a parent submits an absence excuse', async () => {
    const parent = await signIn('rachel.johnson@northfield.test');
    await parent.page.locator('.sidebar').getByRole('link', { name: 'Excuses' }).click();
    await parent.page.getByRole('button', { name: 'Excuse an absence' }).click();
    await parent.page.selectOption('.modal select', { label: 'Ava Johnson' });
    await parent.page.fill('.modal input[type=date]', '2030-05-06');
    await parent.page.fill('.modal textarea', 'Family trip');
    await parent.page.getByRole('button', { name: 'Send request' }).click();
    await parent.page.getByTestId('request-row').filter({ hasText: '2030-05-06' }).waitFor();
    await parent.context.close();
  });
});

describe('administration', () => {
  test('admin runs a SIS sync and the imported people appear', async () => {
    const admin = await signIn('admin@northfield.test');
    await admin.page.locator('.sidebar').getByRole('link', { name: 'Integrations' }).click();
    const sis = admin.page.getByTestId('integration-sis');
    await sis.getByRole('button', { name: 'Sync now' }).click();
    await sis.getByTestId('job-status').filter({ hasText: 'Done' }).waitFor();
    await sis.getByText('3 people added').waitFor();
    await admin.page.locator('.sidebar').getByRole('link', { name: 'People' }).click();
    const jordan = admin.page.locator('tr', { hasText: 'Jordan Blake' });
    await jordan.getByText('Invited').waitFor();
    await jordan.getByRole('button', { name: 'Activate' }).click();
    const pw = await admin.page.getByTestId('temp-password').textContent();
    assert.match(pw, /^[a-z]+-[a-z]+-\d{3}$/);
    await admin.context.close();
  });

  test('admin schedules recurring sessions and sees clashes explained', async () => {
    const admin = await signIn('admin@northfield.test');
    await admin.page.locator('.sidebar').getByRole('link', { name: 'Schedule' }).click();
    await admin.page.getByRole('button', { name: 'Add sessions' }).click();
    await admin.page.selectOption('.modal select', { label: 'Math Lab (flex) — Room 204' });
    await admin.page.fill('.modal input[type=time] >> nth=0', '08:10');
    await admin.page.fill('.modal input[type=time] >> nth=1', '08:40');
    await admin.page.getByLabel('Repeat weekly').check();
    await admin.page.getByRole('button', { name: 'Add to schedule' }).click();
    await admin.page.locator('.modal .error-note').filter({ hasText: /clash/ }).waitFor();
    await admin.page.getByLabel('Skip dates that clash instead of failing').check();
    await admin.page.getByRole('button', { name: 'Add to schedule' }).click();
    await admin.page.locator('.toast').filter({ hasText: /added/ }).waitFor();
    await admin.context.close();
  });
});

describe('every page, every role', () => {
  for (const [email, tenant] of [
    ['admin@northfield.test', 'northfield'],
    ['m.reed@northfield.test', 'northfield'],
    ['ava@northfield.test', 'northfield'],
    ['rachel.johnson@northfield.test', 'northfield'],
    ['admin@riverside.test', 'riverside'],
  ]) {
    test(`${email} can open every page in their menu without errors`, async () => {
      const { page, context } = await signIn(email, { tenant });
      const links = await page.locator('.sidebar nav a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      for (const href of links) {
        await page.locator(`.sidebar nav a[href="${href}"]`).click();
        await page.locator('h1').first().waitFor();
        await page.waitForLoadState('networkidle');
        assert.equal(await page.locator('.error-note').count(), 0, `error on ${href}`);
      }
      await context.close();
      assert.deepEqual(pageErrors, []);
    });
  }

  test('the phone layout collapses navigation into a menu', async () => {
    const { page, context } = await signIn('ava@northfield.test', { viewport: { width: 390, height: 844 } });
    assert.equal(await page.locator('.sidebar').isVisible(), true); // present but off-canvas
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.locator('.menu-open').waitFor();
    await page.locator('.sidebar nav a[href="/attendance"]').click();
    await page.getByRole('heading', { name: 'Attendance' }).waitFor();
    await context.close();
  });
});
