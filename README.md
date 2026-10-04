# 漆器髹涂工序与荫房环境档案（gblacquer）

面向漆艺工作室工序管理员的本地化档案工具：把每件漆器的髹涂道次、荫干时长与打磨推光逐道记录，并同步留存荫房温湿度，作为漆层缺陷回溯依据。

核心动作：**登记胎体与器型 → 编排髹涂道次与漆种 → 记录荫房温湿度 → 登记打磨与推光 → 登记镶嵌纹饰 → 漆料批次领用对账与停用召回 → 成品质检与导出**。

纯前端单页应用（React 18 + TypeScript + Ant Design + Vite + Zustand + React Router），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据），刷新或重启浏览器后依然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22818**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gblacquer}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地；迁移设备请使用 `/export` 页的「导出 / 导入 JSON 备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18（函数组件 + Hooks） | 页面按路由懒加载 |
| 语言 | TypeScript（`strict: true`，`noUnusedLocals`） | `npm run build` 内含 `tsc --noEmit` 类型检查 |
| UI 组件库 | Ant Design 5（含 `@ant-design/icons`） | 表格、表单、对话框、拖拽排序、徽标 |
| 构建工具 | Vite 5 | 开发服务器端口 22818 |
| 状态管理 | Zustand 4 | `bodyStore` / `coatStore` / `roomStore` / `paintStore` |
| 路由 | React Router 6（`createBrowserRouter`，history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 含数据结构版本号与 v1→v2 升级迁移 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段类型检查 + 打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22818
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22818）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、页面与路由

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/bodies` | 胎体与器型台账 | 新建胎体、按材质与器型筛选（同步 URL query），卡片回显已完成道次与最近荫房记录 | Body、Coat、Room |
| `/coats` | 髹涂道次编排 | 拖拽调整道次先后并重编号、批量改漆种与状态、同器型自动带出上次漆种与间隔建议 | Coat、Body |
| `/rooms` | 荫房温湿度记录 | 按区间判定适宜 / 偏干 / 偏湿，越界回写关联道次为「待复检」，支持日期区间筛选 | Room、Coat |
| `/polish` | 打磨与推光工序 | 按道次生成目数序列（320→2000），未打磨完的道次禁止进入下一道罩漆 | Polish、Coat |
| `/inlays` | 镶嵌纹饰登记 | 螺钿 / 蛋壳 / 描金 / 戗金登记与批量调整分类，器型示意区叠加显示 | Inlay、Body |
| `/paint` | 漆料批次台账与领用对账 | 漆料批次入库、髹涂/镶嵌两工序领用登记（事务扣减）、台账对账；供应商停用通报先预览后召回冻结，重启续处理 | PaintBatch、PaintUsage、RecallOrder 及全部模型 |
| `/export` | 成品质检与导出 | 质检登记（返工定位到具体道次与荫房记录）、返工清单、JSON 导入导出与清空重播种 | Inspect 及全部模型 |

`/` 与未匹配路径重定向到 `/bodies`。筛选条件写入 URL query（`?kw=&paintType=&state=` 等），刷新后条件保留，可直接分享链接。

---

## 五、数据模型

| 模型 | 文件 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| Body 胎体 | `src/types/body.ts` | `id` `code` `material`（木/脱胎/金属） `shape`（碗/盘/盒/瓶） `sizeMm` `ownerName` `state`（待髹涂/髹涂中/待荫干/已完成） | 新建后进入道次编排，卡片回显进度与最近荫房 |
| Coat 髹涂道次 | `src/types/coat.ts` | `id` `bodyId` `seq` `paintType`（生漆/色漆/罩漆） `colorName` `coatDate` `thicknessUm` `state`（待涂/已涂/待打磨/已完成） `needRecheck` | 拖拽调序，同器型带出上次漆种与间隔建议 |
| Room 荫房记录 | `src/types/room.ts` | `id` `bodyId` `date` `tempC` `humidityPct` `inAt` `outAt` `verdict`（适宜/偏干/偏湿） | 越界即回写关联道次为待复检 |
| Polish 打磨推光 | `src/types/polish.ts` | `id` `bodyId` `seq` `grit` `method`（水砂/推光/揩清） `durationMin` `operator` | 按道次生成目数序列 |
| Inlay 镶嵌 | `src/types/inlay.ts` | `id` `bodyId` `type`（螺钿/蛋壳/描金/戗金） `pattern` `position` `materialNote` | 器型示意区叠加显示，支持批量改分类 |
| Inspect 质检 | `src/types/inspect.ts` | `id` `bodyId` `verdict`（合格/返工） `defectNote` `inspector` `date` `defectCoatSeq` `defectRoomId` | 返工定位到道次与荫房记录并生成返工清单 |
| PaintBatch 漆料批次 | `src/types/paint.ts` | `id` `batchNo` `kind`（生漆/色漆/罩漆） `colorName` `supplier` `receivedQty` `remainingQty` `unit` `status`（在用/停用） | 车间漆料台账，同一批漆料由髹涂与镶嵌两工序领用，余量仅由领用事务扣减 |
| PaintUsage 领用流水 | `src/types/paint.ts` | `id` `batchId` `batchNo` `process`（髹涂/镶嵌） `bodyId` `coatId` `inlayId` `qty` `unit` `operator` `usageDate` | 登记时在单个事务内条件扣减余量；批次号快照保证删除关联后仍可对账 |
| RecallOrder 召回单 | `src/types/paint.ts` | `id` `noticeNo`（**唯一**） `batchId` `batchNo` `reason` `status`（待确认冻结/冻结中/已冻结/冻结失败） `confirmed` `targets` `countSnapshot` `frozenAt` | 供应商批次停用通报生成；同一通报只生成一份；确认后原子冻结五类下游记录 |

五类下游记录（Body / Coat / Polish / Inlay / Inspect）统一含冻结字段 `frozen` `frozenByRecallId` `frozenAt` `frozenReason`：召回冻结只追加标记、业务原值全部保留，冻结后禁止编辑与删除；Coat / Inlay 另含 `batchId` 指向所用漆料批次。

数据结构版本号 `DB_SCHEMA_VERSION` 定义在 `src/utils/db.ts`，当前为 `v3`：
- v1→v2：`coats` 表增加 `paintType` 索引，回填 `paintType = 'raw'`、`needRecheck = false`、`thicknessUm = 40`；
- v2→v3：新增 `paintBatches` / `paintUsages` / `recallOrders` 三表（`noticeNo` 唯一索引）；五类下游表增加冻结字段与 `frozen` 索引；`coats` / `inlays` 增加 `batchId`，**旧数据无漆料批次时回填 `untraced`（未追溯）**。

---

## 六、目录结构

```
sologsb101-1018/
├── frontend/                     # 前端源码
│   ├── src/
│   │   ├── types/                # body.ts coat.ts room.ts polish.ts inlay.ts inspect.ts paint.ts freeze.ts
│   │   ├── stores/               # bodyStore.ts coatStore.ts roomStore.ts paintStore.ts
│   │   ├── components/common/    # StageTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx FrozenTag.tsx
│   │   ├── hooks/                # useCoatProgress.ts useIdbTable.ts
│   │   ├── pages/                # BodyList.tsx CoatBoard.tsx RoomLog.tsx PolishBoard.tsx InlayBoard.tsx PaintBoard.tsx ExportView.tsx
│   │   ├── router/               # index.tsx
│   │   ├── utils/                # humidity.ts db.ts export.ts paintService.ts
│   │   ├── scripts/              # verify-paint.ts verify-tx.ts（Node + fake-indexeddb 事务行为验证，不参与构建）
│   │   ├── styles/               # main.css
│   │   ├── App.tsx main.tsx
│   ├── public/favicon.svg
│   ├── index.html package.json tsconfig.json vite.config.ts
│   ├── Dockerfile                # 多阶段构建（node:20-alpine → nginx:alpine）
│   ├── nginx.conf                # SPA fallback + gzip + 静态资源缓存
│   └── .dockerignore
├── docker-compose.yml            # 顶层 name、container_name、端口映射
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── README.md
```

分层约定：页面只读 Zustand store，跨页状态不留在组件内部 `useState`；IndexedDB 读写统一走 `useIdbTable()` 封装；筛选派生逻辑统一走 store 导出的选择器函数。

---

## 七、数据存储说明

- **IndexedDB（Dexie，数据库名 `gblacquer`）**：9 张表 `bodies` / `coats` / `rooms` / `polishes` / `inlays` / `inspects` / `paintBatches` / `paintUsages` / `recallOrders`，由 `src/utils/db.ts` 统一定义 schema、版本号与升级迁移；`initDatabase()` 在首次打开时自动播种**三层互相引用**的演示数据（Body → Coat / Room → Polish / Inlay / Inspect，固定 id 如 `body_01`、`coat_0101`）并附带漆料批次与领用流水（余量与流水严格对账），播种幂等。
- **事务一致性（`src/utils/paintService.ts`）**：
  - 领用登记在单个 IndexedDB readwrite 事务内完成「批次状态校验 → 余量检查 → 条件扣减 → 写流水」；两个标签页同时领用时同库事务自动串行，余量不足即抛错整笔回滚，不会出现流水已写未扣或余量为负。
  - 对账按「入库量 − 髹涂领用 − 镶嵌领用 = 理论余量」核对台账余量，差额非 0 即提示异常。
  - 停用通报先 `buildRecallPreview()` 预览受影响的胎体 / 道次 / 打磨 / 镶嵌 / 质检（不含荫房）；登记时批次置停用并生成召回单（`noticeNo` 唯一，重复通报事务回滚）。确认后召回单先置「冻结中」落库，再在单个大事务内给全部下游打冻结标记——任何一步失败整单回滚不留半套；应用启动时 `resumePendingRecalls()` 自动继续处理「冻结中 / 冻结失败」的已确认召回单（未确认的不自动冻结）。
- **旧数据追溯**：v2 前的道次与镶嵌记录无漆料批次，v3 升级与旧版备份导入时统一归一化为 `untraced`（页面显示「未追溯」），未追溯批次不能登记新领用。
- **localStorage**：仅存元数据 —— `gblacquer:db-version`（本地结构版本）、`gblacquer:last-backup-at`（最近导出时间）、`gblacquer:ui-prefs`（当前选中胎体）。
- **备份**：`/export` 页可导出 JSON（9 张表全量数据 + 结构版本号），导入时校验 `app` 字段与各核心集合数组完整性（v3 新增集合缺失时按空集合兼容），覆盖导入前二次确认；另有返工清单 TXT 与工序台账 CSV。
- **隐私与无状态**：数据不上传任何服务器，容器不挂载命名卷；清理浏览器站点数据或更换浏览器会丢失档案，请定期导出备份。

---

## 八、开发提示

- 类型检查与构建：`cd frontend && npm run build`（含 `tsc --noEmit`，必须零错误）。
- 事务行为验证（Node + fake-indexeddb，验证扣减回滚 / 对账 / 召回冻结 / 重启续处理 / 并发）：

  ```bash
  cd frontend
  npm install --no-save fake-indexeddb   # 仅验证时需要，不写入 package.json
  npx esbuild scripts/verify-paint.ts --bundle --platform=node --format=esm \
    --alias:@=./src --outfile=/tmp/verify-paint.mjs && node /tmp/verify-paint.mjs
  npx esbuild scripts/verify-tx.ts --bundle --platform=node --format=esm \
    --alias:@=./src --outfile=/tmp/verify-tx.mjs && node /tmp/verify-tx.mjs
  ```
- 端口一致性：开发服务器（`vite.config.ts`）、预览服务、compose 的 `FRONTEND_PORT` 默认值均为 `22818`。
- 若部署在中文路径下，`docker-compose.yml` 顶层的 `name: gblacquer` 可保证项目名不为空，`docker compose config --quiet` 不会报错。
- 容器运行阶段执行了 `RUN chmod -R a+rX /usr/share/nginx/html`，避免宿主机静态资源权限为 0600 时 nginx worker 读取失败返回 403。
