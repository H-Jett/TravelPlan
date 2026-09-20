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

## 用户定过的硬规矩

下面这些不是「踩过的坑」，是用户明确提的要求。**它们此前只散落在对话里，没进过任何文档** ——
所以单列一节，避免下一个人（或下一次会话）凭「看起来合理」自行发挥。

1. **只部署 GitHub Pages，不要 Cloudflare，也不要别的托管。**
   ⚠️ **上游 `template/SKILL.md` 的「生成结束提示」里恰好推荐了
   `GitHub → Cloudflare Pages → Cloudflare D1` 那条路线** —— 与本条**正好相反**。
   照上游文案办事会去配一个用户明确不要的东西。本站只走 `.github/workflows/pages.yml`（main → Actions → Pages）。
   这条也是「纯静态、无服务端」总约束的由来，记账只能 `local` 同理。
2. **首页是攻略列表**（每个目的地一张卡片），点进去才是那个地方的完整攻略。
   首页不是 README，也不是把某一份攻略摊开在根路径。
3. **Skill 必须装在仓库里。** 攻略是「用仓库内的 skill 产出的」，不是一次性的手写页面 ——
   所以规则要回写到本文件，而不是留在会话里。
4. **手机和电脑都要能用。** 每个目的地页至少按 1440 与 390 两个视口各看一遍（见验收第 3 条）。
5. **每天都要有一张地图**（日期页签），不是整个行程共用一张总图。见坑 4。
6. **改完就 push。** ⚠️ 与全局 `CLAUDE.md` 的「除非我说了要推，否则只 commit 不 push」**冲突** ——
   用户 2026-09-20 为本站明确开了例外（起因是「首页没显示这次攻略」实为改动没上线）。
   **本仓库不适用「只 commit 不 push」。**
7. **三个已被用户拍板的取舍，别再自行改回去：**
   - **允许 `pngjs` 作为唯一的第三方依赖** —— 拼真实底图要解码/编码瓦片。
     仓库不再是零依赖，`npm ci` 是必需的（CI 里已加）。
   - **允许残留小于 40px 的标签间距**，优先保**方位正确**（首尔 day7 曾有 7 对点间距 <40px，最近 15px）。
     这是**知情后的接受**，不是待修的缺陷。
   - **地图画布按真实宽高比**，不许拉伸（机制见 README 第 127-130 行；`preserveAspectRatio="none"` 要求严格一致）。

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
   | `days[].schedule[].notes[]` | 日程项上的「注意事项」入口 + 弹窗（`{kind,label,text}`，见坑 24） |
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

   推论：**「待补充」「需现场确认」这类话必须写进 `schedule[].notes[]`（坑 24）、
   `days[].notes[]` 或 `preTrip.todoItems[]`**，写进 `issuesAndUncertainties` 等于没写。

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
    （顶部导航的样式就是因此写在 `ledger.css` 里的，见坑 21。）

21. **顶部模块导航是补丁产物，动它之前先读 `scripts/patch-template.mjs` 里的注释。**
    **形态由用户定型：导航在顶栏里、靠右，与 wordmark（页面上显示的「KR · 2026」）同一行，
    全站只有这一行导航 —— 不要另起一条独立的吸顶 tab 条。**（用户 2026-09-20 明确要求，
    此前一版做的顶栏下方独立吸顶条被否掉。）

    放在 `<header class="topbar">` 里是**有意的**，不是随手：顶栏本身就是
    `position: sticky; top: 0`，放进去的东西天然常驻，不必再写第二条 sticky，
    也就省掉了「第二条的高度」这笔账（`--module-tabs-h`、`.ledger-view` 高度补偿都不需要）。
    三条硬约束：
    - **不要把它挪进 `<main>`。** `<main>` 上有 `overflow: hidden`（`styles.css`），
      `overflow:hidden` 的祖先会成为 sticky 的滚动容器，**其后代的 `position: sticky` 全部失效**。
    - **每个链接必须带 `data-module`，外层容器必须保留 `class="travel-navigation-menu"`、
      外层节点必须保留 `id="travel-navigation"`。** `app.js` 靠前者按 `config.modules` 逐项显示，
      靠后者判断「一个模块都不剩就整块隐藏」。改属性名会让「按 config 自动出导航」失效。
      ⇒ **`config.modules` 里 `false` 的模块自动不出现在导航里**（韩国 `driving:false` 就没有「自驾」）。
    - **`.section` 的 `scroll-margin-top` 必须 ≥ 顶栏高度**，否则点导航后标题被吸顶顶栏盖住。
      本站写成 `calc(48px + var(--safe-top) + 8px)` —— 上游只写了 `48px`，**漏算了安全区**。
    - 作者样式里的 `display:flex` 会盖掉 `hidden` 属性自带的 `display:none`，所以
      `#travel-navigation[hidden]` 必须显式补一条（用 id 选择器，不必 `!important`）。
    - 顶栏是 `justify-content: space-between` 的两列布局：新增第三个子元素会挤压 wordmark，
      所以 wordmark 要加 `flex: 0 0 auto`，导航要能收缩 + `overflow-x: auto`。
      实测六个链接全开的**最坏**情况在 320~1440px 都不溢出（320px 仍有 7px 间距）。

22. **事实纪律（用户明确要求）：核不到官方来源的，写「待核实」并留待办，
    绝不填看起来合理的推测数字。**
    特别注意**不要反向编造**：「没查到票价」≠「免费」。查不到就写「未核到官方数字，
    行前请自行确认」，**不要**写成「免门票」。同理「没查到封闭公告」只能写「没查到」，
    不能断言「无封闭」。核到之后再把占位替换成实数，并写明来源与查证日期（见坑 7）。

23. **`schedule[].text` 里不要复述本项或相邻项已有的时刻、也不要解释时差。**（用户 2026-09-21 要求）
    时间点本身就渲染在左边（`<span class="schedule-time">`），「在路上」模块的交通卡
    本来就渲染航班号 / 承运方 / 起降机场 / 日期 / 起降时刻 —— **正文再写一遍就是纯噪音**。
    用户点名的样例：

    > 韩国比中国快 1 小时：MU2018 按韩国时间 14:15 起飞，按中国时间 14:40 落地威海，飞行约 1 小时 25 分。
    > MU9788 于 10/5 23:20 从威海起飞、10/6 01:10 抵达南京禄口 T2，行程按 10/5 结束计。

    这类句子的共同特征：**说的东西页面上已经有了**。逐条清掉的有：
    - 时差解释（「济州比南京快 1 小时（韩国 UTC+9）」）与同一时刻按两个时区各写一遍；
    - 交通项正文里复述本项起降/发到时刻与总时长（「16:40 起飞、17:40 抵达」「车程 2 小时 23 分」）；
    - 日期归属说明（「行程按 10/5 结束计」——卡片上就写着日期）；
    - 同一条里把同一件事写两遍（韩国 d6-03 的「平季末班 19:30」出现两次）。

    ⚠️ **同一份数据里还有两处也要清**，很容易漏：
    `flights[].notes[]`（`flightCard()` 其实**完全不渲染**它，但数据不该说谎）与
    `ticketPlanning.items[].guidance[]`（这个**会**渲染进门票弹窗）。

    **保留判据：这条信息能不能让你少跑一趟、少等一班、多带一样东西？**
    - 留：航程时长（卡片上只有起降时刻，没有时长）、代码共享、机型、出票状态、票款、
      班距 40–77 分钟、末班车/末班船时刻、「18:25 到站、距 19:12 发车还有 45 分钟余量」
      这类缓冲推算、票价与票档、开放时间与休馆日。
    - 删：任何「把卡片上的数字用中文再说一遍」的句子。
    - 顺手修掉折叠留下的指代不明（「上面这个票价」→「船票价格」、「上面这条天空步道」→
      「松岛天空步道」）—— 正文搬家之后，「上面」指向的可能是另一条时间点。

24. **`schedule[].text` 只写行程主干，注意事项拆进 `schedule[].notes[]`（弹窗）。**
    （用户 2026-09-21 要求：「每个时间点先写行程，然后再写注意事项，弄成弹窗的形式，
    然后需要精简内容并且结构化」。设计是用户在两轮选项里拍板的。）

    ```jsonc
    { "id": "d2-02", "time": "09:30", "type": "transfer",
      "text": "抵达城山港，在 우도가는배 售票处买牛岛往返船票。",   // ← 只留「去哪/怎么去/多久」
      "notes": [
        { "kind": "alert", "label": "排队",     "text": "中秋连休收尾 + 周日，建议 09:00 前到售票处。" },
        { "kind": "price", "label": "成人往返", "text": "11,000 KRW（去程 6,000 = 船费 5,000 + 道立公园 1,000）。" },
        { "kind": "info",  "label": "证件与购票", "text": "必须出示护照；无线上预约，现场买票。" }
      ] }
    ```

    **契约：**
    - `kind` 三档：`alert` ⚠注意 / `price` 💰票价 / `info` ℹ说明。
      弹窗**按这三档分组、固定顺序**渲染，每组上方一条带分隔线的小标题。
      表外的 `kind` **不丢弃**，静默归入 `info`（说明组）——所以打错字不会丢数据。
    - `label` 是**短标题**（正文左侧那一栏，宽 86px）→ **控制在 8 个汉字以内**，
      超了就换行、行高会不一致。别写「宫旁加站 · 古宫博物馆」这种（改「古宫博物馆」）。
    - **`notes` 为空/缺省 → 该时间点不渲染任何入口**，旧数据不改也照常显示。
      所以「没事可提醒」的时间点就该老老实实不写 `notes`，别硬凑。
    - `notes[].text` 里**不要再带 ⚠ / 💰 / ℹ 标记** —— 组标题上已经有一个了，重复标记很吵。
      韩国 d7-05 原来有一条行内「⚠️ 开放时间两个官方来源打架」，正确做法是把它
      **拆成独立的一条 alert**（两处官方口径冲突本来就是会白跑一趟的事，属于注意组）。
    - 行上渲染成一颗药丸：`⚠ 2 · 💰 1 · ℹ 2　注意事项`，点开弹窗，
      `aria-label` 是「查看注意事项：注意 2 条，票价 1 条，说明 2 条」。计数由数据算出，不用手写。

    **精简与结构化怎么写（用户 2026-09-21 第二轮反馈后收紧，这是硬标准）：**

    用户原话：「我发现每个时间点都有提示，太多了，很多没必要的……还有门票免费这种就不用
    提出来……我希望你简化提示，不要写太长只需要关键的信息就行……哪些『公共街区，全天开放。』
    这样的都是废话」「还有路线说明，你只需要说明特殊的就行，如果是地铁什么的不需要详细说明
    乘车方案」「还有出处这种就全都删除」「『出口　梨大站 2、3 号出口。』这种也全都删除，
    我自己会用导航软件你不需要细说」。

    收口成四条：

    1. **整类不提**：免费 / 无门票 / 全天开放 / 全年无休 / 常时开放 / 公共街区。
       这类**不改变任何决定**，用户点名的「废话」就是它们。也不许拿它当条目开头。
       ——注意这跟「不要写成免费」是两回事：核不到票价就如实写「是否收门票未确认」，
       别改成「免费」；而**确实免费**的则一个字都不提。
    2. **出处整类删掉**：来源、官方门户、核实日期、口径、「互相印证」、「未核到官方数字」
       这些**元信息**一律不写，只留结论。**唯一例外**是两处官方数字真的打架、且影响行为
       （票价可能不同 / 可能白跑一趟）——这时保留结论并改写成可执行的话：
       「也有渠道写 27,000，以现场或线上预订价为准」「开放时间有两种说法，行前打 … 确认」，
       仍然不带来源。
    3. **路线正文只写「从哪到哪 + 时长」**。地铁段**不写**几号线、换乘站名、出口编号
       （用户自己用导航，写了反而长）。只有**非显然**的才写明：没有直达车 / 要换村巴 /
       得坐船或缆车 / 只有某一路急行能到。同理 `notes` 里也不写出口编号。
    4. **长度上限**：`notes[].text` ≤ 110 字，`schedule[].text` ≤ 90 字。
       判断一条该不该留，只看它是否**改变行为**：
       **会误事**（排队 / 停航 / 休馆 / 必须预约 / 必须带护照 / 末班 / 只收现金）、
       **要花钱**（票价档位）、**要带东西**（驾照 / 现金 / 实体护照）。
       三条都不占 → 删掉，这个时间点就不出入口。

    ⚠️ **删除量很大时，用脚本改、不要手改**，并且在脚本里写死断言：
    短标题 ≤8 字、每条 ≤110 字、禁用词表（`全天开放` / `公共街区` / `出口` / `出处` /
    `未核到` / `口径` …）一个都不许出现、条数不能归零。
    手改一定会漏，而且**漏了页面照样渲染、不报错**。
    改写前先 `cp` 一份到 `/tmp/<任务>/` 备份，脚本本身也留在 `/tmp` 便于重跑。

    ⚠️ **「没事可提醒」才是常态**。韩国这一轮：74 个时间点里 58 个原本都挂了入口，
    收紧后只剩 42 个；纯景点（翰林公园、光化门广场、弘大商圈）本来就该没有入口。
    用户点名删掉翰林公园整块提示（只把「建议留 1.5 小时」挪进正文）就是这个意思。

25. **弹窗/入口是纯运行时能力，数据侧只要写 `notes[]` 就行；模板侧不要手改。**
    实现在 `scripts/patch-template.mjs`（`SCHEDULE_NOTE_CSS` / `SCHEDULE_NOTE_DIALOG_HTML` /
    `SCHEDULE_NOTE_JS` 三块，标记 `build:schedule-note`）。三个插入点：
    `.schedule-text` 与门票块之间插入口、时间线点击委托加 `[data-note-open]` 分支、
    `setupTicketDialog()` 之后挂 `setupScheduleNoteDialog()`。
    复用门票弹窗的外壳（`.ticket-dialog` + `.ticket-dialog__body`），所以尺寸/滚动/焦点归还
    都是既有行为；样式写在 `ledger.css`（层叠顺序见坑 20）。

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
7. **顶部模块导航**：链接数应等于 `config.modules` 里为 `true` 的项数（记账关了就不出「记账」）；
   逐个点一遍，跳到的 section 顶部**不能被吸顶顶栏盖住**；滚到某模块时该链接才高亮。
   还要确认它**确实在顶栏那一行里**（`#travel-navigation` 的父节点是 `header.topbar`）、
   **全页只有一行导航**（`document.querySelectorAll(".module-tabs").length === 0`），
   以及与 wordmark 同行不重叠 —— 这三条是用户点名要的形态，坏掉了页面照样能跑。
8. **有 `schedule[].notes[]` 的目的地**：入口数应等于「有 notes 的时间点数」，
   计数药丸（`⚠ 2 · 💰 1 · ℹ 2`）与 `aria-label` 都要与数据逐条对得上；
   把每个入口都点开一次，确认分组数、组标题、每行的短标题与正文与数据完全一致，
   且弹窗里**没有未分组的裸文本节点**（漏进分组的正文在页面上看不出来）。
   再确认没有任何没 notes 的时间点凭空长出入口。

需要自动化时，可以用无头浏览器把上面几条断言跑一遍 —— 但**断言要盯着真实 DOM**：
`elementFromPoint` 用视口坐标，元素不在视口里会一直返回 `null`（看起来像「热区没生效」，
其实是测试自己没滚到位）；在 headless 里 `window.scrollBy` 有时不生效，
更稳的做法是单开一个高视口（如 390×3000）页面，宽度仍按真机，整页一屏放得下。
另外**元素盒尺寸不等于可点范围**：模板用 `::before` 透明热区扩大命中区，
量 `.getBoundingClientRect()` 会得到偏小的结论。
**断言比对的对象要从构建产物里读**（`home/site/trips/<slug>/trip-data.json`），
别在测试里手抄一份期望值 —— 手抄的那份会跟着代码一起错。
还有一处容易自己骗自己：组标题在 DOM 里是 `<span aria-hidden>⚠</span>注意`，
`textContent` 拿到的是 `⚠注意`（**没有空格**），视觉上的间距来自 `display:flex; gap:7px`。
按 `textContent` 断言成 `⚠ 注意` 会得到一整片假失败。

> **验证线上 Pages 时，URL 一定要带上仓库前缀 `/TravelPlan`。**
> 站点是 project pages，`https://h-jett.github.io/trips/...` 是 404 ——
> 而 404 页面**没有 `app.js`、没有 `.schedule-item`**，于是每一个断言都失败，
> 看起来像「刚上线的新功能整个没生效」。实测踩过一次（178 项假失败）。
> 另外**别用固定 `sleep` 等远程页面加载**：同一条 URL 本地 2.6s 够、线上不够，
> 会得到 flakes。改成轮询 `document.querySelectorAll(".schedule-item").length > 0`。
> 也别拿「没有控制台报错」当加载成功的证据 —— 404 页面同样没有报错。

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
