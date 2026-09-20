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
│   ├── scripts/build-map.mjs                  底图生成（routeMap 的唯一写入者）
│   └── trip-data.json                         空白底板
├── configs/
│   ├── trips.json                             目的地注册表（首页顺序/标题）
│   └── modules.json                           模块策略（记账=保留位）
├── trips/<slug>/                              一个目的地
│   ├── trip-data.json                         ← 唯一需要手写的数据
│   ├── SOURCE.md                              原始资料（生成输入，不进站点）
│   └── assets/                                门票 PDF、专属底图
├── home/site/                                 构建产物 = 要发布的静态站点（勿手改）
├── scripts/                                   本站工具链
├── logs/  reports/                            运行日志 / 报告
```

## 命令

| 命令 | 作用 |
|---|---|
| `npm run new -- --slug x --title "..." --dest "..." --start YYYY-MM-DD --end YYYY-MM-DD` | 新建目的地骨架并登记 |
| `npm run build` | 重建每个 trip 的 `routeMap`，组装 `home/site/`，生成首页 |
| `npm run check` | 结构自检（注册表/数据/模块/底图/产物） |
| `npm run preview` | 本地预览 `home/site/` |
| `npm run patch` | 幂等地给 `template/` 打「返回全部攻略」链接补丁 |

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

- `trips/<slug>/SOURCE.md`、`trips/<slug>/assets/` 是**生成输入**，不会被拷进 `home/site/`。
  但它们在 Git 仓库里 —— 若是公开仓库，等于公开。敏感资料不要提交，或改用私有仓库。
- 页面上的运行时数据（Todo 勾选、门票状态）只存在**访问者自己的浏览器 localStorage** 里，
  换设备不同步、清浏览器数据就丢。这是 GitHub Pages 无服务端下的必然结果。
- 不要把 `.env`、token、private key、任何数据库 ID 提交进仓库。

## 上游与许可

`template/` 派生自 [do-tongxue/Travel-Plan-Page](https://github.com/do-tongxue/Travel-Plan-Page)（MIT），
已剔除 legacy 的 `advanced/`、`references/advanced/`、`assets/boundaries/` 与两张 Demo 底图。
保留 `template/LICENSE` 与 `template/THIRD_PARTY_NOTICES.md`。修改记录见 `reports/`。
