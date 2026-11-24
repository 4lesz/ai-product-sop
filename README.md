# AI 协作产品开发 SOP（ai-product-sop）

一个人当产品负责人、让 AI 当开发团队，也能把产品从想法做到上线。这个插件把这套做法拆成 9 个 skill 和 1 个验收子代理，装上以后，AI 会按固定流程追问需求、写 PRD、列决定点、定标准、小步开发、独立验收、发布和交接。

内容来自三个实际项目：

| 项目 | 是什么 | 用到的重点 |
| --- | --- | --- |
| 问问 | 购物决策社区，微信小程序 | 执行标准 7 项必做、独立验收、交接文档、5 阶段迁移 |
| 畅投 | 安卓投影仪投屏接收端 | PRD 功能编号、标准做成 skill、CI 自动发布、真机验收清单 |
| 日课 | 专升本备考打卡 App | 先建知识库、每阶段先写方案再写代码、AI 接口接入、可移植交接 |

## 流程

```
1 确认需求 → 2 写 PRD → 3 方案与决策 → 4 定标准
                                          ↓
8 收反馈 ← 7 部署发布 ← 6 独立验收 ← 5 小步开发
   ↑（下一轮）            └─ 不通过 → 回到 5
交接文档贯穿全程
```

| 步 | skill | 产出 |
| --- | --- | --- |
| 入口 | `sop-start` | 判断在哪一步、搭项目骨架、全局铁律 |
| 1 | `sop-discover` | `docs/需求简报.md`（内容型产品加 `knowledge/`） |
| 2 | `sop-prd` | `docs/PRD.md`；中途改需求也走这里 |
| 3 | `sop-spec` | `docs/specs/<阶段>/spec.md`、决定点、`docs/设计规范.md`（附风格方向样例和界面底线） |
| 4 | `sop-standards` | `docs/执行标准.md`、`验收原则.md`、`验收清单.md`，以及项目专属的开发 / 验收 skill |
| 5 | `sop-develop` | 代码 + 交接条目（7 项必做） |
| 6 | `sop-accept` + 子代理 `sop-acceptance-reviewer` | `docs/验收记录/YS-*.md` |
| 7 | `sop-release` | `docs/部署说明.md`、发布说明、真机检查步骤 |
| 8 | `sop-handoff` | `docs/交接文档.md`、反馈整理、多工具协作 |

通用的执行标准和验收原则在 `skills/sop-standards/references/`，第 4 步会把它们复制进项目并按项目改写。

## 硬性检查：怎么保证 AI 真的照做

skill 只是说明书，AI 可能跳步。插件另外带了三道机器检查，核心是检查脚本 `scripts/sop-check.mjs`（零依赖，Node 18+）：

| 关卡 | 什么时候跑 | 拦什么 | 对谁有效 |
| --- | --- | --- | --- |
| Claude Code 钩子（`hooks/hooks.json`，装插件即生效） | 打开项目时 | 不拦，把规矩和交接文档的当前状态告诉 AI | Claude Code |
| | AI 每结束一轮（只在这一轮动过文件时） | 改了代码却没写交接条目、条目缺内容、删改清单编号、改已有验收记录 → 默认只提醒 AI，不拦（`.sop.json` 的 `stopHook` 可改成 `block` 拦下或 `off` 关掉） | Claude Code |
| | 验收子代理写文件或跑 git 时 | 写验收记录以外的文件、提交代码 → 直接拒绝 | Claude Code |
| git 提交钩子（`.githooks/pre-commit`） | 每次 `git commit` | 同上，另外"进行中"的条目不许提交 | 所有工具（Claude、Trae、WorkBuddy、人） |
| CI（`templates/github-sop-check.yml`） | 每次推送、PR；打正式版标签 | 同上；正式版还要求最新变更有通过的验收记录 | 所有工具 |

第 4 步 `sop-standards` 会把检查脚本、`.sop.json` 配置和提交钩子装进项目。手动安装：

```
node <插件目录>/scripts/sop-check.mjs init
git config core.hooksPath .githooks
```

文档名和默认不同的老项目，改 `.sop.json` 里的路径即可。

为了不让交接文档越写越长：只改文档不用写交接条目；小改动（不改规则、数据结构、接口和用户流程）只写一条两项的短条目，当天的合并在一起；变更记录超过 20 条时检查脚本会提醒把旧条目挪到 `docs/交接归档/`。不是 SOP 项目（没有 `.sop.json` 也没有 `docs/交接文档.md`）时，钩子什么都不做。

机器只能查"有没有做"，查不了"做得好不好"：测试是不是测到点子上、验收是不是真的点了一遍，仍然靠独立验收要求附截图和命令输出，加上产品负责人抽查。

## 安装

**Claude Code（推荐）**

把这个文件夹放到任意位置（或推到一个 Git 仓库），在 Claude Code 里：

```
/plugin marketplace add <这个文件夹的路径或 Git 仓库地址>
/plugin install ai-product-sop@ai-product-sop
```

**只用其中几个 skill / 用在其他 AI 工具**

每个 `skills/<名字>/` 都是标准的 skill 文件夹（`SKILL.md` + `references/`）：

- Claude Code 单个项目：复制到项目的 `.claude/skills/`
- Trae：复制到 `.trae/skills/`
- 其他支持 `AGENTS.md` 的工具：复制到项目里，在 `AGENTS.md` 写明"按 `skills/sop-start/SKILL.md` 的流程做"

skill 之间用相对路径互相引用（例如 `../sop-standards/references/...`），所以请整个 `skills/` 目录一起复制。

## 怎么开始

新项目：

> 我想做一个……，给……用。按 SOP 来。

已有项目：

> 按 SOP 看看这个项目现在做到哪一步了。

AI 会先加载 `sop-start`，告诉你在哪一步、下一步做什么。

## 核心规矩

1. 先文档后代码：没有 PRD 编号和验收条目的功能不写
2. 人拍板：AI 列选项和推荐，产品负责人决定
3. 小步走：一次代码变化只做一件事，做完 7 项必做才算完成
4. 开发和验收分开：写代码的会话不给自己验收
5. 完成要有证据：口头说明不算
6. 文档跟着代码走：交接文档是项目的大脑
7. 外部动作由人做：提交、推送、发布、密钥、登录、付款
