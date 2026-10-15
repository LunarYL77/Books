import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { onRequest, verifyPassword } from '../functions/api/[[path]].js';

// 用真实 SQLite 执行与 D1 一致的 SQL；云端运行时仍需部署后冒烟检查。
function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.exec(readFileSync('migrations/0001_initial.sql', 'utf8'));
  function prepare(query) {
    let args = [];
    const statement = {
      bind(...values) { args = values.map(x => x instanceof ArrayBuffer ? new Uint8Array(x) : x); return statement; },
      first() { return sql.prepare(query).get(...args) || null; },
      all() { return { results: sql.prepare(query).all(...args) }; },
      run() {
        const prepared = sql.prepare(query);
        const results = prepared.columns().length ? prepared.all(...args) : [];
        if (!prepared.columns().length) prepared.run(...args);
        const meta = sql.prepare('SELECT changes() AS changes,last_insert_rowid() AS last_row_id').get();
        return { results, meta };
      },
    };
    return statement;
  }
  return { prepare, sql, async batch(statements) {
    sql.exec('BEGIN');
    try { const results = statements.map(s => s.run()); sql.exec('COMMIT'); return results; }
    catch (e) { sql.exec('ROLLBACK'); throw e; }
  } };
}
function client(db) {
  return async (path, { method = 'GET', token, body, origin } = {}) => {
    const headers = {};
    if (token) headers['X-Token'] = token;
    if (origin) headers.Origin = origin;
    const payload = body instanceof FormData ? body : body ? JSON.stringify(body) : undefined;
    const response = await onRequest({ env: { DB: db }, request: new Request(`https://books.example/api${path}`, { method, headers, body: payload }) });
    return { status: response.status, data: response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer()) };
  };
}
test('用户、图片、书市、收藏、权限与退出的完整流程', async () => {
  const db = database();
  const call = client(db);
  assert.equal((await call('/courses')).data.length, 20);
  const register = username => call('/auth/register', { method: 'POST', body: { username, password: 'test-password', wechat: 'wx001' } });
  const seller = (await register('seller')).data;
  const buyer = (await register('buyer')).data;
  assert.equal((await register('seller')).status, 409);
  const stored = db.sql.prepare('SELECT password_hash FROM user WHERE username=?').get('seller').password_hash;
  assert.ok(await verifyPassword('test-password', stored));
  assert.ok(!await verifyPassword('wrong-password', stored));
  assert.equal((await call('/auth/login', { method: 'POST', body: { username: 'seller', password: 'wrong-password' } })).status, 401);
  assert.equal((await call('/auth/login', { method: 'POST', body: { username: 'seller', password: 'test-password' } })).status, 200);
  assert.equal((await call('/auth/me', { token: seller.token })).data.username, 'seller');
  assert.equal((await call('/auth/me')).status, 401);
  assert.equal((await call('/auth/logout', { method: 'POST', token: seller.token, origin: 'https://evil.example' })).status, 403);
  const bytes = new Uint8Array(600000); bytes.set([137,80,78,71,13,10,26,10]);
  const form = new FormData();
  for (const [key, value] of Object.entries({ book_name: '高等数学', price: '12.30', course_id: '1', quality_desc: '八成新' })) form.set(key, value);
  form.set('image', new Blob([bytes], { type: 'image/png' }), 'book.png');
  assert.equal((await call('/books', { method: 'POST', body: form })).status, 401);
  const published = await call('/books', { method: 'POST', body: form, token: seller.token });
  assert.equal(published.status, 200);
  const book = published.data;
  const image = await call(book.pic_url.replace('/api', ''));
  assert.deepEqual(image.data, bytes);
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM image_chunk').get().n, 3);
  assert.equal((await call('/books?keyword=高等&course_id=1&sort=price_asc')).data.total, 1);
  assert.equal((await call('/books?keyword=不存在')).data.total, 0);
  const action = (name, token = seller.token) => call(`/books/${book.book_id}/${name}`, { method: 'POST', token });
  assert.equal((await action('collect', buyer.token)).data.collected, true);
  assert.equal((await call(`/books/${book.book_id}`, { token: buyer.token })).data.collected, true);
  assert.equal((await action('collect', buyer.token)).data.collected, false);
  assert.equal((await action('delist', buyer.token)).status, 403);
  assert.equal((await action('delist')).status, 200);
  assert.equal((await action('delist')).status, 409);
  assert.equal((await call(`/books/${book.book_id}`)).status, 404);
  assert.equal((await call('/books/mine', { token: seller.token })).data.length, 1);
  assert.equal((await action('relist')).status, 200);
  form.set('image', new Blob(['bad'], { type: 'image/png' }), 'bad.png');
  assert.equal((await call('/books', { method: 'POST', body: form, token: seller.token })).status, 400);
  assert.equal((await call('/auth/logout', { method: 'POST', token: seller.token })).status, 200);
  assert.equal((await call('/auth/me', { token: seller.token })).status, 401);
  db.sql.close();
});
test('认证限流及缺失数据库提示', async () => {
  const db = database(); const call = client(db);
  for (let i = 0; i < 20; i++) await call('/auth/login', { method: 'POST', body: {} });
  assert.equal((await call('/auth/login', { method: 'POST', body: {} })).status, 429);
  const response = await onRequest({ env: {}, request: new Request('https://books.example/api/health') });
  assert.equal(response.status, 503);
  db.sql.close();
});
