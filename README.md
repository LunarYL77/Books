# 书循环 · 本校大学生二手教材教辅交易平台

基于需求文档 v1.1 实现。技术栈：**Vue3 + Element Plus（前端）｜ FastAPI + SQLAlchemy（后端）｜ SQLite（数据库，MySQL 兼容写法）**。

## Cloudflare 完整部署（前端 + 后端 + D1 SQL）

当前推荐使用 Cloudflare Pages Functions + D1，不依赖 Python。详见 [Cloudflare 部署步骤](docs/Cloudflare部署.md)。后端代码在 `functions/`，完整建表 SQL 在 `migrations/0001_initial.sql`，绑定配置在 `wrangler.toml`。

注册登录、教材发布、图片存储、书市、详情、收藏、上下架已迁移；订单与举报仅包含表结构，业务功能尚未实现。云端部署需要创建自己的 D1 并填写真实数据库 ID；没有预设演示账号。旧 Python 数据不会自动迁移。

## 独立前端预览（无需 Python）

直接打开 `web/index.html`，或将 `web/` 作为静态站点发布到 Cloudflare Pages。无需 npm 安装或编译；Vue 3.4.38、Element Plus 2.8.8 和图标 2.3.1 从 unpkg CDN 加载，需要联网。

Cloudflare Pages 使用 `web` 作为构建输出目录，无需构建命令；直接上传时上传 `web/` 中的内容。

通过 HTTP 打开时默认请求同域 `/api`，对接 Pages Functions。直接双击文件时不连接 API。仅发布 `web/` 只能得到前端；完整部署需包含项目根目录的 `functions/`，通过 Wrangler 或 Git 发布。

## 旧 Python 后端启动（可选）

双击项目根目录的 `start_server.bat`，或手动执行：

```bat
cd backend
python main.py
```

浏览器访问 **http://127.0.0.1:8000**（首选 Chrome / Edge）。

macOS / Linux 可在项目根目录执行 `python3 backend/main.py`。使用此后端时，请在 `web/js/config.js` 中设置对应 API 地址。

> 首次运行环境要求：Python 3.12（已通过 winget 安装）+ `pip install -r requirements.txt`（本机已装好，换电脑时需重装）。

## 当前状态：模块 3 已交付（书市浏览 / 教材详情 / 收藏）

| 已验收能力 | 说明 |
|---|---|
| 注册 / 登录 / 退出 / 会话保持 | 模块 1 交付 |
| 发布教材（FR-BOOK-01） | 书名、课程（20 门种子课程下拉可选）、售价、成色（选填）、实拍图（必传，JPG/PNG/WebP ≤5MB，UUID 重命名落盘 uploads/） |
| 自主下架 / 重新上架（FR-BOOK-02） | 我的发布页操作；下架有二次确认弹窗；越权返回 403；重复操作返回 409 |
| 我的发布（FR-USER-02） | 本人全部发布列表，含封面、课程、价格、状态、发布时间 |
| 书市浏览（FR-BOOK-03） | 课程分类筛选（20 门课程一键切换）、书名关键词模糊检索（LIKE 子串命中）、价格升 / 降序排序、最新发布默认；未登录也可浏览；空态 / 加载 / 错误三态齐全 |
| 教材详情页（FR-BOOK-04） | 实拍图、书名、价格、所属课程、成色、发布时间、卖家名；展示卖家微信号 + 一键复制；沟通与面交提示 |
| 收藏入口（FR-BOOK-04） | 详情页"☆ 收藏 / ★ 已收藏"真实可用：未登录点击引导登录；登录后点击即调真实接口切换，书市列表与详情同步反映收藏状态；重复点击可取消 |
| 边界处理（FR-EXCEPTION-01） | 空态 + 行动按钮；加载失败 + 重试按钮；防重复提交；下架确认弹窗；收藏未登录引导 |

> 说明：模块 4 的「下单登记」入口暂未加入详情页，避免出现无效按钮，订单业务将在模块 4 一并实现。

## 目录结构

```
大学生二手书交易平台/
├── start_server.bat        # 一键启动
├── requirements.txt        # 后端依赖
├── docs/交互规则设计.md     # 交互设计方案（v1.0）
├── backend/
│   ├── main.py             # FastAPI 入口（路由注册、静态资源、建表、种子课程）
│   ├── config.py           # 全局路径配置
│   ├── database.py         # 数据库连接（SQLite，可一行配置切换 MySQL）
│   ├── models.py           # 6+1 张表模型（对应需求文档第六节）
│   ├── auth.py             # 密码哈希、令牌认证、current_user 依赖
│   ├── schemas.py          # 请求/响应参数校验
│   ├── routers/users.py    # 注册/登录/me/退出
│   ├── routers/courses.py  # 课程列表
│   ├── routers/books.py    # 发布/我的发布/上下架
│   └── campus_books.db     # SQLite 数据文件（自动生成）
├── web/                    # 前端（无构建步骤，直接静态服务）
│   ├── index.html
│   ├── js/app.js
│   └── vendor/             # 旧版依赖备份（当前页面使用 CDN）
└── uploads/                # 教材实拍图（模块 2 启用）
```

## 数据存储说明（模块 1 已确认）

- **业务数据**：SQLite 单文件 `backend/campus_books.db`。表结构按需求文档第六节建 6 张表（user / course / book / orders / collect / report）+ auth_token 令牌表，字段全部 MySQL 8.0 兼容——日后切换 MySQL：装好 MySQL 后 `set DATABASE_URL=mysql+pymysql://用户:密码@127.0.0.1:3306/campus_books?charset=utf8mb4` 即可，代码不改。
- **密码**：PBKDF2-SHA256 加盐哈希，不存明文。
- **图片**：本地 `uploads/` 目录，后端静态服务，`pic_url` 形如 `/uploads/xxx.jpg`。
- **登录态**：服务端 auth_token 表（可吊销）+ 前端 localStorage。

## 后续模块计划（逐模块验收）

- 模块 4：订单登记、订单中心、取消、确认完成（FR-ORDER-01~04）
- 模块 5：收藏列表页、举报与管理员处理（FR-COLLECT-01、FR-REPORT-01）
- 模块 6：边界与安全统一打磨（接口限流、越权复查、异常/空态复查）（FR-EXCEPTION-01、NFR）
