#!/usr/bin/env node
// ai-product-sop 的 Claude Code 钩子入口。由 hooks/hooks.json 调用，事件名作为第一个参数：
//   session-start  打开项目时，把"本项目按 SOP 运行、先读什么"告诉 AI
//   prompt-submit  用户每发一条消息时，记下工作区的快照（用来判断这一轮 AI 有没有动文件）
//   stop           AI 结束这一轮时：这一轮动过文件，就跑 sop-check；默认只提醒（.sop.json 的 stopHook 可设 block 拦下 / off 关掉）
//   pre-tool       验收子代理只能写验收记录、不能提交代码
// 不是 SOP 项目时，所有事件都直接放行、不输出任何东西。任何意外都放行，不能因为钩子坏了卡住用户。

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REVIEWER = 'sop-acceptance-reviewer';
const event = process.argv[2];
const here = path.dirname(fileURLToPath(import.meta.url));

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}
const out = (obj) => { if (obj) process.stdout.write(JSON.stringify(obj)); process.exit(0); };

const input = readStdin();
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

function loadCfg() {
  const d = { handoff: 'docs/交接文档.md', checklist: 'docs/验收清单.md', records: 'docs/验收记录', prd: 'docs/PRD.md', stopHook: 'remind' };
  const p = path.join(root, '.sop.json');
  let user = {};
  if (fs.existsSync(p)) { try { user = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch {} }
  const cfg = { ...d, ...user };
  cfg.isSop = fs.existsSync(p) || fs.existsSync(path.join(root, cfg.handoff));
  return cfg;
}

function git(args) {
  try { return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
}

// 工作区快照：未提交改动的完整 diff + 未跟踪文件的名字、大小、修改时间
function snapshot() {
  const diff = git(['diff', 'HEAD', '--no-color']) ?? git(['diff', '--cached', '--no-color']) ?? '';
  const untracked = (git(['ls-files', '-z', '--others', '--exclude-standard']) || '').split('\0').filter(Boolean)
    .map((f) => { try { const s = fs.statSync(path.join(root, f)); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return f; } });
  return crypto.createHash('sha1').update(diff).update(untracked.join('\n')).digest('hex');
}
function snapFile() {
  const dir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'ai-product-sop');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `snap-${String(input.session_id || 'nosession').replace(/[^\w-]/g, '')}.txt`);
}

function runCheck(args) {
  const projectCopy = path.join(root, 'scripts', 'sop-check.mjs');
  const script = fs.existsSync(projectCopy) ? projectCopy : path.join(here, 'sop-check.mjs');
  try {
    const res = execFileSync(process.execPath, [script, '--project', root, '--json', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(res);
  } catch (e) {
    try { return JSON.parse(e.stdout); } catch { return { errors: [], warnings: [] }; }
  }
}

function readSection(file, heading, max = 2500) {
  try {
    const t = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
    const i = t.search(new RegExp(`^##\\s+${heading}`, 'm'));
    if (i === -1) return '';
    const rest = t.slice(i);
    const j = rest.slice(3).search(/^##\s/m);
    const sec = j === -1 ? rest : rest.slice(0, j + 3);
    return sec.length > max ? sec.slice(0, max) + '\n…（后面略，完整内容见文件）' : sec;
  } catch { return ''; }
}

function listProjectSkills() {
  const dirs = ['.claude/skills', '.trae/skills'];
  const found = [];
  for (const d of dirs) {
    const p = path.join(root, d);
    if (!fs.existsSync(p)) continue;
    for (const name of fs.readdirSync(p)) if (fs.existsSync(path.join(p, name, 'SKILL.md'))) found.push(`${d}/${name}`);
  }
  return found;
}

// 心跳：每个事件最后一次被调用的时间和项目，方便确认钩子真的在跑（只记时间和路径，不记内容）
function heartbeat(cfg) {
  try {
    const dir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'ai-product-sop');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `last-${event}.txt`), `${new Date().toISOString()}\n${root}\nSOP 项目：${cfg.isSop ? '是' : '否'}\n`);
  } catch {}
}

try {
  const cfg = loadCfg();
  heartbeat(cfg);

  if (event === 'session-start') {
    if (!cfg.isSop) out(null);
    const skills = listProjectSkills();
    const status = readSection(cfg.handoff, '当前状态');
    const ctx = [
      '这个项目按 ai-product-sop（AI 协作产品开发 SOP）运行，并装了硬性检查：',
      `- 交接文档：${cfg.handoff}；验收清单：${cfg.checklist}；验收记录：${cfg.records}/；PRD：${cfg.prd}。`,
      skills.length ? `- 项目自己的 skill：${skills.join('、')}。改代码时用开发 skill，做验收时用验收 skill。` : '- 项目还没有自己的开发 / 验收 skill，改代码用 sop-develop，验收用 sop-accept。',
      '- 改了代码，提交前要在交接文档"变更记录"最上面有一条交接条目，否则 git 提交会被拦下。小改动（不改规则、数据结构、接口和用户流程）写一条"KF-编号 · 小改动：……"，只要"改了什么""测试"两项，当天的小改动接着往这条里加。只改文档不用写。',
      '- 验收清单的编号不能删改，已有验收记录不能改；git 提交前也会检查这些。',
      status ? `\n交接文档里的当前状态：\n${status}` : '',
    ].filter(Boolean).join('\n');
    out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx.slice(0, 9500) } });
  }

  if (event === 'prompt-submit') {
    if (!cfg.isSop || git(['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') out(null);
    fs.writeFileSync(snapFile(), snapshot());
    out(null);
  }

  if (event === 'stop') {
    const mode = ['remind', 'block', 'off'].includes(cfg.stopHook) ? cfg.stopHook : 'remind';
    if (mode === 'off' || !cfg.isSop || git(['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') out(null);
    let before = null;
    try { before = fs.readFileSync(snapFile(), 'utf8'); } catch {}
    if (before !== null && before === snapshot()) out(null); // 这一轮 AI 没动文件
    const r = runCheck([]);
    if (!r.errors || !r.errors.length) out(null);
    const list = r.errors.map((e, i) => `${i + 1}. ${e.msg}`).join('\n');
    if (mode === 'remind') {
      // 只提醒，不拦：下一轮 AI 会看到这段话；真正的关卡在 git 提交和 CI
      out({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: `SOP 收尾提醒（不影响结束这一轮）：这一轮改了文件，下面几项提交前要补上，否则 git 提交会被拦下：\n${list}` } });
    }
    if (input.stop_hook_active) {
      out({ systemMessage: `SOP 收尾检查仍有 ${r.errors.length} 个问题没解决：\n${list}` });
    }
    out({ decision: 'block', reason: `SOP 收尾检查没通过，先处理完再结束这一轮：\n${list}\n（这一轮的工作确实还没做完、需要用户回答问题，就在交接文档加一条"状态：进行中"的条目，写清还差什么。）` });
  }

  if (event === 'pre-tool') {
    const agent = String(input.agent_type || '');
    if (!agent.endsWith(REVIEWER)) out(null);
    const deny = (why) => out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });
    const tool = input.tool_name;
    const ti = input.tool_input || {};
    if (tool === 'Bash') {
      if (/\bgit\s+(commit|push|reset|checkout|restore|rebase|merge|stash|clean|rm|mv|tag)\b/.test(ti.command || '')) deny('验收人不能提交或改动 git 记录，只能写验收记录。');
      out(null);
    }
    const target = ti.file_path || ti.notebook_path || ti.path || '';
    if (!target) out(null);
    // Git Bash 风格的 /c/Users/... 换成 C:/Users/...，两种写法都能认
    const win = (p) => (process.platform === 'win32' ? p.replace(/^\/([a-zA-Z])\//, '$1:/') : p);
    const rel = path.relative(path.resolve(win(root)), path.resolve(win(root), win(target))).replace(/\\/g, '/');
    const recordsDir = cfg.records.replace(/\\/g, '/').replace(/\/$/, '');
    if (rel.startsWith(recordsDir + '/')) out(null);
    deny(`验收人只能写 ${recordsDir}/ 下的验收记录，不能改 ${rel}。发现的问题写进验收记录，由开发去修。`);
  }

  out(null);
} catch {
  out(null);
}
