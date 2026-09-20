# 我的旅行攻略站

多目的地旅行攻略：一个首页列出所有目的地，点进去是那次旅行自己的完整页面。

- **纯静态** —— 只部署到 GitHub Pages，没有服务端、没有数据库。
- **模板共享** —— 所有目的地共用 `template/` 里 vendored 的同一套运行时，只换数据。
- **记账保留位** —— 记账模块的代码与槽位完整保留但一律关闭，后续一次性补入。

## 目录结构

```
travel-plans/
├── .claude/skills/
│   ├── travel-plan-site/SKILL.md              本站编排层 Skill（新增目的地走这里）
│   └── generate-lightweight-travel-page/
│       └── SKILL.md                           上游 Skill（软链 → template/SKILL.md）
├── template/                                  vendored 上游模板，只读
│   ├── index.html app.js ledger.js ...         共享运行时
│   ├── scripts/build-map.mjs                  底图生成的**前半段**（示意投影，见下）
│   └── trip-data.json                         空白底板
├── configs/
│   ├── trips.json                             目的地注册表（首页顺序/标题）
│   └── modules.json                           模块策略（记账=保留位）
├── trips/<slug>/                              一个目的地
│   ├── trip-data.json                         ← 唯一需要手写的数据
│   ├── SOURCE.md                              原始资料（生成输入，也会进站点）
│   └── assets/maps/regions/<region>.png       真实地图底图（构建时抓 OSM 瓦片拼出，入库）
├── home/site/                                 构建产物 = 要发布的静态站点（勿手改）
├── scripts/                                   本站工具链
│   └── lib/                                   mercator / tiles / mosaic / label-layout / build-real-map
├── .cache/tiles/                              OSM 瓦片缓存（可再生，已 gitignore）
├── logs/  reports/                            运行日志 / 报告
```

## 底图是怎么来的：两段式

`routeMap` **不再只有一个写入者**，每个区域经过两段：

1. `template/scripts/build-map.mjs`（上游）按**示意投影**摆放地点、划分区域与每日分组，
   写出一版 routeMap。它的 `separatePoints()` 会把靠近的点用力导向推开，**位置不反映真实地理**
   （首尔实测中位方位误差 29.9°）。
2. `scripts/lib/build-real-map.mjs`（本站）**保留第 1 步算好的结构**（区域划分、路线分段、
   配色、每日分组），只用真实经纬度重算几何：抓 OSM 标准瓦片拼底图、按 web-mercator
   重投影、重新求解标签位置。第 1 步的坐标全部被覆盖。

第 2 段必须挂在 `scripts/build-site.mjs` 的流水线内部（`rebuildMaps()` 之后）——
因为第 1 步每次构建都会**原地重写** `trip-data.json`，独立脚本会被下次构建静默还原。

地点没有真实经纬度（`map.places[].geo`）时，该目的地**降级**保留示意底图并告警，
而不是从站点消失（成都目前就是这种状态）。**给新目的地补 `geo` 就能自动升级到真实底图**，
不需要改代码。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run new -- --slug x --title "..." --dest "..." --start YYYY-MM-DD --end YYYY-MM-DD` | 新建目的地骨架并登记 |
| `npm run build` | 重建每个 trip 的 `routeMap`（示意 + 真实两段），组装 `home/site/`，生成首页 |
| `npm run check` | 结构自检（注册表/数据/模块/底图/产物） |
| `npm run verify:projection` | 校验地图**位置对不对**（方位角 + 距离尺度），`--baseline` 可对照改动前 |
| `npm run preview` | 本地预览 `home/site/` |
| `npm run patch` | 幂等地给 `template/` 打补丁（返回首页链接、点击热区、OSM 署名） |

## 加一个目的地

```bash
npm run new -- --slug chengdu --title "成都五日" --dest "成都" --start 2026-10-01 --end 2026-10-05
# 把资料整理进 trips/chengdu/SOURCE.md
# 按 .claude/skills/travel-plan-site/SKILL.md 把内容写进 trips/chengdu/trip-data.json
npm run build && npm run check && npm run preview
```

交给 Agent 时直接说：

> 帮我把 `trips/chengdu/SOURCE.md` 里的行程做成攻略页。

## 部署

产物是 `home/site/`，整目录即站点根。

```bash
npm run build
# 把 home/site/ 发布为 gh-pages 分支
```

或在 GitHub 仓库 Settings → Pages 里把 Source 指向承载 `home/site/` 内容的分支/目录。

`template/index.html` 里所有资源引用都是相对路径，所以站点可以放在任意子路径下（`https://<user>.github.io/<repo>/`）而无需改任何配置。

## 数据与隐私

- `trips/<slug>/SOURCE.md`、`trips/<slug>/assets/` 是**生成输入**，但 `assets/` 会被拷进
  `home/site/trips/<slug>/assets/`（底图就是靠这个发布出去的）——`SOURCE.md` 不进站点。
  两者都在 Git 仓库里 —— 若是公开仓库，等于公开。敏感资料不要提交，或改用私有仓库。
- 页面上的运行时数据（Todo 勾选、门票状态）只存在**访问者自己的浏览器 localStorage** 里，
  换设备不同步、清浏览器数据就丢。这是 GitHub Pages 无服务端下的必然结果。
- 不要把 `.env`、token、private key、任何数据库 ID 提交进仓库。

## 上游与许可

`template/` 派生自 [do-tongxue/Travel-Plan-Page](https://github.com/do-tongxue/Travel-Plan-Page)（MIT），
已剔除 legacy 的 `advanced/`、`references/advanced/`、`assets/boundaries/` 与两张 Demo 底图。
保留 `template/LICENSE` 与 `template/THIRD_PARTY_NOTICES.md`。修改记录见 `reports/`。

### OpenStreetMap 底图数据

真实底图由本站脚本从 OSM 公共瓦片服务抓取（`https://tile.openstreetmap.org/{z}/{x}/{y}.png`），
拼接后入库在 `trips/<slug>/assets/maps/regions/`。

- 数据许可：[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)，署名 © OpenStreetMap contributors。
- 署名在**每个地图视图**都可见（`scripts/patch-template.mjs` 打到 `.map-utility` 栏的链接），
  且只对真正用了 OSM 底图的区域显示 —— 仍是示意底图的目的地不挂假署名。
- 抓取是**礼貌**的：串行、每次请求间隔 1s、带可联系的 User-Agent
  （见 `scripts/lib/tiles.mjs`）。瓦片缓存进 `.cache/`（已 gitignore），不入库。
- 底图 PNG 与 `metadata.realMaps` 里的内容**指纹**一并入库，指纹没变就整段跳过抓取 ——
  所以 clone 后构建、以及 CI 构建都**不需要联网**（CI 里没有瓦片缓存）。

### 画布尺寸与一条休眠的上游不变量

真实底图模式下 `canvas` 由 `scripts/lib/mercator.mjs` 按各区域**真实宽高比**算出：
宽度固定 1448（沿用模板的字号/圆点等排版参数），高度 = 1448 / 宽高比，宽高比夹在 `[1.1, 3.4]`。
夹取只会让画布**多露出真实地图**，不会像拉伸那样让变形 —— 底图是
`preserveAspectRatio="none"` 的 `<image>`，所以底图宽高比必须与 `canvas` 严格一致。

⚠️ `template/scripts/validate-generation.mjs` 里有一条**硬性要求 canvas 恰好 1448×1086** 的校验。
它只挂在 `test-generation-pipeline.mjs` 上，**不在** `npm run build` / `check` 里，
所以改画布尺寸不会挡住构建 —— 但如果将来有人把这个测试接进 CI，会失败。
