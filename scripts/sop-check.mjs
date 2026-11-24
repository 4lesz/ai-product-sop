#!/usr/bin/env node
// sop-check：检查项目是否照 ai-product-sop 的规矩做事。零依赖，Node 18+。
//
// 用法（在项目根目录运行，或用 --project 指定）：
//   node sop-check.mjs                 检查工作区里还没提交的改动（给 Claude Code 收尾钩子用）
//   node sop-check.mjs --staged        检查已暂存、准备提交的改动（给 git pre-commit 用）
//   node sop-check.mjs --range A..B    检查两个提交之间的改动（给 CI 用）
//   node sop-check.mjs --release       发布前检查：最新一次代码变化有没有通过的独立验收
//   node sop-check.mjs init            把本脚本、配置和 git 提交钩子装进当前项目
// 选项：--project <目录>  --json（机器可读输出）  --quiet（没问题时不输出）
//
// 项目根目录的 .sop.json 可以覆盖默认的文档位置和规则，见 DEFAULTS。
// 不是 SOP 项目（既没有 .sop.json 也没有交接文档）时，什么都不检查，直接通过。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = {
  handoff: 'docs/交接文档.md',
  checklist: 'docs/验收清单.md',
  records: 'docs/验收记录',
  prd: 'docs/PRD.md',
  changelogHeading: '变更记录',
  entryFields: ['改了什么', '测试', '实际验证', '验收清单', '验收原则', '建议复验'],
  // 标题里带这些词的是"小改动"条目：只要求 smallEntryFields，同一条可以一直往下加
  smallEntryWords: ['小改动'],
  smallEntryFields: ['改了什么', '测试'],
  // 变更记录超过这么多条就提醒归档
  maxEntries: 20,
  // Claude Code 收尾时怎么处理没写交接条目：remind 只提醒（默认）/ block 拦下 / off 不管
  stopHook: 'remind',
  inProgressWords: ['进行中'],
  acceptedConclusions: ['通过', '有条件通过'],
  // 不算"代码"的路径（前缀匹配；以 * 开头的是后缀匹配）
  nonCode: ['docs/', 'knowledge/', '.claude/', '.trae/', '.agents/', '.githooks/', '.sop.json', 'scripts/sop-check.mjs', '.github/workflows/sop-check.yml', '*.md', '*.txt', '.gitignore', '.gitattributes'],
  // 填了就只把这些前缀算作代码（比 nonCode 优先）
  codePaths: null,
};

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const opt = { mode: 'worktree', project: process.cwd(), json: false, quiet: false, range: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--staged') opt.mode = 'staged';
  else if (a === '--release') opt.mode = 'release';
  else if (a === '--range') { opt.mode = 'range'; opt.range = argv[++i]; }
  else if (a === '--project') opt.project = path.resolve(argv[++i]);
  else if (a === '--json') opt.json = true;
  else if (a === '--quiet') opt.quiet = true;
  else if (a === 'init') opt.mode = 'init';
  else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n')); process.exit(0); }
}

const root = opt.project;
const errors = [];
const warnings = [];
const err = (rule, msg) => errors.push({ rule, msg });
const warn = (rule, msg) => warnings.push({ rule, msg });

// ---------- 配置 ----------
function loadConfig() {
  const p = path.join(root, '.sop.json');
  let user = {};
  if (fs.existsSync(p)) {
    try { user = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
    catch (e) { err('config', `.sop.json 不是合法的 JSON：${e.message}`); }
  }
  return { ...DEFAULTS, ...user, _hasFile: fs.existsSync(p) };
}
const cfg = loadConfig();
const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
cfg.handoff = norm(cfg.handoff); cfg.checklist = norm(cfg.checklist); cfg.records = norm(cfg.records).replace(/\/$/, ''); cfg.prd = norm(cfg.prd);

// ---------- git ----------
function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}
const isGit = git(['rev-parse', '--is-inside-work-tree'], { allowFail: true })?.trim() === 'true';
const hasHead = isGit && git(['rev-parse', '--verify', 'HEAD'], { allowFail: true }) !== null;

function parseNameStatusZ(out) {
  const t = out.split('\0').filter((x) => x !== '');
  const res = [];
  for (let i = 0; i < t.length; i++) {
    const st = t[i];
    if (/^[RC]/.test(st)) { res.push({ status: st[0], from: norm(t[i + 1]), path: norm(t[i + 2]) }); i += 2; }
    else { res.push({ status: st[0], path: norm(t[i + 1]) }); i += 1; }
  }
  return res;
}

// 返回 { changes:[{status,path,from?}], base(path)->string|null, head(path)->string|null }
function collect() {
  if (opt.mode === 'staged') {
    const out = git(['diff', '--cached', '--name-status', '-z', ...(hasHead ? [] : ['--root'])], { allowFail: true }) ?? '';
    const changes = hasHead ? parseNameStatusZ(out) : (git(['ls-files', '-z', '--cached']) || '').split('\0').filter(Boolean).map((p) => ({ status: 'A', path: norm(p) }));
    return { changes, base: (p) => (hasHead ? git(['show', `HEAD:${p}`], { allowFail: true }) : null), head: (p) => git(['show', `:${p}`], { allowFail: true }) };
  }
  if (opt.mode === 'range') {
    const [a, b] = opt.range.split('..');
    const changes = parseNameStatusZ(git(['diff', '--name-status', '-z', a, b]));
    return { changes, base: (p) => git(['show', `${a}:${p}`], { allowFail: true }), head: (p) => git(['show', `${b}:${p}`], { allowFail: true }) };
  }
  // worktree：相对 HEAD 的全部未提交改动 + 未跟踪文件
  let changes = [];
  if (hasHead) changes = parseNameStatusZ(git(['diff', 'HEAD', '--name-status', '-z']));
  else changes = (git(['ls-files', '-z', '--cached']) || '').split('\0').filter(Boolean).map((p) => ({ status: 'A', path: norm(p) }));
  const untracked = (git(['ls-files', '-z', '--others', '--exclude-standard']) || '').split('\0').filter(Boolean).map((p) => ({ status: 'A', path: norm(p) }));
  changes = changes.concat(untracked);
  const readWT = (p) => { const f = path.join(root, p); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
  return { changes, base: (p) => (hasHead ? git(['show', `HEAD:${p}`], { allowFail: true }) : null), head: readWT };
}

// ---------- 文档解析 ----------
const readNow = (p) => { const f = path.join(root, p); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/^﻿/, '') : null; };

function isCode(p) {
  if (Array.isArray(cfg.codePaths) && cfg.codePaths.length) return cfg.codePaths.some((c) => p === norm(c) || p.startsWith(norm(c).replace(/\/?$/, '/')));
  return !cfg.nonCode.some((n) => (n.startsWith('*') ? p.endsWith(n.slice(1)) : n.endsWith('/') ? p.startsWith(n) : p === n));
}

// 变更记录里的条目：标题 → { title, body, fields }
function parseEntries(text) {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let start = lines.findIndex((l) => /^##\s/.test(l) && l.includes(cfg.changelogHeading));
  if (start === -1) return [];
  const entries = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s/.test(l)) break; // 下一个二级标题，变更记录结束
    const m = l.match(/^###\s+(.+?)\s*$/);
    if (m) { cur = { title: m[1], id: m[1].split(/\s+·\s+|\s+-\s+/)[0].trim(), lines: [] }; entries.push(cur); continue; }
    if (cur) cur.lines.push(l);
  }
  for (const e of entries) {
    e.fields = {};
    for (let i = 0; i < e.lines.length; i++) {
      const m = e.lines[i].match(/^\s*[-*]\s*([^：:]{1,12})[：:]\s*(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      // 下面缩进的子项也算这个字段的内容
      for (let j = i + 1; j < e.lines.length && /^\s{2,}\S/.test(e.lines[j]); j++) val += ' ' + e.lines[j].trim();
      e.fields[m[1].trim()] = val;
    }
  }
  return entries;
}

// 清单条目编号：表格第一列形如 1.2 / 19.3
function checklistIds(text) {
  if (!text) return [];
  const ids = [];
  for (const l of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = l.match(/^\|\s*(\d+\.\d+)\s*\|/);
    if (m) ids.push(m[1]);
  }
  return ids;
}
function prdIds(text) {
  if (!text) return [];
  const ids = [];
  for (const l of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = l.match(/^\|\s*(F\d{2,})\b/);
    if (m) ids.push(m[1]);
  }
  return ids;
}
const dups = (arr) => [...new Set(arr.filter((x, i) => arr.indexOf(x) !== i))];

// 编号里带"日期-序号"（如 KF-20261124-02）时按它找最新的；否则取最上面那条
const idKey = (e) => { const m = e.id.match(/(\d{8})-(\d{1,3})/); return m ? m[1] + m[2].padStart(3, '0') : null; };
function latestEntry(entries) {
  if (entries.every((e) => idKey(e))) return entries.slice().sort((a, b) => idKey(b).localeCompare(idKey(a)))[0];
  return entries[0];
}

// ---------- 规则 ----------
function staticChecks() {
  const cl = readNow(cfg.checklist);
  if (cl) { const d = dups(checklistIds(cl)); if (d.length) err('checklist-dup', `验收清单里有重复编号：${d.join('、')}。编号永不复用。`); }
  const prd = readNow(cfg.prd);
  if (prd) { const d = dups(prdIds(prd)); if (d.length) err('prd-dup', `PRD 功能编号重复：${d.join('、')}。`); }
  const entries = parseEntries(readNow(cfg.handoff));
  if (entries.length > 1 && latestEntry(entries) !== entries[0]) warn('entry-order', `交接文档"${cfg.changelogHeading}"里最新的条目 ${latestEntry(entries).id} 不在最上面。约定是最新的放最上面。`);
  if (cfg.maxEntries && entries.length > cfg.maxEntries) warn('handoff-long', `交接文档"${cfg.changelogHeading}"已经有 ${entries.length} 条，超过 ${cfg.maxEntries} 条。把较早的条目原样挪到 docs/交接归档/ 下（例如 变更记录-2026-10.md），交接文档里只留最近的，并写一句归档在哪。`);
}

function diffChecks() {
  if (!isGit) { warn('no-git', '项目不在 git 里，没法检查"改了代码有没有同步文档"。建议用 git 管理代码。'); return; }
  const { changes, base, head } = collect();
  if (!changes.length) return;

  const code = changes.filter((c) => isCode(c.path));
  const touched = (p) => changes.some((c) => c.path === p || c.from === p);
  const strict = opt.mode !== 'worktree'; // 提交和 CI 时不接受"进行中"

  // 1. 改了代码就要有新的交接条目
  if (code.length) {
    const list = code.slice(0, 5).map((c) => c.path).join('、') + (code.length > 5 ? ` 等 ${code.length} 个文件` : '');
    if (!touched(cfg.handoff)) {
      err('handoff-missing', `改了代码（${list}），但交接文档 ${cfg.handoff} 没有更新。按执行标准第 3 节，在"${cfg.changelogHeading}"最上面加一条交接条目。小改动（不改规则、数据结构、接口和用户流程）写"### KF-编号 · 小改动：……"，只要"改了什么""测试"两项，当天的小改动接着往这条里加；还要停下来问用户的话，先写一条标"状态：进行中"的条目。`);
    } else {
      const beforeEntries = parseEntries(base(cfg.handoff));
      const before = new Set(beforeEntries.map((e) => e.title));
      const after = parseEntries(head(cfg.handoff));
      const fresh = after.filter((e) => !before.has(e.title));
      const isSmall = (e) => cfg.smallEntryWords.some((w) => e.title.includes(w));
      // 往已有的"小改动"条目里加了内容，也算写了交接
      const grownSmall = after.filter((e) => isSmall(e) && before.has(e.title) && e.lines.join('\n') !== (beforeEntries.find((b) => b.title === e.title)?.lines.join('\n')));
      if (!fresh.length && !grownSmall.length) {
        err('handoff-no-entry', `改了代码（${list}），但交接文档"${cfg.changelogHeading}"里没有新增条目（三级标题 ### 编号 · 标题）。小改动（不改规则、数据结构、接口和用户流程）可以写一条"### KF-编号 · 小改动：……"，只写"改了什么""测试"两项，当天的小改动接着往这条里加。`);
      }
      for (const e of fresh) {
        if (isSmall(e)) {
          const miss = cfg.smallEntryFields.filter((f) => !e.fields[f] || !e.fields[f].trim());
          if (miss.length) err('entry-fields', `小改动条目"${e.title}"缺：${miss.join('、')}。`);
          continue;
        }
        const statusVal = e.fields['状态'] || '';
        const inProgress = cfg.inProgressWords.some((w) => statusVal.includes(w));
        if (inProgress) {
          if (strict) err('entry-in-progress', `交接条目"${e.title}"还标着"进行中"，不能提交。先做完执行标准第 3 节的 7 项，把条目写完整。`);
          continue;
        }
        const missing = cfg.entryFields.filter((f) => !e.fields[f] || !e.fields[f].trim());
        if (missing.length) err('entry-fields', `交接条目"${e.title}"缺这些内容：${missing.join('、')}。按执行标准第 6 节补上；还没做完就标"状态：进行中"。`);
        // 清单没动时，必须写明"无变化"和原因
        const clField = e.fields['验收清单'];
        if (clField !== undefined && !touched(cfg.checklist)) {
          const m = clField.match(/无变化(.*)/);
          if (!m) err('entry-checklist', `交接条目"${e.title}"说验收清单有改动，但 ${cfg.checklist} 并没有改。没改就写"无变化（原因）"。`);
          else if (m[1].replace(/[（）()，,。.\s：:]/g, '').length < 4) err('entry-checklist-reason', `交接条目"${e.title}"写了"验收清单：无变化"，但没写原因。要写清为什么不受影响。`);
        }
        const prField = e.fields['验收原则'];
        if (prField !== undefined && /无变化/.test(prField) && prField.replace(/无变化|[（）()，,。.\s：:]/g, '').length < 4) {
          err('entry-principles-reason', `交接条目"${e.title}"写了"验收原则：无变化"，但没写原因。`);
        }
      }
    }
  }

  // 2. 验收清单：已有编号不能消失（删除要保留编号写"已废弃"）
  if (touched(cfg.checklist)) {
    const b = checklistIds(base(cfg.checklist));
    const a = new Set(checklistIds(head(cfg.checklist)));
    const gone = [...new Set(b)].filter((id) => !a.has(id));
    if (gone.length) err('checklist-removed', `验收清单里这些编号不见了：${gone.join('、')}。编号永不改、永不删；功能删掉了就保留这一行，写"（已废弃，KF-编号）"。`);
  }

  // 3. 验收记录写完不能改（索引 README 只能加行）
  for (const c of changes) {
    const p = c.from || c.path;
    if (!p.startsWith(cfg.records + '/')) continue;
    if (c.status === 'A') continue;
    if (path.posix.basename(p).toLowerCase() === 'readme.md' && c.status === 'M') {
      const b = (base(p) || '').replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim());
      const a = new Set((head(p) || '').replace(/\r\n/g, '\n').split('\n'));
      const lost = b.filter((l) => !a.has(l));
      if (lost.length) err('records-index-edited', `验收记录索引 ${p} 删改了已有的行（只能加新行）：${lost[0].slice(0, 60)}…`);
      continue;
    }
    err('records-edited', `已有的验收记录 ${p} 被${c.status === 'D' ? '删除' : '修改'}了。验收记录写完不能改，有误在下一轮记录里说明。`);
  }
}

function releaseCheck() {
  const entries = parseEntries(readNow(cfg.handoff));
  if (!entries.length) { err('release-no-entry', `交接文档 ${cfg.handoff} 里找不到任何变更条目，没法确认要发布的是哪一版。`); return; }
  const latest = latestEntry(entries);
  const inProgress = cfg.inProgressWords.some((w) => (latest.fields['状态'] || '').includes(w));
  if (inProgress) { err('release-in-progress', `最新的变更"${latest.title}"还在进行中，不能发布。`); return; }
  const dir = path.join(root, cfg.records);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md' && !f.includes('模板')) : [];
  const okWords = cfg.acceptedConclusions.slice().sort((x, y) => y.length - x.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const okRe = new RegExp(`结论[^\\n]{0,4}?[：:]\\s*\\**\\s*(?<!不)(${okWords.join('|')})`);
  const hits = files.filter((f) => {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    return t.includes(latest.id) && okRe.test(t) && !/结论[^\n]{0,4}?[：:]\s*\**\s*(不通过|中止)/.test(t);
  });
  if (!hits.length) err('release-not-accepted', `最新的变更 ${latest.id} 没有结论为"${cfg.acceptedConclusions.join('/')}"的验收记录（在 ${cfg.records}/ 里找不到同时写了这个编号和通过结论的记录）。先做独立验收再发布。`);
}

function init() {
  const self = fileURLToPath(import.meta.url);
  const dstScript = path.join(root, 'scripts', 'sop-check.mjs');
  fs.mkdirSync(path.dirname(dstScript), { recursive: true });
  if (path.resolve(self) !== path.resolve(dstScript)) fs.copyFileSync(self, dstScript);
  const cfgPath = path.join(root, '.sop.json');
  if (!fs.existsSync(cfgPath)) {
    const { codePaths, ...rest } = DEFAULTS;
    fs.writeFileSync(cfgPath, JSON.stringify({ ...rest, codePaths: null }, null, 2) + '\n');
  }
  const hookDir = path.join(root, '.githooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hook = path.join(hookDir, 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\n# ai-product-sop：提交前检查是否照执行标准做完\nnode scripts/sop-check.mjs --staged || {\n  echo "";\n  echo "提交被拦下：按上面的提示补完再提交。确实要跳过时由产品负责人决定。";\n  exit 1;\n}\n');
  try { fs.chmodSync(hook, 0o755); } catch {}
  console.log('已写入：scripts/sop-check.mjs、.sop.json（已存在则不覆盖）、.githooks/pre-commit');
  console.log('还差一步，让 git 用这个提交钩子：git config core.hooksPath .githooks');
}

// ---------- 主流程 ----------
if (opt.mode === 'init') { init(); process.exit(0); }

const isSop = cfg._hasFile || fs.existsSync(path.join(root, cfg.handoff));
if (!isSop) {
  if (opt.json) console.log(JSON.stringify({ sop: false, errors: [], warnings: [] }));
  process.exit(0);
}

try {
  if (opt.mode === 'release') releaseCheck();
  else { staticChecks(); diffChecks(); }
} catch (e) {
  warn('internal', `检查脚本自己出错了，本次跳过：${e.message.split('\n')[0]}`);
}

if (opt.json) {
  console.log(JSON.stringify({ sop: true, mode: opt.mode, errors, warnings }));
} else if (errors.length || warnings.length || !opt.quiet) {
  const label = { worktree: '未提交的改动', staged: '准备提交的改动', range: `提交范围 ${opt.range}`, release: '发布前检查' }[opt.mode];
  console.log(`SOP 检查（${label}）：${errors.length ? `${errors.length} 个问题` : '通过'}${warnings.length ? `，${warnings.length} 个提醒` : ''}`);
  errors.forEach((e, i) => console.log(`  ✗ ${i + 1}. ${e.msg}`));
  warnings.forEach((w) => console.log(`  ! ${w.msg}`));
}
process.exit(errors.length ? 1 : 0);
