// 往远端 Cloudflare D1 灌演示数据：注册账号 + 发布带封面的教材
// 用法：node scripts/seed-remote.mjs [baseUrl]
import { deflateSync } from 'zlib';
const BASE = process.argv[2] || 'https://campus-books-4fy.pages.dev';
const API = BASE + '/api';

// ---- 生成一张纯色 PNG（无第三方依赖）----
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const p = row + 1 + x * 3;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

async function api(path, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers['X-Token'] = token;
  let payload;
  if (form) { payload = form; }
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(API + path, { method, headers, body: payload });
  const text = await res.text();
  let data = {}; try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${res.status} ${path}: ${data.detail || text}`);
  return data;
}

async function register(username, wechat) {
  try {
    const r = await api('/auth/register', { method: 'POST', body: { username, password: 'demo1234', wechat } });
    console.log('注册:', username, '=>', r.user.user_id);
    return r.token;
  } catch (e) {
    // 已注册则登录
    const r = await api('/auth/login', { method: 'POST', body: { username, password: 'demo1234' } });
    console.log('登录(已存在):', username);
    return r.token;
  }
}

(async () => {
  console.log('目标:', BASE);
  const courses = await api('/courses');
  const cid = name => (courses.find(c => c.course_name.includes(name)) || courses[0]).course_id;

  const sellerToken = await register('seller_demo', 'wx_seller01');
  const seller2Token = await register('seller2', 'wx_seller02');
  await register('buyer_demo', 'wx_buyer01');

  const books = [
    { seller: sellerToken, name: '高等数学（第七版）上册', price: 15.5, course: '高等数学', q: '八成新，内页干净', color: [36, 122, 80] },
    { seller: sellerToken, name: '线性代数（第六版）', price: 20, course: '线性代数', q: '九成新，无笔记', color: [52, 108, 176] },
    { seller: seller2Token, name: '概率论与数理统计', price: 18, course: '概率论', q: '八五新，少量划线', color: [150, 80, 140] },
    { seller: seller2Token, name: '大学物理（上册）', price: 22, course: '大学物理', q: '全新未拆', color: [180, 110, 50] },
    { seller: sellerToken, name: 'C语言程序设计', price: 16, course: 'C语言', q: '七五新，书角有折痕', color: [70, 130, 100] },
    { seller: seller2Token, name: '数据结构（C语言版）', price: 25, course: '数据结构', q: '九成新', color: [90, 90, 160] },
  ];

  for (const b of books) {
    const png = makePng(480, 600, b.color);
    const form = new FormData();
    form.set('book_name', b.name);
    form.set('price', String(b.price));
    form.set('course_id', String(cid(b.course)));
    form.set('quality_desc', b.q);
    form.set('image', new Blob([png], { type: 'image/png' }), 'cover.png');
    const r = await api('/books', { method: 'POST', token: b.seller, form });
    console.log('发布:', b.name, '=> book_id', r.book_id);
  }
  console.log('完成。演示账号密码：demo1234（seller_demo / seller2 / buyer_demo）');
})();
