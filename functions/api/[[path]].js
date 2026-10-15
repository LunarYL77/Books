/* Pages Functions + D1。与现有 Vue API 保持兼容；所有 SQL 值通过绑定传入。 */
const encoder = new TextEncoder();
const MAX_IMAGE = 5 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;
const BOOK_SELECT = `SELECT b.*, c.course_name, u.username AS seller_name,
  u.wechat AS seller_wechat,
  EXISTS(SELECT 1 FROM orders x WHERE x.book_id=b.book_id AND x.order_status='待面交') AS reserved
  FROM book b JOIN course c USING(course_id)
  JOIN user u ON u.user_id = b.seller_id`;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const fromHex = text => Uint8Array.from(text.match(/../g) || [], b => parseInt(b, 16));
const publicUser = u => ({ user_id: u.user_id, username: u.username, wechat: u.wechat,
  is_admin: Boolean(u.is_admin), created_at: u.created_at });
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const first = (db, sql, ...args) => stmt(db, sql, ...args).first();
const run = (db, sql, ...args) => stmt(db, sql, ...args).run();
const all = async (db, sql, ...args) => (await stmt(db, sql, ...args).all()).results;

export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  // Workers Web Crypto 支持最多 100000 次迭代，不沿用 Python 的 200000 次格式。
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return `pbkdf2-sha256$100000$${hex(salt)}$${hex(bits)}`;
}
export async function verifyPassword(password, stored) {
  if (!/^pbkdf2-sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(stored || '')) return false;
  const computed = await hashPassword(password, fromHex(stored.split('$')[2]));
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}
async function tokenHash(token) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(token))); }
async function session(db, user) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await run(db, "INSERT INTO auth_token(token,user_id,expires_at) VALUES(?,?,datetime('now','+7 days'))", await tokenHash(token), user.user_id);
  return { token, user: publicUser(user) };
}
async function currentUser(db, request, required = true) {
  const token = request.headers.get('X-Token') || '';
  const user = token ? await first(db, `SELECT u.* FROM user u JOIN auth_token t USING(user_id)
    WHERE t.token = ? AND t.expires_at > CURRENT_TIMESTAMP`, await tokenHash(token)) : null;
  if (!user && required) fail(401, '未登录或登录已过期');
  return user;
}
async function bodyJson(request) {
  if (Number(request.headers.get('Content-Length') || 0) > 8192) fail(413, '请求内容过大');
  const text = await request.text();
  if (encoder.encode(text).length > 8192) fail(413, '请求内容过大');
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '请求格式错误');
    return body;
  } catch { fail(400, '请求格式错误'); }
}
function textField(value, min, max, label, trim = true) {
  if (typeof value !== 'string') fail(400, `请填写${label}`);
  const text = trim ? value.trim() : value;
  if (text.length < min || text.length > max) fail(400, `${label}长度需为 ${min}-${max} 位`);
  return text;
}
export function imageType(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if ([137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b)) return 'image/png';
  if (String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP') return 'image/webp';
  return null;
}
async function throttle(db, request) {
  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const bucket = await tokenHash(`${ip}:${Math.floor(now / 600)}`);
  const results = await db.batch([
    stmt(db, 'DELETE FROM auth_attempt WHERE expires_at <= ?', now),
    stmt(db, 'DELETE FROM auth_token WHERE expires_at <= CURRENT_TIMESTAMP'),
    stmt(db, `INSERT INTO auth_attempt(bucket,attempts,expires_at) VALUES(?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts`, bucket, now + 600),
  ]);
  if (results[2].results[0].attempts > 20) fail(429, '尝试过于频繁，请 10 分钟后再试');
}
// 通用写操作限流：按 IP + 操作维度分桶，windowSec 秒内超过 max 次则 429
async function rateLimit(db, request, scope, max = 30, windowSec = 60) {
  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const bucket = await tokenHash(`${ip}:${scope}:${Math.floor(now / windowSec)}`);
  const results = await db.batch([
    stmt(db, 'DELETE FROM auth_attempt WHERE expires_at <= ?', now),
    stmt(db, `INSERT INTO auth_attempt(bucket,attempts,expires_at) VALUES(?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts`, bucket, now + windowSec),
  ]);
  if (results[1].results[0].attempts > max) fail(429, '操作过于频繁，请稍后再试');
}
async function getBook(db, id, user) {
  const book = await first(db, `${BOOK_SELECT} WHERE b.book_id=?`, id);
  if (!book || (book.status === '下架' && book.seller_id !== user?.user_id)) fail(404, '书籍不存在或已下架');
  book.collected = Boolean(user && await first(db, 'SELECT 1 FROM collect WHERE user_id=? AND book_id=?', user.user_id, id));
  book.reserved_by_me = Boolean(user && book.reserved && await first(db,
    "SELECT 1 FROM orders WHERE book_id=? AND buyer_id=? AND order_status='待面交'", id, user.user_id));
  return book;
}
// 订单详情（带书籍与买卖双方信息），供下单/取消/确认后回显
async function getOrder(db, orderId) {
  return first(db, `SELECT o.*, b.book_name, b.price, b.pic_url, b.status AS book_status, b.course_id,
      c.course_name, su.username AS seller_name, su.wechat AS seller_wechat,
      bu.username AS buyer_name, bu.wechat AS buyer_wechat
    FROM orders o
    JOIN book b ON b.book_id=o.book_id
    JOIN course c USING(course_id)
    JOIN user su ON su.user_id=o.seller_id
    JOIN user bu ON bu.user_id=o.buyer_id
    WHERE o.order_id=?`, orderId);
}

export async function onRequest({ request, env }) {
  try {
    if (!env.DB) fail(503, '数据库尚未绑定，请配置 D1 的 DB 绑定');
    const db = env.DB;
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
    const method = request.method;
    if (!['GET', 'POST'].includes(method)) fail(405, '不支持此请求方法');
    if (method === 'POST') {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) fail(403, '不允许跨域写入');
    }
    if (path === '/health' && method === 'GET') {
      await first(db, 'SELECT course_id FROM course LIMIT 1');
      return json({ ok: true, database: 'D1' });
    }
    const imageMatch = path.match(/^\/images\/([0-9a-f-]{36})$/);
    if (imageMatch && method === 'GET') {
      const image = await first(db, 'SELECT * FROM image WHERE image_id=?', imageMatch[1]);
      if (!image) fail(404, '图片不存在');
      const chunks = await all(db, 'SELECT content FROM image_chunk WHERE image_id=? ORDER BY chunk_index', imageMatch[1]);
      const bytes = new Uint8Array(image.byte_size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk.content, offset); offset += chunk.content.length; }
      if (offset !== image.byte_size) fail(500, '图片数据不完整');
      return new Response(bytes, { headers: { 'Content-Type': image.content_type,
        'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (['/auth/register', '/auth/login'].includes(path) && method === 'POST') {
      await throttle(db, request);
      const body = await bodyJson(request);
      const username = textField(body.username, 2, 20, '用户名');
      const password = textField(body.password, 6, 64, '密码', false);
      if (path === '/auth/register') {
        const wechat = textField(body.wechat ?? '', 0, 50, '微信号') || null;
        const passwordHash = await hashPassword(password);
        const result = await run(db, `INSERT INTO user(username,password_hash,wechat) VALUES(?,?,?)
          ON CONFLICT(username) DO NOTHING`, username, passwordHash, wechat);
        if (!result.meta.changes) fail(409, '用户名已被注册，请换一个');
        return json(await session(db, await first(db, 'SELECT * FROM user WHERE user_id=?', result.meta.last_row_id)));
      }
      const user = await first(db, 'SELECT * FROM user WHERE username=?', username);
      // 用户不存在时也计算密码，避免快速返回泄露账号是否存在。
      const dummy = 'pbkdf2-sha256$100000$' + '00'.repeat(16) + '$' + '00'.repeat(32);
      const valid = await verifyPassword(password, user?.password_hash || dummy);
      if (!user || !valid) fail(401, '用户名或密码错误');
      return json(await session(db, user));
    }
    if (path === '/auth/me' && method === 'GET') return json(publicUser(await currentUser(db, request)));
    if (path === '/auth/logout' && method === 'POST') {
      await currentUser(db, request);
      await run(db, 'DELETE FROM auth_token WHERE token=?', await tokenHash(request.headers.get('X-Token')));
      return json({ ok: true });
    }
    if (path === '/courses' && method === 'GET') return json(await all(db, 'SELECT * FROM course ORDER BY course_id'));
    if (path === '/books/mine' && method === 'GET') {
      const user = await currentUser(db, request);
      return json(await all(db, `${BOOK_SELECT} WHERE b.seller_id=? ORDER BY b.created_at DESC,b.book_id DESC`, user.user_id));
    }
    if (path === '/books' && method === 'GET') {
      const user = await currentUser(db, request, false);
      const args = [];
      let where = "b.status='上架'";
      const keyword = (url.searchParams.get('keyword') || '').trim();
      if (keyword.length > 100) fail(400, '搜索关键词不能超过 100 字');
      if (keyword) { where += ' AND b.book_name LIKE ?'; args.push(`%${keyword}%`); }
      const course = url.searchParams.get('course_id');
      if (course) { if (!/^\d+$/.test(course)) fail(400, '课程参数错误'); where += ' AND b.course_id=?'; args.push(Number(course)); }
      const sort = { time_desc: 'b.created_at DESC,b.book_id DESC', price_asc: 'b.price ASC,b.book_id DESC', price_desc: 'b.price DESC,b.book_id DESC' }[url.searchParams.get('sort')] || 'b.created_at DESC,b.book_id DESC';
      const total = await first(db, `SELECT count(*) AS total FROM book b WHERE ${where}`, ...args);
      const items = await all(db, `SELECT b.*,c.course_name,u.username AS seller_name,
        EXISTS(SELECT 1 FROM collect x WHERE x.book_id=b.book_id AND x.user_id=?) AS collected,
        EXISTS(SELECT 1 FROM orders x WHERE x.book_id=b.book_id AND x.order_status='待面交') AS reserved
        FROM book b JOIN course c USING(course_id) JOIN user u ON u.user_id=b.seller_id
        WHERE ${where} ORDER BY ${sort} LIMIT 200`, user?.user_id || 0, ...args);
      return json({ total: total.total, items: items.map(b => ({ ...b, collected: Boolean(b.collected), reserved: Boolean(b.reserved) })) });
    }
    if (path === '/books' && method === 'POST') {
      const user = await currentUser(db, request);
      await rateLimit(db, request, 'publish', 20, 60);
      if (Number(request.headers.get('Content-Length') || 0) > MAX_IMAGE + 65536) fail(413, '图片不能超过 5MB');
      let form;
      try { form = await request.formData(); } catch { fail(400, '请提交教材表单与图片'); }
      const name = textField(form.get('book_name'), 1, 100, '书名');
      const quality = textField(form.get('quality_desc') || '', 0, 100, '成色描述');
      const price = Number(form.get('price'));
      if (!Number.isFinite(price) || price <= 0 || price > 99999) fail(400, '售价需大于 0 且不超过 99999 元');
      const course = Number(form.get('course_id'));
      if (!Number.isSafeInteger(course) || !await first(db, 'SELECT 1 FROM course WHERE course_id=?', course)) fail(400, '所选课程不存在');
      const file = form.get('image');
      if (!file || typeof file.arrayBuffer !== 'function' || !file.size || file.size > MAX_IMAGE) fail(400, '请上传不超过 5MB 的图片');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const type = imageType(bytes);
      if (!type) fail(400, '仅支持 JPG / PNG / WebP 格式图片');
      const id = crypto.randomUUID();
      const statements = [stmt(db, 'INSERT INTO image(image_id,content_type,byte_size) VALUES(?,?,?)', id, type, bytes.length)];
      for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
        statements.push(stmt(db, 'INSERT INTO image_chunk(image_id,chunk_index,content) VALUES(?,?,?)', id, offset / CHUNK_SIZE, bytes.slice(offset, offset + CHUNK_SIZE).buffer));
      }
      statements.push(stmt(db, 'INSERT INTO book(seller_id,course_id,book_name,price,pic_url,quality_desc) VALUES(?,?,?,?,?,?)', user.user_id, course, name, Math.round(price * 100) / 100, `/api/images/${id}`, quality || null));
      const results = await db.batch(statements);
      return json(await getBook(db, results.at(-1).meta.last_row_id, user));
    }
    // 我的订单中心：role=buyer（默认）我买到的；role=seller 我卖出的
    if (path === '/orders' && method === 'GET') {
      const user = await currentUser(db, request);
      const cond = url.searchParams.get('role') === 'seller' ? 'o.seller_id=?' : 'o.buyer_id=?';
      return json(await all(db, `SELECT o.*, b.book_name, b.price, b.pic_url, b.status AS book_status, b.course_id,
          c.course_name, su.username AS seller_name, su.wechat AS seller_wechat,
          bu.username AS buyer_name, bu.wechat AS buyer_wechat
        FROM orders o
        JOIN book b ON b.book_id=o.book_id
        JOIN course c USING(course_id)
        JOIN user su ON su.user_id=o.seller_id
        JOIN user bu ON bu.user_id=o.buyer_id
        WHERE ${cond} ORDER BY o.create_time DESC, o.order_id DESC`, user.user_id));
    }
    // 订单动作：买家取消 / 买家确认完成（均要求订单当前为待面交）
    const orderMatch = path.match(/^\/orders\/(\d+)\/(cancel|confirm)$/);
    if (orderMatch && method === 'POST') {
      const user = await currentUser(db, request);
      const oid = Number(orderMatch[1]);
      const order = await first(db, 'SELECT * FROM orders WHERE order_id=?', oid);
      if (!order) fail(404, '订单不存在');
      if (order.buyer_id !== user.user_id) fail(403, '只能操作自己的订单');
      if (order.order_status !== '待面交') fail(409, '订单已结束，不能再操作');
      if (orderMatch[2] === 'cancel') {
        const r = await run(db, "UPDATE orders SET order_status='已取消' WHERE order_id=? AND order_status='待面交'", oid);
        if (!r.meta.changes) fail(409, '订单状态已变更，请刷新');
      } else {
        const r = await run(db, "UPDATE orders SET order_status='已完成', confirm_time=CURRENT_TIMESTAMP WHERE order_id=? AND order_status='待面交'", oid);
        if (!r.meta.changes) fail(409, '订单状态已变更，请刷新');
      }
      return json(await getOrder(db, oid));
    }
    const match = path.match(/^\/books\/(\d+)(?:\/(collect|order|delist|relist))?$/);
    if (match) {
      const id = Number(match[1]);
      const action = match[2];
      if (!action && method === 'GET') return json(await getBook(db, id, await currentUser(db, request, false)));
      if (action && method === 'POST') {
        const user = await currentUser(db, request);
        if (action === 'collect') {
          await getBook(db, id, user);
          // 同一事务内标记并删除，避免并发切换留下中间状态。
          const results = await db.batch([
            stmt(db, `INSERT INTO collect(user_id,book_id) VALUES(?,?)
              ON CONFLICT(user_id,book_id) DO UPDATE SET created_at='__remove__' RETURNING created_at`, user.user_id, id),
            stmt(db, "DELETE FROM collect WHERE user_id=? AND book_id=? AND created_at='__remove__'", user.user_id, id),
          ]);
          const collected = results[0].results[0].created_at !== '__remove__';
          return json({ collected });
        }
        if (action === 'order') {
          // 买家下单登记：不能买自己的书；下架书不可下单；同一本书只允许一个待面交订单
          await rateLimit(db, request, 'order', 20, 60);
          const book = await first(db, `${BOOK_SELECT} WHERE b.book_id=?`, id);
          if (!book || (book.status === '下架' && book.seller_id !== user.user_id)) fail(404, '书籍不存在或已下架');
          if (book.status === '下架') fail(400, '该书已下架，无法预约');
          if (book.seller_id === user.user_id) fail(400, '不能预约自己发布的书');
          const pending = await first(db, "SELECT order_id AS n FROM orders WHERE book_id=? AND order_status='待面交'", id);
          if (pending) fail(409, '该书已被其他同学预约，换一本或等对方取消');
          let orderId;
          try {
            const result = await run(db, 'INSERT INTO orders(buyer_id,seller_id,book_id) VALUES(?,?,?)', user.user_id, book.seller_id, id);
            orderId = result.meta.last_row_id;
          } catch (e) {
            fail(409, '该书已被其他同学预约，换一本或等对方取消');
          }
          return json(await getOrder(db, orderId));
        }
        const book = await first(db, 'SELECT * FROM book WHERE book_id=?', id);
        if (!book) fail(404, '书籍不存在');
        if (book.seller_id !== user.user_id) fail(403, '只能操作自己发布的书籍');
        const status = action === 'delist' ? '下架' : '上架';
        const result = await run(db, 'UPDATE book SET status=? WHERE book_id=? AND seller_id=? AND status<>?', status, id, user.user_id, status);
        if (!result.meta.changes) fail(409, `该书籍已经${status}`);
        return json({ ok: true, book_id: id, status });
      }
    }
    fail(404, '接口不存在');
  } catch (error) {
    if (!error.status) console.error(error);
    return json({ detail: error.status ? error.message : '服务暂时不可用，请稍后重试' }, error.status || 500);
  }
}
