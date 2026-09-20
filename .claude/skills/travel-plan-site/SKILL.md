---
name: travel-plan-site
description: 往本站新增/更新一个目的地旅行攻略页。当用户说"加一个 XX 攻略""把这份行程做成页面""更新 XX 的攻略"时使用。负责按 template/SKILL.md 生成 trips/<slug>/trip-data.json，并跑 build 生成静态站点。
---

# 旅行攻略站 · 目的地产线

这个仓库是一个**多目的地旅行攻略站**：首页汇总 + 每个目的地一个独立攻略页。
具体页面怎么装配，由 vendored 的上游 Skill 决定 —— 本文件只负责把上游 Skill 接到本站的目录结构上。

## 角色分工（重要）

| 文件 | 角色 |
|---|---|
| `.claude/skills/generate-lightweight-travel-page/SKILL.md` | **上游 Skill（软链→`template/SKILL.md`）**，页面装配规则的唯一权威。开始写作前先完整读它。 |
| 本文件 | 本站的**编排层**：目录约定、构建命令、模块策略。 |
| `template/` | vendored 上游模板，**只读**。运行时 `index.html/app.js/*.js`、`ledger.js`、schema、`scripts/build-map.mjs` 都不要改。 |
| `configs/modules.json` | 本站模块策略（哪些模块启用、记账为保留位）。 |
| `trips/<slug>/` | 一个目的地。**你唯一该写的地方。** |

## 模块策略

六项模块与上游一致：`flights / overview / itinerary / driving / todo / ledger`。

- 前五项按用户资料正常开合。
- **`ledger`（记账）是保留位，一律写 `false`。** 实现（`template/ledger.js`、`ledger.css`）、schema 槽位、runtime collection 都随模板完整保留，但不要开启、不要展示、不要为它准备数据。用户会最后一次性补入。
  - 上游 `SKILL.md` STEP 3 的六个模块清单里会把「记账」列进去 —— 在本站**跳过它**，只确认前五项。
  - 不要删除 `ledger.js` / `ledger.css` / `index.html` 里的 ledger 节点，也不要动 `app.js` 里的 `MODULE_NAMES`。关掉开关即可（`config.modules.ledger = false` 时 `<a id="ledger-navigation-link">` 和 `#ledger-view` 会自动 `hidden`）。
- **`config.persistence.mode` 恒为 `"local"`。** 本站只部署到 GitHub Pages（纯静态、无服务端），不要写 `d1`、不要引用 `/api/trip`、不要引入任何后端。

## 新增一个目的地

### 1. 搭骨架

```bash
npm run new -- --slug <slug> --title "<标题>" --dest "<主要目的地>" --start YYYY-MM-DD --end YYYY-MM-DD
```

`slug` 用小写字母/数字/连字符，作为目录名与 `metadata.tripId`，**一旦上线不要再改**（改了会让访客浏览器里已存的 Todo/门票状态失联）。

产出：
- `trips/<slug>/trip-data.json` —— 从空白底板派生
- `trips/<slug>/SOURCE.md` —— **把用户给的原始资料整理到这里**（生成输入，不进站点）
- `trips/<slug>/assets/` —— 专属素材（门票 PDF、专属底图）
- 注册进 `configs/trips.json`

### 2. 读资料 → 按上游 Skill 写入 trip-data.json

完整读 `.claude/skills/generate-lightweight-travel-page/SKILL.md`，按它的 STEP 1–5 执行：

- **STEP 3 的模块确认**：只确认前五项，跳过记账。
- **STEP 5 只写一份输入**：只改 `trips/<slug>/trip-data.json`。禁止手写 `routeMap`、SVG path、地图坐标（那是 `build-map.mjs` 的活）。
- 目的地专属素材放 `trips/<slug>/assets/`，在数据里用相对 trip 的路径引用。
- 用户没给的内容留空数组，或在已启用模块里标「待补充」，**不要编造事实**；To Do 不要凭常识补充。

字段速查见上游 SKILL.md 的「首次写入字段速查」。

### 本站实测踩过的坑（务必遵守）

下面这些都会**静默**产生错误的页面，不报错，所以单列出来：

1. **`trip.countries` 是对象数组，且 `primaryDestinationCountries` 要配套写。**
   上游的 lite schema 没有声明 `countries` 字段，但 `app.js` 的 `heroDestinationFor()` 依赖它：

   ```json
   "trip": {
     "countries": [{ "code": "CN", "nameZh": "中国", "nameEn": "China" }],
     "primaryDestinationCountries": ["CN"],
     "primaryDestinationName": "成都"
   }
   ```

   `countries` 若写成字符串数组（`["中国"]`），或 `primaryDestinationCountries` 漏写、写了非 `CN` 的值，
   `isDomestic` 判定失败 → Hero 标题会**静默退化成「目的地待补充」**。国内行程必须 `code: "CN"`。

2. **`day.locations` 是给人看的地名，不是 ID。**
   `app.js:481` 把 `day.locations` 直接 `join(" → ")` 后 `escapeHtml`，**不做任何 ID 解析**。
   写成 `["p-tianfu","p-kuanzhai"]` 会原样显示成 `p-tianfu → p-kuanzhai`。

   | 字段 | 语义 | 写法 |
   |---|---|---|
   | `day.locations[]` | 展示用 | `["天府广场","宽窄巷子"]` |
   | `day.schedule[].placeId` / `placeIds[]` | ID 引用（用于地图联动） | `"p-tianfu"` |

3. **`trip.dayCount` 要和 `days.length` 一致**（否则 Hero 与行程区显示的 DAYS 数对不上）。

4. **地图要「每天一个日期页签」、每天要有交通图标 —— 关键全在 `map.routes`。**

   ```jsonc
   "map": {
     "mapMode": "template-auto",        // 必须写这个值，写 frozen-template 会直接构建报错
     "region": { "id": "...", "label": "...", "countryCode": "CN" },
     "places": [ { "id": "p-x", "countryCode": "CN", ... } ],
     "routes": [                        // ← 一个元素 = 一个日期页签
       { "day": 1, "placeIds": ["p-a","p-b"], "scheduleItems": [["d1-01"]] },
       { "day": 2, "placeIds": ["p-b","p-c"], "scheduleItems": [["d2-01"]] }
     ],
     "dailyRoutes": []                  // 留空即可，build 会回退用 routes 当每日布局
   }
   ```

   | 现象 | 原因 |
   |---|---|
   | **只有一个日期页签（或没有）** | `map.routes` 只写了一条，或只写了 `day: 1` |
   | **当天地图上没有交通图标** | 该 route 没写 `scheduleItems`；`route-ui.js:111` 拿不到行程项就返回空字符串 |
   | 某天的地图上地点缺失 | `map.places` 里对应条目缺 `countryCode` / `mapRegionId`，被 region 过滤掉了 |
   | 构建直接报错 `map.mapMode must be template-auto` | `mapMode` 写成了别的值 |

   `scheduleItems` 是**路段数组**，长度必须等于 `placeIds.length - 1`；
   第 i 项填该路段对应的 `day.schedule[].id`（写成数组形式）。本仓库的
   `trips/chengdu-emei-leshan/` 是一份把 5 天全部铺满的参考样本。

   多国行程另有讲究：`trip.primaryDestinationCountries` 有多个国家时，
   `build-map.mjs` 会**按国家自动拆成多个 region**（每个国家一张独立底图与页签）。
   国与国之间不能连线——跨国的 route 会自动断成两段。

5. **`map` 与 `config` 各自有独立的 `schemaVersion`，别跟着根节点一起改。**
   根节点是 `"2.0-lite"`，而 `config.schemaVersion` 是 `"1.0.0"`、`map.schemaVersion` 是 `"1.0-lite"`。
   用 sed 全局替换 `schemaVersion` 会把子节点一起改坏。

### 3. 构建

```bash
npm run build      # 重建 routeMap + 生成 home/site/
npm run check      # 结构自检，看 WARN/ERROR
```

`npm run build` 会用 `template/scripts/build-map.mjs` 为每个 trip 重建 `routeMap`，然后把站点组装到 `home/site/`。**不要手写 `home/site/` 里的任何文件** —— 它是产物，每次 build 整个重建。

### 4. 预览

```bash
npm run preview    # 起静态服务器，终端会打印实际地址（含首页）
```

从终端输出的 `Travel plans preview:` 后取真实 URL 验证：首页能打开、新目的地卡片能点进去、已启用模块可见、地图正常、无控制台报错。

### 5. 验收（新增目的地时至少做到这一步）

写数据时最容易漏的恰恰是「看不到的东西」—— 页签数量、交通图标、角色标注，
这些错了页面不报错，只是静静地少一块。所以不要只看「页面能打开」：

1. 打开目的地页，**把地图的每个日期页签都点一遍**，确认：
   页签数与 `days.length` 一致、每天都有地点圆点、相邻地点之间有交通图标、
   点图标能弹出路段详情（自驾/火车/索道…）。
2. 展开一两天的日程卡，确认日程项、门票勾选、地图快捷按钮、费用标签都在。
3. 桌面（1440）与手机（390）各看一遍，手机重点看地图是否横向溢出、圆点是否点得中。
4. 控制台无报错、无 404。

需要自动化时，可以用无头浏览器把上面几条断言跑一遍 —— 但**断言要盯着真实 DOM**：
`elementFromPoint` 用视口坐标，元素不在视口里会一直返回 `null`（看起来像「热区没生效」，
其实是测试自己没滚到位）；在 headless 里 `window.scrollBy` 有时不生效，
更稳的做法是单开一个高视口（如 390×3000）页面，宽度仍按真机，整页一屏放得下。
另外**元素盒尺寸不等于可点范围**：模板用 `::before` 透明热区扩大命中区，
量 `.getBoundingClientRect()` 会得到偏小的结论。

## 首次生成只做轻量校验

与上游一致：数据可读、页面能载、模块显示、地图生成、无明显运行错误即可。
上面第 5 条是本站的验收底线；逐项事实复核与边界场景验收按需再做。

## 交付话术

生成并验证后，向用户报告：

- 首页地址
- 该目的地的直达地址（`trips/<slug>/`）
- 已开启的模块
- 缺失/待补充项

如需公开分享，提示：GitHub Pages 是公开站点，页面内容任何拿到链接的人都能看到；若含订单号、门禁密码、私人地址等，发布前自行决定是否处理。

## 绝对不要做

- 不要把 `template/` 下的运行时文件（`index.html`、`app.js`、`*.js`、`*.css`、`schemas/`、`scripts/`）改成站点专属的样子 —— 那是共享的，会影响所有目的地。
- 不要开启 `ledger`，不要为记账准备数据。
- 不要引入后端、数据库、`/api/` 任何东西。
- 不要把私有原始资料（`SOURCE.md`、`trips/*/assets/` 里未授权的文件）拷进 `home/site/`。
- 不要提交 `.env`、token、private key。
- 不要提交 `template/optional/` 里的任何东西（本站已移除 D1 可选件，只留 GitHub Pages）。
