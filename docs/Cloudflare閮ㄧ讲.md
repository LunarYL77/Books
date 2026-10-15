# Cloudflare Pages + D1 部署

这版不需要 Python 或独立服务器。Vue 页面由 Pages 提供，`functions/api/[[path]].js` 实现后端，D1 保存 SQL 业务数据及图片。现有前端的注册、登录、课程、书市、详情、发布、上下架、收藏接口均已迁移。订单和举报表已建，但订单、举报业务接口与页面仍属于后续模块，没有在本次迁移中新增。

## 首次部署

在项目根目录执行（Node.js 22 或更高版本）：

```bash
npm install
npx wrangler login
npx wrangler d1 create campus-books
```

将创建结果中的 `database_id` 填入项目根目录 `wrangler.toml`。保留绑定名 `DB`。

初始化云端数据库并发布：

```bash
npm run db:remote
npx wrangler pages project create campus-books --production-branch main
npm run deploy
```

如果已经有 Pages 项目，跳过创建命令，并把 `package.json` 的部署命令中 `--project-name` 改为实际项目名；`wrangler.toml` 的 `name` 同步修改。

发布后访问 Wrangler 返回的 `https://…pages.dev` 地址。打开 `/api/health` 应返回 `{"ok":true,"database":"D1"}`。自行注册账号，再检查发布图片、书市详情、收藏和上下架。不创建固定密码的演示账号。

`migrations/0001_initial.sql` 是完整的 SQLite/D1 建表及课程种子 SQL。Wrangler 使用迁移记录避免重复应用。已有 Python 数据库不会自动上传，旧账号和旧图片也不会自动迁移。

## Git 自动部署

连接整个项目仓库，而非仅上传 web 文件夹。Pages 设置：

- 根目录：项目根目录。
- 框架：None。
- 构建命令：留空。
- 输出目录：`web`。
- 在首次构建前，创建 D1，填写 `wrangler.toml` 的真实 ID，并执行 `npm run db:remote`。
- D1 绑定名称必须为 `DB`，指向已初始化的数据库。生产与预览环境应使用不同数据库，避免预览修改生产数据。

包含 Functions 时，Cloudflare 控制台的拖拽上传不能编译后端。使用以上 Git 集成或 Wrangler 发布。

## 本地完整运行

```bash
npm install
npm run db:local
npm run dev
```

打开终端显示的地址（一般为 http://localhost:8788）。本地 D1 与云端隔离；`--remote` 才操作云端。直接双击 HTML 仅预览界面。

## 免费额度与图片

截至 2026-10-15：D1 免费计划每日读 500 万行、写 10 万行，账户总容量 5GB，单库上限 500MB。Pages Functions 使用 Workers 免费配额，包含请求数和 CPU 时间限制。免费额度不代表无限使用，超限可能请求失败。

为了不要求开通 R2，这版将图片拆成 256KiB 的 BLOB 分块保存在 D1，每张图最多 5MiB。图片和书籍在同一 D1 批次事务中保存，读取图片带长期浏览器缓存。图片会占用数据库容量及读写额度；单库 500MB 不适合大量原图，小规模演示可用，规模扩大时应迁移 R2。下架不会删除图片，以保留书籍资料。

密码使用加盐 PBKDF2-SHA256；服务端仅保存会话令牌摘要，七天有效，退出即吊销。认证接口对同一 IP 每十分钟限制 20 次请求。上传验证文件头；所有 SQL 参数绑定；修改书籍校验卖家权限。该版本仅接受同域写入，无需跨域配置。

官方文档：
- https://developers.cloudflare.com/pages/functions/bindings/
- https://developers.cloudflare.com/pages/functions/get-started/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
