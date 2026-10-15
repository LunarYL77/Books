-- Cloudflare D1 / SQLite；不包含旧 Python 数据，也不创建固定密码演示账号。
CREATE TABLE IF NOT EXISTS user (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE CHECK(length(username) BETWEEN 2 AND 20),
  password_hash TEXT NOT NULL,
  wechat TEXT CHECK(length(wechat) <= 50),
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS course (
  course_id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS image (
  image_id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL CHECK(content_type IN ('image/jpeg','image/png','image/webp')),
  byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 5242880),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- 每块 256 KiB，避免超过 D1 单行大小限制。图片与书籍在同一批次事务中保存。
CREATE TABLE IF NOT EXISTS image_chunk (
  image_id TEXT NOT NULL REFERENCES image(image_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY(image_id, chunk_index)
);
CREATE TABLE IF NOT EXISTS book (
  book_id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES user(user_id),
  course_id INTEGER NOT NULL REFERENCES course(course_id),
  book_name TEXT NOT NULL CHECK(length(book_name) BETWEEN 1 AND 100),
  price NUMERIC NOT NULL CHECK(price > 0 AND price <= 99999),
  pic_url TEXT NOT NULL,
  quality_desc TEXT CHECK(length(quality_desc) <= 100),
  status TEXT NOT NULL DEFAULT '上架' CHECK(status IN ('上架','下架')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_book_seller ON book(seller_id, book_id DESC);
CREATE INDEX IF NOT EXISTS idx_book_market ON book(status, created_at DESC, book_id DESC);
CREATE INDEX IF NOT EXISTS idx_book_course ON book(status, course_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_book_price ON book(status, price);
CREATE TABLE IF NOT EXISTS orders (
  order_id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL REFERENCES user(user_id),
  seller_id INTEGER NOT NULL REFERENCES user(user_id),
  book_id INTEGER NOT NULL REFERENCES book(book_id),
  order_status TEXT NOT NULL DEFAULT '待面交' CHECK(order_status IN ('待面交','已取消','已完成')),
  create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirm_time TEXT,
  CHECK(buyer_id != seller_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_pending ON orders(book_id) WHERE order_status = '待面交';
CREATE TABLE IF NOT EXISTS collect (
  collect_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES user(user_id),
  book_id INTEGER NOT NULL REFERENCES book(book_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, book_id)
);
CREATE TABLE IF NOT EXISTS report (
  report_id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES book(book_id),
  report_user_id INTEGER NOT NULL REFERENCES user(user_id),
  content TEXT NOT NULL,
  handle_status TEXT NOT NULL DEFAULT '待处理' CHECK(handle_status IN ('待处理','已处理')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_report_status ON report(handle_status);
CREATE TABLE IF NOT EXISTS auth_token (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_expiry ON auth_token(expires_at);
CREATE INDEX IF NOT EXISTS idx_token_user ON auth_token(user_id);
-- 用于登录、注册防暴力尝试；只保留 IP 的 SHA256，过期记录会在下一次认证请求清理。
CREATE TABLE IF NOT EXISTS auth_attempt (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO course(course_name) VALUES
('高等数学'),('线性代数'),('概率论与数理统计'),('离散数学'),('大学物理'),
('大学英语'),('大学语文'),('C语言程序设计'),('Python程序设计'),('数据结构'),
('操作系统'),('计算机网络'),('计算机组成原理'),('数据库原理'),('电路分析基础'),
('有机化学'),('微观经济学'),('会计学原理'),('管理学原理'),('马克思主义基本原理');
