---
name: sop-standards
description: SOP 第 4 步：在写代码之前，为项目制定执行标准、验收原则和验收清单，并把它们做成项目专属的开发 skill 和验收 skill。用户说"写执行标准""写验收标准""定一下规范""把标准做成 skill""读 PRD 然后写执行和验收标准"，或者项目已有 PRD 和第一个阶段方案、但还没有执行标准时使用。也用于回答"这个功能做到什么程度算完成""这个依赖 / 权限能不能加"这类关于规则本身的问题（要实际检查能不能交付，用 sop-accept）。
---

# 第 4 步：定执行标准和验收标准

正式写代码前，先写好两份规则：**执行标准**规定"改代码时必须做什么"，**验收原则**规定"怎么才算通过"；再写一份逐条可操作的**验收清单**。之后每个 AI 会话都按它们做事，换了会话、换了工具，质量也不会掉。

## 前提

- `docs/PRD.md` 已经确认，功能有编号
- 技术选型已经定了（写在 PRD 的技术方案或第一阶段的 spec 里）

缺任何一项，先回 `sop-prd` 或 `sop-spec`。

## 做法

1. **读 PRD 和已有方案**，列出：要验的功能编号、有哪几个端和角色（PRD 的端清单和权限表）、硬指标（速度、体积、内存、隐私）、合规边界、技术选型、验收环境（浏览器 / 模拟器 / 真机 / 小程序开发者工具）
2. **写执行标准**：复制 [references/execution-standard.md](references/execution-standard.md) 到 `docs/执行标准.md`，把尖括号换成项目内容：
   - 第 1 节的"代码"范围、第 3 节的测试命令和恢复数据命令、第 8 节的技术约定
   - 项目特有的硬性规则加进第 8 节（例如"不引入统计和广告 SDK""所有界面只用遥控器方向键能操作完""体积 ≤ 15MB"）
3. **写验收原则**：复制 [references/acceptance-principles.md](references/acceptance-principles.md) 到 `docs/验收原则.md`，改第 1 节的环境说明（在哪验、什么只能由人在真机上看）和第 3 节的定级例子
4. **写验收清单**：按 [references/checklist-template.md](references/checklist-template.md) 写 `docs/验收清单.md`。当前里程碑的每条功能至少一条，把第 3 步方案第 10 节的条目草案搬进来；后续里程碑的功能可以先只列标题、标上里程碑，做到时再写细；每个非功能指标写清测量方法；每条"操作 → 预期结果"具体到看得见的文字或数字。有多个端的：按端分节，共用功能放在一节里、写清在哪个端验；照 PRD 权限表，每个角色至少一条越权条目（用低权限账号做高权限的事 → 被拒绝）；每条上下游流程至少一条跨端条目（在上游端操作 → 到下游端确认结果）；执行说明里列出每个角色的演示账号
5. **验收记录目录**：第一次验收时再建（`docs/验收记录/README.md` 写编号规则和索引表，记录格式见 `sop-accept` 的 [record-template](../sop-accept/references/record-template.md)）
6. **交接文档**：初始化时没建的，现在按 `sop-handoff` 的 [handoff-doc-template](../sop-handoff/references/handoff-doc-template.md) 建
7. **做成项目专属 skill**（`<项目>` 用第 1 步定的项目代号，只能是小写英文、数字和连字符）：
   - 按 [references/project-dev-skill-template.md](references/project-dev-skill-template.md) 写 `.claude/skills/<项目>-dev/SKILL.md`
   - 按 [references/project-acceptance-skill-template.md](references/project-acceptance-skill-template.md) 写 `.claude/skills/<项目>-acceptance/SKILL.md`
   - 用户还会用别的 AI 工具时：Trae 放 `.trae/skills/`；其他工具按它们各自读 skill 的目录放，不确定就在 `AGENTS.md` 里写明"规则见 `.claude/skills/`"
8. **改 `CLAUDE.md` / `AGENTS.md`**：写明"改代码时加载 `<项目>-dev`，做验收时加载 `<项目>-acceptance`"，并列出文档表
9. **装硬性检查**（先跟产品负责人说明会装什么，同意后再装；项目要先用 git 管理）：
   - 运行 `node <插件目录>/scripts/sop-check.mjs init`（插件目录就是本 skill 往上两级，`../../scripts/sop-check.mjs`。没装插件、只复制了 `skills/` 的，要把插件的 `scripts/` 也复制到 `skills/` 旁边，例如 `.claude/skills/` 配 `.claude/scripts/`，这个路径才存在）。它会写入 `scripts/sop-check.mjs`、`.sop.json` 和 `.githooks/pre-commit`
   - 运行 `git config core.hooksPath .githooks`，让每次提交前自动检查
   - 代码放在 GitHub 上的，把插件的 `templates/github-sop-check.yml` 复制成 `.github/workflows/sop-check.yml`，并在里面加上项目的测试命令
   - 文档名或位置和默认的不一样（老项目常见），改 `.sop.json` 里的 `handoff`、`checklist`、`records`、`prd`、`changelogHeading`、`entryFields`；哪些目录算代码不好自动判断时，填 `codePaths`
   - 清单或 PRD 沿用项目自己的编号（例如 `AC-1`、`FR-01`），而不是默认的清单 `1.2`、PRD `F01` 时，改 `.sop.json` 的 `checklistIdPattern`、`prdIdPattern`（逐行匹配的正则，第一个括号是编号，例如 `"^\\|\\s*(AC-\\d+)\\s*\\|"`）。不改的话，检查脚本认不出编号，会提醒"没识别出任何编号"，编号重复和删改检查都不起作用
   - 跑一次 `node scripts/sop-check.mjs`，确认能正常输出
   - `.sop.json` 里还有几个可调的：`stopHook`（Claude Code 收尾时 `remind` 只提醒，默认 / `block` 拦下 / `off` 不管）、`entryFields`（完整条目必须有哪几项）、`smallEntryFields`（小改动条目必须有哪几项）、`maxEntries`（变更记录超过多少条提醒归档）

   硬性检查会自动拦下：改了代码却没写交接条目、交接条目缺内容或写"无变化"不写原因、删改验收清单编号、修改已有的验收记录、最新变更没通过验收就发正式版。它查的是"有没有做"，不是"做得好不好"
10. **给产品负责人确认**：用大白话总结——硬性规则有哪几条、什么算完成、谁来验、哪些要他在真机上看、AI 补了哪些"（补充）"阈值需要他点头

## 写标准时的要点

- **还没有代码时用占位**：测试命令、恢复数据命令、代码约定（具体到文件和函数）这些现在写不出来的，先写"（待第一次代码变化时补上）"，第 5 步第一次代码变化的 7 项里顺带填上
- **模板开头的说明要删掉**：复制进项目后，删掉"> 这是通用模板……"这类提示和不适用的行
- **按平台改环境**：模板里的"浏览器""端口""H5"是网页项目的例子，安卓、小程序、桌面程序要换成对应的模拟器、开发者工具或自动化工具

- **阈值要能测量**：PRD 里只写"很快"的，补成"≤ 3 秒，测 10 次至少 9 次达标"，并标"（补充）"让产品负责人确认
- **硬性规则少而硬**：10 条以内，每条都能判断"违反了没有"。例如畅投的"签名不变""体积上限""里程碑串行""实测写进报告才算完成"
- **例外要登记**：产品负责人同意先跳过某条（例如真机还没验就先做下一阶段），写进执行标准第 10 节的例外表，写明补做的条件
- **验收环境要现实**：AI 能操作的（浏览器、接口、模拟器）由验收会话做；AI 不能操作的（真机、微信开发者工具、应用商店后台）写明由产品负责人看，并给他一份检查步骤
- **标准会进化**：之后每次代码变化都会检查验收原则和清单要不要改；验收人提的意见由开发改进清单

## 完成标准

- `docs/执行标准.md`、`docs/验收原则.md`、`docs/验收清单.md`、`docs/交接文档.md` 都在（轻量版可以把前两份合成 `docs/开发与验收标准.md`）
- 两个项目专属 skill 已创建，`CLAUDE.md` / `AGENTS.md` 指向它们
- 产品负责人确认了硬性规则和"（补充）"阈值

做完进入第 5 步（`<项目>-dev` 或 `sop-develop`）。
