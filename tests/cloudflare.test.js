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
test('模块3：书市浏览（课程筛选/模糊检索/价格排序）与详情页（卖家微信/真实收藏）', async () => {
  const db = database();
  const call = client(db);
  const register = username => call('/auth/register', { method: 'POST', body: { username, password: 'test-password', wechat: `wx_${username}` } });
  const seller = (await register('alice')).data;
  const buyer = (await register('bob')).data;
  const bytes = new Uint8Array([137,80,78,71,13,10,26,10]);
  const publish = async (book_name, price, course_id) => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ book_name, price, course_id, quality_desc: '' })) form.set(key, value);
    form.set('image', new Blob([bytes], { type: 'image/png' }), 'b.png');
    const r = await call('/books', { method: 'POST', body: form, token: seller.token });
    assert.equal(r.status, 200);
    return r.data;
  };
  const gaoshuA = await publish('高等数学（上册）', 15.5, 1);   // 课程1
  const gaoshuB = await publish('高等数学学习辅导', 8, 1);      // 课程1
  const xianxing = await publish('线性代数', 20, 2);            // 课程2

  // 未登录也可浏览书市（公开接口）
  assert.equal((await call('/books')).status, 200);
  // 课程筛选：只看指定课程
  let r = await call('/books?course_id=1');
  assert.equal(r.data.total, 2);
  assert.ok(r.data.items.every(b => b.course_id === 1));
  // 关键词模糊检索：命中书名任意子串
  assert.equal((await call('/books?keyword=高等数学')).data.total, 2);
  assert.equal((await call('/books?keyword=辅导')).data.total, 1);
  assert.equal((await call('/books?keyword=不存在')).data.total, 0);
  // 课程 + 关键词组合
  assert.equal((await call('/books?keyword=辅导&course_id=1')).data.total, 1);
  // 价格排序：低到高 / 高到低
  r = await call('/books?sort=price_asc&course_id=1');
  assert.deepEqual(r.data.items.map(b => b.book_id), [gaoshuB.book_id, gaoshuA.book_id]);
  r = await call('/books?sort=price_desc&course_id=1');
  assert.deepEqual(r.data.items.map(b => b.book_id), [gaoshuA.book_id, gaoshuB.book_id]);
  // 默认按最新发布（同秒时按书 ID 倒序）
  r = await call('/books');
  assert.equal(r.data.items[0].book_id, xianxing.book_id);

  // 详情页：展示卖家名与卖家微信号，收藏状态默认未收藏
  const detail = (await call(`/books/${gaoshuA.book_id}`, { token: buyer.token })).data;
  assert.equal(detail.seller_name, 'alice');
  assert.equal(detail.seller_wechat, 'wx_alice');
  assert.equal(detail.collected, false);
  // 收藏真实可用：加入 → 详情与书市列表都反映 collected → 取消
  assert.equal((await call(`/books/${gaoshuA.book_id}/collect`, { method: 'POST', token: buyer.token })).data.collected, true);
  assert.equal((await call(`/books/${gaoshuA.book_id}`, { token: buyer.token })).data.collected, true);
  assert.equal((await call('/books?keyword=高等数学', { token: buyer.token })).data.items.find(b => b.book_id === gaoshuA.book_id).collected, true);
  assert.equal((await call(`/books/${gaoshuA.book_id}/collect`, { method: 'POST', token: buyer.token })).data.collected, false);
  assert.equal((await call(`/books/${gaoshuA.book_id}`, { token: buyer.token })).data.collected, false);
  // 收藏需登录
  assert.equal((await call(`/books/${gaoshuA.book_id}/collect`, { method: 'POST' })).status, 401);
  db.sql.close();
});
test('模块4：下单、订单中心、取消、确认完成（FR-ORDER-01~04）', async () => {
  const db = database();
  const call = client(db);
  const register = username => call('/auth/register', { method: 'POST', body: { username, password: 'test-password', wechat: `wx_${username}` } });
  const seller = (await register('shop')).data;
  const buyer1 = (await register('buyer1')).data;
  const buyer2 = (await register('buyer2')).data;
  const bytes = new Uint8Array([137,80,78,71,13,10,26,10]);
  const publish = async (name, price, courseId) => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ book_name: name, price, course_id: courseId, quality_desc: '' })) form.set(k, v);
    form.set('image', new Blob([bytes], { type: 'image/png' }), 'b.png');
    return (await call('/books', { method: 'POST', body: form, token: seller.token })).data;
  };
  const book = await publish('大学物理教材', 18.0, 5);

  // 未登录不能下单；卖家不能买自己的书
  assert.equal((await call(`/books/${book.book_id}/order`, { method: 'POST' })).status, 401);
  assert.equal((await call(`/books/${book.book_id}/order`, { method: 'POST', token: seller.token })).status, 400);
  // buyer1 下单成功
  let o = await call(`/books/${book.book_id}/order`, { method: 'POST', token: buyer1.token });
  assert.equal(o.status, 200);
  assert.equal(o.data.order_status, '待面交');
  assert.equal(o.data.seller_name, 'shop');
  assert.equal(o.data.buyer_name, 'buyer1');
  const orderId = o.data.order_id;
  // 同一本书只允许一个待面交订单（buyer2 / buyer1 重复下单都被拦）
  assert.equal((await call(`/books/${book.book_id}/order`, { method: 'POST', token: buyer2.token })).status, 409);
  assert.equal((await call(`/books/${book.book_id}/order`, { method: 'POST', token: buyer1.token })).status, 409);
  assert.equal((await call('/books')).data.items[0].reserved, true);

  // 订单中心：买家视角 / 卖家视角
  assert.equal((await call('/orders', { token: buyer1.token })).data.length, 1);
  const mySell = (await call('/orders?role=seller', { token: seller.token })).data;
  assert.equal(mySell.length, 1);
  assert.equal(mySell[0].buyer_name, 'buyer1');
  assert.equal((await call('/orders', { token: buyer2.token })).data.length, 0);

  // 非本人订单不能操作；buyer1 取消后该书可重新下单
  assert.equal((await call(`/orders/${orderId}/cancel`, { method: 'POST', token: buyer2.token })).status, 403);
  let c = await call(`/orders/${orderId}/cancel`, { method: 'POST', token: buyer1.token });
  assert.equal(c.status, 200);
  assert.equal(c.data.order_status, '已取消');
  assert.equal((await call(`/orders/${orderId}/confirm`, { method: 'POST', token: buyer1.token })).status, 409);
  // 取消后 buyer2 可重新下单并确认完成
  o = await call(`/books/${book.book_id}/order`, { method: 'POST', token: buyer2.token });
  assert.equal(o.status, 200);
  const orderId2 = o.data.order_id;
  let f = await call(`/orders/${orderId2}/confirm`, { method: 'POST', token: buyer2.token });
  assert.equal(f.status, 200);
  assert.equal(f.data.order_status, '已完成');
  assert.ok(f.data.confirm_time);
  assert.equal((await call(`/orders/${orderId2}/cancel`, { method: 'POST', token: buyer2.token })).status, 409);
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
