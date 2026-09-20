---
name: travel-plan-site
description: 往本站新增/更新一个目的地旅行攻略页。当用户说"加一个 XX 攻略""把这份行程做成页面""更新 XX 的攻略"时使用。负责按 template/SKILL.md 生成 trips/<slug>/trip-data.json，并跑 build 生成静态站点。
---

# 旅行攻略站 · 目的地产线

这个仓库是一个**多目的地旅行攻略站**：首页汇总 + 每个目的地一个独立攻略页。
具体页面怎么装配，由 vendored 的上游 Skill 决定 —— 本文件只负责把上游 Skill 接到本站的目录结构上。

> ### ⚠️ 上游文档分两层，别照单全收
>
> 「已写进文档的规范」实际有**两层**，混着读会得出错误结论：
>
> | 层 | 文件 | 性质 |
> |---|---|---|
> | **上游层** | `template/SKILL.md` + `template/references/*`（14 个文件约 3100 行） | vendored。`references/` 里 **8/14 个文件自标「advanced / legacy / 仅作兼容保留」**，并与 `template/SKILL.md` 直接冲突 |
> | **本站层** | 本文件 | 真正装着「本站踩过的坑」的就是这一份 |
>
> 冲突是实打实的，例如模块数：
> `references/standard-generation-workflow.md` 列了**七个**模块（把 `tickets` 当独立模块），
> 而 `template/SKILL.md` 明写「**不得出现第七个模块**」「门票不是独立模块」。
> 照前者办事，会去写一个本站运行时根本不存在的 `modules.tickets`。
>
> **普通生成以 `template/SKILL.md` + 本文件为准。** `template/references/` 只在两者都没写、
> 且你确认该文件没自标 legacy 时才参考。
> 快速自查：`grep -inE "advanced|legacy|已废弃|deprecated" template/references/<文件>`，
> 头几行有「状态：Advanced/legacy…」就直接跳过。

## 角色分工（重要）

| 文件 | 角色 |
|---|---|
| `.claude/skills/generate-lightweight-travel-page/SKILL.md` | **上游 Skill（软链→`template/SKILL.md`）**，页面装配规则的唯一权威。开始写作前先完整读它。 |
| 本文件 | 本站的**编排层**：目录约定、构建命令、模块策略。 |
| `template/` | vendored 上游模板，**只读**。运行时 `index.html/app.js/*.js`、`ledger.js`、schema、`scripts/build-map.mjs` 都不要改。要改就走 `scripts/patch-template.mjs`（见坑 18）。 |
| `scripts/patch-template.mjs` | **改动 vendored `template/` 的唯一合法通道**：幂等、靠锚点、改动集中可审查，`npm run patch` 执行。加前端行为/样式一律走它，不要直接编辑 `template/`。 |
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
- **`map.places[]` 必须写 `geo: { lat, lng }`**（见下），否则该目的地只能停在示意底图。
- 目的地专属素材放 `trips/<slug>/assets/`，在数据里用相对 trip 的路径引用。
- 用户没给的内容留空数组，或在已启用模块里标「待补充」，**不要编造事实**；To Do 不要凭常识补充。

字段速查见上游 SKILL.md 的「首次写入字段速查」。

#### `map.places[].geo` 必须写：真实地图底图靠它

每个地点都要有**真实经纬度**：

```json
{ "id": "p-bukchon", "name": "Bukchon Hanok Village", "nameZh": "北村韩屋村",
  "geo": { "lat": 37.5826, "lng": 126.9830 }, ... }
```

有 `geo` 的目的地，`npm run build` 会抓 OSM 瓦片拼真实底图并按墨卡托重投影（见 README「底图是怎么来的」）。
**一个地点缺 `geo`，整个目的地就降级保留示意底图**（构建会打 WARN），而不是只丢那一个点。

- 坐标要**逐个查证**（OSM/Nominatim、官方地址），不要凭印象估 —— 底图是对的，
  坐标错了看起来就像地图错了。机场用航站楼、景区用入口/主门，别用整个景区的几何中心。
- 查完可用 `npm run verify:projection` 复核：它会逐对比较地图方位与真实方位，
  方位误差大说明坐标或投影有问题。注意它能查「相对位置自洽」，**查不出全部一起偏**。
- 一个地点都没有 `geo` 时构建不报错、只是降级 —— 所以新增目的地后请确认
  `verify:projection` 的输出里**没有**把它列进「未覆盖」。

#### `map.regions[]` 的拆分：决定地图画得多近

`geo` 决定「画在哪」，**区域划分决定「画多大」** —— 两者缺一不可。

同一个区域里的所有点共用一张底图和一套缩放，所以跨度很远的点会被压到看不清。
成都原来没有 `regions`（只有一个隐式区域），9 个点横跨 166km，缩放下
宽窄巷子↔人民公园只差 **6px**（圆点直径 30px），挤成一团。

拆法**跟随行程结构**（哪天在哪一带），并保证每个区域的跨度在几十公里以内：

```json
"regions": [
  { "id": "chengdu", "label": "成都市区", "countryCode": "CN",
    "heading": "CHENGDU / 成都市区", "description": "成都市区 1 日行程示意图" }
],
"defaultRegionId": "chengdu"
```

再给每个地点标 `mapRegionId`。三个注意点：

- 写 `regions` 数组就**别再写单数 `map.region`** —— 数组优先（`build-map.mjs:354`）。
- **补 `defaultRegionId`**，否则默认落在第一个区域。
  也别沿用旧的单区域 id（如 `chengdu-emei-leshan`），它已不存在，
  模板会回退到第一个区域，但校验会报 `Unknown default region`。
- **拆区会让「跨区的天」在每区只剩一段**，`scopedRoute()` 只保留最长的一段。
  如果某天的路线在该区只剩 1 个点（没有交通图标、还可能连出一条跨区假直线），
  是行程数据里**缺一个中转点**：补上真实的换乘站/机场。

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

   > **排查时别去看 `routeMap.regions[].routes[].scheduleItems`** —— 那个字段是空的，
   > 构建时被有意丢掉了（`build-map.mjs` 的 `mapDataForRegion()` 只挑 `day`/`color`/
   > `placeIds`/`paths`/`overviewPaths` 输出）。它是**生成物**，不是输入。
   > 你写的 `map.routes[].scheduleItems` 会被搬进
   > `routeMap.regions[].dailyLayouts[day].transport[].items`（图标实际读这里），
   > 所以核对图标有没有挂上，看这一层。
   >
   > 另一个坑（**已修，2026-09**）：`dailyLayouts[].places` 会**去重**（同一天回到起点只算一个点），
   > 但 `transport` 是按**未去重**的点序列算的 —— 往返日两者差一格。
   > `scripts/lib/build-real-map.mjs` 原来照去重后的 `places.slice(0, -1)` 重算 `transport`，
   > 于是往返日**最后一个路段的图标被悄悄丢掉**（韩国 Day 2、Day 3 都丢过，
   > 而且是「改完 `scheduleItems` 却看不见效果」的那种坑）。
   > 现在该脚本改用 `region.routes` 里未去重的序列重建，并以
   > 「段数 == 模板不变量」且「去重后 == `daily.places`」为采用条件，不满足就退回原行为。
   > 所以：**跨区裁剪后的点序列在 `routeMap.regions[].routes[].placeIds` 里，是未去重的**，
   > 排查图标丢失时对比这两处即可。

   多国行程另有讲究：`trip.primaryDestinationCountries` 有多个国家时，
   `build-map.mjs` 会**按国家自动拆成多个 region**（每个国家一张独立底图与页签）。
   国与国之间不能连线——跨国的 route 会自动断成两段。

5. **`map` 与 `config` 各自有独立的 `schemaVersion`，别跟着根节点一起改。**
   根节点是 `"2.0-lite"`，而 `config.schemaVersion` 是 `"1.0.0"`、`map.schemaVersion` 是 `"1.0-lite"`。
   用 sed 全局替换 `schemaVersion` 会把子节点一起改坏。

6. **顶层有一半字段根本不显示在页面上 —— 写数据前先看下面这张表。**
   模板只渲染一部分字段，其余在 `home/site/trips/<slug>/trip-data.json` 里躺着、**永远不进 DOM**。
   最容易踩的是 `issuesAndUncertainties`：它看起来是「待确认事项」的正式去处，
   写进去却一个字都不会出现在页面上 —— 于是页面呈现出一份「看起来很确定」的行程，
   而作者以为已经把不确定处标出来了。

   | 会显示 | 怎么显示 |
   |---|---|
   | `days[].schedule[].{time,text,type}` | 日程项正文（`text` 是唯一可写长文的地方） |
   | `days[].notes[]` | 该日卡片底部的细节说明 |
   | `days[].costReferences[]` | 费用标签（`item · CUR amount`，`app.js:371 costText`） |
   | `ticketPlanning.items[].{name,requirement,guidance[],officialUrl}` | 门票卡 + 弹窗；`guidance` 用「·」连接，`officialUrl` 渲染成可点链接 |
   | `preTrip.todoItems[]` | 出行前准备清单（可勾选，存 localStorage） |
   | `flights[]` / `flightJourneys[]` | 航班模块 |
   | `mapLinks.navigationPlaces[]` | 日程项上的 📍 导航按钮 |
   | **不显示** | **原因** |
   | `issuesAndUncertainties` | 契约文档写明「是否渲染由 Config/Core 能力决定」，本模板没有这个能力；`app.js` 从不读它 |
   | `accommodations` / `bookingsAndTickets` | 同样不被 `app.js` 读取（`bookingsAndTickets` 只被 `validate-lite.mjs` 校验存在性） |
   | `ticketPlanning.items[].price` | **弹窗只渲染 `requirement`/`guidance`/链接**，`price` 读了但不输出 —— 票价要写进 `guidance[]` 或该日的 `costReferences[]` |
   | `groundTransport.*` | `driving=false` 时不渲染；日程里的交通方式请写进 `schedule[].text` |

   推论：**「待补充」「需现场确认」这类话必须写进 `days[].notes[]` 或 `preTrip.todoItems[]`**，
   写进 `issuesAndUncertainties` 等于没写。

7. **查证结果要可点、可复核，就把出处放进 `guidance` / `notes` / `officialUrl`。**
   模板没有通用的「来源」字段，但 `ticketPlanning.items[].officialUrl` 会渲染成
   「打开官方页面 ↗」，是放官网链接的天然位置。价格、班次、开放时间这类会变的事实，
   写进 `notes`/`guidance` 时**带上查证日期**（如「2026-09 查证」），
   否则半年后没人分得清哪些还成立。

8. **`schedule[].type` 有固定词表，不认识的一律静默画成汽车图标。**
   `route-ui.js` 的 `transportIcon()` 末尾是 `icons[key] || icons.drive`。
   图标只有 7 种：`drive / cable-car / train / hike / boat / rental-car / flight`；
   别名只有 `rail→train`、`ferry→boat`、`walk→hike`、`return|transfer→drive`。
   **`attraction` / `restaurant` / `shopping` / `check-in` 都不在表里** ——
   把这类日程项的 id 填进 `map.routes[].scheduleItems`，地图上会长出一个**汽车图标**，
   弹窗文案还退化成「交通 · 20:00」。
   → **`scheduleItems` 里只该放真正的交通项**（把「到了之后干什么」填进「怎么过去」的槽位是典型误用）。
   排查时把每个图钉的 `type` 对着上面这张表核一遍；全仓库核对过一次是 33+7 个图钉零违规。

9. **`dayCard()` 按 `schedule` 数组顺序渲染，不按 `time` 排序。**
   `app.js` 里是 `day.schedule.map(...)`，**没有排序**。数组顺序错了页面就错了，
   哪怕每一项的 `time` 都写对了。改顺序 = 挪数组元素。
   典型症状：出现「人还在 A 地就先吃 B 地的晚饭」这种自相矛盾的行程。

10. **`schedule[].time` 必须单调递增**（真实跨零点除外，如 23:20 → 01:10）。
    这条可以自动化 —— 值得作为 `check.mjs` 的一条断言。

11. **「文本声称的用时」要与「相邻两项的时钟差」交叉核对。**
    这是**唯一**能发现排程不可行的办法：写行程时同时写用时和时刻，写完回头比一遍。
    韩国行程靠这条查出 4 处「正文写了 40–55 分钟的路，时刻表只给 30 分钟」。
    改法是**推后到站时刻**（出发时刻通常是锚点，不要动）。

12. **`escapeHtml` 作用于所有正文 → 富文本一律无效。**
    字面 `**加粗**` 会原样显示成星号，行内代码、Markdown 列表同理。
    上游文档只说了「escaped text」，**没有任何一处写「不支持 Markdown」** —— 是个无预警的坑。
    写数据时别用 Markdown；提交前可全量扫一遍 `**`。

13. **`costText()` 有两种静默退化，且 `cost.note` 根本不进 DOM。**
    - cost 既无 `amount` 也无 `standard` 时 → **只渲染条目名，连币种都不显示**。
      所以「需购票但官方未公布票价」**不能**写成一条 cost。
    - **`cost.note` 从不渲染** —— 所有口径冲突、出处、备注写进 `note` 等于丢掉，
      必须写进 `days[].notes[]`。
    - 同类的还有 `ticketPlanning.items[].price` 也不渲染（见坑 6）。

14. **`ticketRequirement()` 的合法枚举，全仓库没有任何文档给出。**
    实现是 4 档：`advance-required`（需提前购票）/ `advance-recommended`（建议预约）/
    `needs-confirmation`（购票方式待确认）/ `onsite-purchase`（现场购票，无需预约 —— **本站新加**）。
    **其余任何值都静默回退成「门票信息」。** 上游合同只把 `requirement` 写成自由的 `enum/string`，
    写中文或别的值不报错、只是降级。

15. **反向误导：`costReferences` 在上游合同里被标成 `[DERIVED]`，实际是作者手写输入。**
    `references/travel-data-contract.md` 把它和 weekday/locations 并列成派生字段，
    但 `app.js` 是**直接读 `day.costReferences`**。照合同办事的 Agent **根本不会写这个字段** ——
    于是页面上一整块费用标签凭空消失。以本文件坑 6 的「会显示」表为准。

16. **lite schema 几乎什么都不校验。**
    `template/schemas/trip-data.schema.json` 里 `config` / `map` / `routeMap` 是**空对象**（不约束），
    `ticketPlanning` / `costReferences` / `countries` **完全没声明**，`days[].schedule` 只声明是数组。
    → 字段名写错、`type` 写了表外的值、`requirement` 写了不存在的档，**校验都抓不到**。
    上面这一串「静默坑」的根因就在这里。别指望 schema 兜底，按本文件的表逐项核。

17. **本站没有 `build:map` / `validate` 这两个命令。**
    它们只存在于 `template/package.json`。仓库根用 `build` / `check` / `verify:projection` / `patch`。
    同理预览 banner 文案也不同：本站是 `Travel plans preview:`，不是上游的
    `Travel plan local preview:` —— 照上游文案去 grep 会找不到。

18. **`scripts/patch-template.mjs` 是改 vendored `template/` 的唯一通道。**
    幂等靠注释标记 / 锚点定位，`npm run patch` 执行，改完必须 `npm run build` 才到得了各 trip。
    新增前端行为/样式都走它（门票档位、模块 tab 条都是这个模式），不要直接编辑 `template/`。
    - **新写的运行时文件必须同时在两处登记**：`patch-template.mjs` 里写出它，
      **并且**加进 `scripts/lib/paths.mjs` 的 `RUNTIME_FILES` —— 白名单漏了就**不会拷进站点**，
      页面静默没有这个功能，构建不报任何错。
    - **用 `build:xxx` 标记包裹的块要按「内容」比对替换，不能只判「标记在不在」。**
      只判标记的话，标记写进去之后你再改常量里的内容就**永远不生效**（跑多少次都是「无变化」）。
      `upsertBlock()` 就是为此写的。

19. **`npm run build` 会原地重写每个 trip 的 `trip-data.json`** —— 至少动
    `metadata.realMaps.<region>.generatedAt` 三个时间戳（每条真实底图一个），并重算 `routeMap`。
    于是**只要 build 过，没动过的那些目的地也会出现在 `git status` 里**。
    **提交前先 `git checkout` 掉与本次改动无关的目的地**，否则每个 commit 都带上别的 trip 的
    无意义 diff，review 时看不出真正改了什么。

20. **CSS 层叠顺序：`index.html` 先加载 `styles.css`、后加载 `ledger.css`，
    同特异性下 `ledger.css` 胜。** 要覆盖模板既有样式，写进 `ledger.css`（或提高特异性）；
    写进 `styles.css` 会被原规则**静默盖掉** —— 不报错、只是不生效。
    （模块 tab 条的样式就是因此写在 `ledger.css` 里的，见坑 21。）

21. **顶部模块 tab 条是补丁产物，动它之前先读 `scripts/patch-template.mjs` 里的注释。**
    三条硬约束：
    - **`<main>` 上有一条 `overflow: hidden`**（`styles.css`）。`overflow:hidden` 的祖先会成为
      sticky 的滚动容器，导致**其后代的 `position: sticky` 完全失效** ——
      tab 条因此必须放在 `</header>` 之后、`<main>` 之前。
    - **每个 tab 必须带 `data-module`，外层容器必须保留 `class="travel-navigation-menu"`、
      外层节点必须保留 `id="travel-navigation"`。** `app.js` 靠前者按 `config.modules` 逐项显示，
      靠后者判断「一个模块都不剩就整条隐藏」。改属性名会让「按 config 自动出 tab」失效。
    - **`.section` 的 `scroll-margin-top` 必须 ≥ 顶栏 + tab 条高度**，否则点 tab 后标题被吸顶条盖住。
      本站已改成 `calc(48px + safe-top + tab条高 + 8px)`（顺带修掉上游漏算 `--safe-top` 的问题）。

22. **事实纪律（用户明确要求）：核不到官方来源的，写「待核实」并留待办，
    绝不填看起来合理的推测数字。**
    特别注意**不要反向编造**：「没查到票价」≠「免费」。查不到就写「未核到官方数字，
    行前请自行确认」，**不要**写成「免门票」。同理「没查到封闭公告」只能写「没查到」，
    不能断言「无封闭」。核到之后再把占位替换成实数，并写明来源与查证日期（见坑 7）。

### 3. 构建

```bash
npm run patch             # 幂等地给 vendored template/ 打补丁（只在改过 patch 脚本时才需要）
npm run build             # 重建 routeMap + 生成 home/site/
npm run check             # 结构自检，看 WARN/ERROR
npm run verify:projection # 校验地图位置对不对（有 geo 的目的地应全部 ✅）
```

`npm run patch` 幂等（连跑两次第二次应全部「无变化」），**改完 template/ 的补丁必须重新 build**
才到得了各 trip。平时加目的地不需要跑它。

`npm run build` 分两段重建 `routeMap`：先用 `template/scripts/build-map.mjs` 做**示意投影**
（定区域划分与路线分段），再由 `scripts/lib/build-real-map.mjs` 用真实经纬度**重算几何**
（抓 OSM 瓦片拼底图 + 墨卡托重投影 + 重新求解标签）。第二段必须留在流水线内部 ——
第一段每次构建都会原地重写 `trip-data.json`。详见 README「底图是怎么来的：两段式」。

然后把站点组装到 `home/site/`。**不要手写 `home/site/` 里的任何文件** —— 它是产物，每次 build 整个重建。

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
5. **地图位置是不是真的**：确认每个区域的底图是真实地图（能看到真实路网/海岸线/河流），
   地点落在该落的地方 —— 例如机场在图上的海边、江两岸的点分别在江两侧。
   再跑 `npm run verify:projection`，有 `geo` 的区域应全部 ✅ 且不出现在「未覆盖」里。
6. **标题有没有压到地点标签**：`verify:projection` 管的是「点摆得对不对」，
   **不管标题**。标题是「英文名 / 中文名」，目的地名字一长就会伸进标签区 ——
   求解器按 `reserved` 盒避让，盒子宽度由 `chromeBox()` 按真实字宽算，
   但**只有肉眼能确认结果**。切到每个区域的总览看一眼标题右侧有没有文字压上来。
   （真实案例：成都「CHENGDU / 成都市区」实测 396px，模板默认只给它 300px，
   于是 人民公园 / 太古里 两个标签被标题压了 22px、24px 而所有自动化检查都是绿的。）
7. **顶部 tab 条**：tab 数应等于 `config.modules` 里为 `true` 的项数（记账关了就不出「记账」）；
   逐个点一遍，跳到的 section 顶部**不能被吸顶条盖住**；滚到某模块时该 tab 才高亮。

需要自动化时，可以用无头浏览器把上面几条断言跑一遍 —— 但**断言要盯着真实 DOM**：
`elementFromPoint` 用视口坐标，元素不在视口里会一直返回 `null`（看起来像「热区没生效」，
其实是测试自己没滚到位）；在 headless 里 `window.scrollBy` 有时不生效，
更稳的做法是单开一个高视口（如 390×3000）页面，宽度仍按真机，整页一屏放得下。
另外**元素盒尺寸不等于可点范围**：模板用 `::before` 透明热区扩大命中区，
量 `.getBoundingClientRect()` 会得到偏小的结论。

> **测滚动行为不要用 `chrome --dump-dom`。** 那个模式没有合成器，`window.scrollTo` /
> `scrollIntoView` 全是**空操作**（`scrollY` 恒为 0，页面看起来「没滚动」），
> 而 `--virtual-time-budget` 也推不动 CSS 的 `scroll-behavior: smooth`。
> 结果是**测量值全是假的**，很容易据此「修」一个并不存在的问题。
> 正确做法是走 CDP（`--remote-debugging-port` + `Page.navigate` + `Runtime.evaluate`），
> 并在页面里先把 `document.documentElement.style.scrollBehavior = "auto"` 关掉平滑滚动。
> 顺带：`--window-size` 在无头下有 ~500px 的最小宽度，要测 360/390 这种真机宽度，
> 得用 `Emulation.setDeviceMetricsOverride`。

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

- 不要直接编辑 `template/` 下的运行时文件（`index.html`、`app.js`、`*.js`、`*.css`、`schemas/`、
  `scripts/`）—— 那是共享的，会影响所有目的地；而且下次 `npm run build` 前没人知道它被手改过。
  **要改就走 `scripts/patch-template.mjs`**（见坑 18）；纯目的地专属的东西一律写进 `trips/<slug>/`。
- 不要开启 `ledger`，不要为记账准备数据。
- 不要引入后端、数据库、`/api/` 任何东西。
- 不要把私有原始资料（`SOURCE.md`、`trips/*/assets/` 里未授权的文件）拷进 `home/site/`。
- 不要提交 `.env`、token、private key。
- 不要提交 `template/optional/` 里的任何东西（本站已移除 D1 可选件，只留 GitHub Pages）。
- 不要在 `costReferences[].note` 或 `issuesAndUncertainties` 里写「待确认」—— 这两处都不进 DOM（坑 6、13）。
