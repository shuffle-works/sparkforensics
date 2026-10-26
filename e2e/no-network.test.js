// Needs a production build (`npm run build`) and a Playwright Chromium (`npx playwright install chromium`).
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium } from 'playwright';
import { createServer } from '../packages/server/index.js';

let server;
let browser;
let origin;

beforeAll(async () => {
  server = createServer({ staticRoot: new URL('../dist', import.meta.url).pathname });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

test('the sample run and the docs panel make only same-origin requests', async () => {
  const page = await browser.newPage();
  const foreign = [];
  const violations = [];

  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol !== 'data:' && url.protocol !== 'blob:' && url.origin !== origin) foreign.push(request.url());
  });
  page.on('websocket', (socket) => foreign.push(socket.url()));
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });

  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: 'Try a sample run' }).click();
  await page.getByTestId('dashboard').waitFor();
  await page.getByRole('link', { name: 'Where do I find my log?' }).click();
  await page.frameLocator('iframe').locator('h1').first().waitFor();

  expect(foreign).toEqual([]);
  expect(violations).toEqual([]);
});
