import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const mobile = readFileSync(process.env.MOBILE_HTML_PATH || resolve(root, 'ui/mobile/m.html'), 'utf8');
const project = { name: 'Herdr · default', source: 'herdr', workspaces: [{ id: 'herdr:w7', name: 'ทีมทดสอบ', branch: null, rooms: [{ id: 'w7:p1', title: 'หัวหน้าทดสอบ', agent: 'codex', status: 'working', generation: 'g1', continuityToken: 'g1', capabilities: { prompt: true, keys: true, answer: false, screen: true, history: false, close: true, stop: true } }] }] };

test('Herdr existing room, missing history and team creation use shipped mobile UI', async ({ page }) => {
  const creates: any[] = [], errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  let operation: any = null;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = decodeURIComponent(url.pathname);
    if (path === '/m.html') return route.fulfill({ contentType: 'text/html', body: mobile.replace(/<script src="\/m-ext\/(?!herdr|permissions)[^"]+" defer><\/script>/g, '') });
    if (path === '/m-ext/herdr.js' || path === '/m-ext/permissions.js') return route.fulfill({ contentType: 'application/javascript', body: readFileSync(resolve(root, 'ui/mobile/ext', path.split('/').at(-1)!), 'utf8') });
    let body: any = { ok: true };
    if (path === '/mobile/projects') body = { projects: [project] };
    else if (path.endsWith('/chat')) body = { ok: true, kind: 'none', available: false };
    else if (path.endsWith('/screen')) body = { ok: true, content: 'จอจริงจำลอง' };
    else if (path.endsWith('/prompt')) body = { ok: true, prompt: null, generation: 'g1' };
    else if (path === '/mobile/version') body = { v: 'test' };
    else if (path === '/mobile/system') body = { ok: true, mac: {}, limits: {} };
    else if (path === '/mobile/herdr/status') body = { ok: true, operations: operation ? [operation] : [] };
    else if (path === '/mobile/herdr/create') {
      const data = route.request().postDataJSON(); creates.push(data);
      operation = { ...data, desiredAutostart: data.autostart, phase: 'partial', members: data.members.map((m: any, i: number) => ({ ...m, logicalId: `member-${i}`, desired: data.autostart, launched: i === 0, ready: false, bootstrap: 'pending' })) };
      body = { ok: true, operation };
    } else if (path.startsWith('/mobile/herdr/operations/')) body = { ok: true, operation };
    if (path.startsWith('/mobile/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('https://maw.test/m.html');
  await page.locator('[data-p="Herdr · default"]').click();
  await expect(page.getByText('ยังอ่านประวัติแชทไม่ได้')).toBeVisible();
  await page.getByRole('button', { name: 'ดูจอจริง', exact: true }).click();
  await expect(page.locator('#screen')).toContainText('จอจริงจำลอง');
  await page.locator('#add').click();
  await expect(page.locator('[data-label]')).toBeVisible();
  await page.locator('[data-label]').fill('team-test');
  await page.locator('[data-cwd]').fill('/home/example/project');
  await page.locator('[data-mode]').selectOption('team');
  await expect(page.locator('[data-role]')).toHaveCount(4);
  await expect(page.locator('[data-auto]')).toBeChecked();
  expect(await page.locator('[data-permission]').evaluateAll(es => es.map(e => (e as HTMLSelectElement).value))).toEqual(['ask','ask','ask','ask']);
  expect(await page.locator('[data-model]').evaluateAll(es => es.map(e => (e as HTMLInputElement).value))).toEqual(['gpt-6-astra','gpt-6.1-sol','gpt-6.1-sol','gpt-6.1-sol']);
  await page.locator('[data-create]').click();
  await expect.poll(() => creates.length).toBe(1);
  await expect(page.locator('.sheet')).toContainText('สำเร็จบางส่วน');
  await expect(page.locator('.sheet')).toContainText('worker3');
  expect(creates[0].autostart).toBe(true);
  expect(errors).toEqual([]);
});
