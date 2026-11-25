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

// ---------- 验收子代理能写哪里 ----------
// 允许：项目里的验收记录目录、系统临时目录、丢弃输出的 /dev/null / NUL / $null。其他一律拒绝。
function makeGuard(recordsDir, cwd) {
  const isWin = process.platform === 'win32';
  // Git Bash 风格的 /c/Users/... 换成 C:/Users/...，两种写法都能认
  const win = (p) => (isWin ? p.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/') : p);
  const expand = (p) => p
    .replace(/^~(?=[\/\\]|$)/, os.homedir())
    .replace(/\$\{?(TMPDIR|TMP|TEMP)\}?|\$env:(TMPDIR|TMP|TEMP)\b/gi, os.tmpdir());
  const base = path.resolve(win(root));
  const abs = (t) => path.resolve(win(cwd), win(expand(t)));
  const inside = (dir, p) => { const r = path.relative(dir, p); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };
  const temps = [os.tmpdir(), ...(isWin ? [] : ['/tmp', '/var/tmp'])].map((d) => path.resolve(d));
  return {
    // dest：复制 / 移动的目标，可以直接是验收记录目录本身（放进这个目录）
    allowed(t, dest = false) {
      const s = String(t).trim();
      if (/^(\/dev\/null|nul|\$null)$/i.test(s)) return true;
      if (/^\/tmp(\/|$)/.test(s)) return true; // Git Bash 的 /tmp 指向系统临时目录
      const p = abs(s);
      // 项目里的路径只认验收记录目录（项目本身放在临时目录里时也一样）；项目外只认临时目录
      const rec = path.join(base, recordsDir);
      if (p === base || inside(base, p)) return inside(rec, p) || (dest && path.relative(rec, p) === '');
      return temps.some((d) => inside(d, p));
    },
    show(t) { const p = abs(String(t)); const r = path.relative(base, p).replace(/\\/g, '/'); return r && !r.startsWith('..') ? r : String(t); },
  };
}

// 把 shell 命令拆成一段段命令（; && || | 换行 括号 花括号），每段拆成词；顺带收集重定向（> >>）的目标。
// 只是常见写法的兜底，不是沙箱：node -e、python 这类直接写文件的拦不住，真正的关卡还是 git 提交前的检查。
function parseShell(cmd, ps) {
  const segs = []; const redirects = [];
  let words = []; let cur = ''; let has = false; let q = null; let redir = false; let heredocs = [];
  const esc = ps ? '`' : '\\';
  const push = () => { if (has) { (redir ? redirects : words).push(cur); redir = false; } cur = ''; has = false; };
  const end = () => { push(); if (words.length) segs.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === esc && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    // PowerShell 的 here-string：@' … '@ / @" … "@，整段当一个词
    if (ps && c === '@' && (cmd[i + 1] === "'" || cmd[i + 1] === '"') && /^\r?\n/.test(cmd.slice(i + 2))) {
      const close = cmd.indexOf(`\n${cmd[i + 1]}@`, i + 2);
      const stop = close === -1 ? cmd.length : close + 3;
      cur += cmd.slice(i + 2, close === -1 ? cmd.length : close); has = true; i = stop - 1; continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === esc && i + 1 < cmd.length && cmd[i + 1] !== '\n') { cur += cmd[++i]; has = true; continue; }
    if (c === '$' && cmd[i + 1] === '{') { const j = cmd.indexOf('}', i); cur += cmd.slice(i, j === -1 ? cmd.length : j + 1); has = true; i = j === -1 ? cmd.length : j; continue; }
    if (c === '\n') {
      end();
      // heredoc 的正文不是命令，跳到结束标记那一行
      for (const h of heredocs) {
        const re = new RegExp(`^${h.strip ? '\\t*' : ''}${h.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?$`);
        let j = i + 1;
        while (j < cmd.length) {
          const k = cmd.indexOf('\n', j); const line = cmd.slice(j, k === -1 ? cmd.length : k);
          j = k === -1 ? cmd.length : k + 1;
          if (re.test(line)) break;
        }
        i = j - 1;
      }
      heredocs = [];
      continue;
    }
    if (/\s/.test(c)) { push(); continue; }
    if (';|&(){}'.includes(c)) { end(); continue; }
    if (c === '<') {
      push();
      if (!ps && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
        i++;
        const strip = cmd[i + 1] === '-'; if (strip) i++;
        const m = cmd.slice(i + 1).match(/^\s*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/);
        if (m) { heredocs.push({ tag: m[1] ?? m[2] ?? m[3], strip }); i += m[0].length; }
      }
      continue;
    }
    if (c === '>') {
      if (/^\d$/.test(cur) || cur === '*') { cur = ''; has = false; } else push();
      if (cmd[i + 1] === '>' || cmd[i + 1] === '|') i++;
      if (cmd[i + 1] === '&') { i++; while (/[\d-]/.test(cmd[i + 1] || '')) i++; continue; }
      redir = true; continue;
    }
    cur += c; has = true;
  }
  end();
  return { segs, redirects };
}

const GIT_WRITE = new Set(['commit', 'push', 'pull', 'reset', 'checkout', 'switch', 'restore', 'rebase', 'merge', 'cherry-pick', 'revert', 'stash', 'clean', 'rm', 'mv', 'tag', 'am', 'apply', 'update-ref', 'filter-branch', 'replace', 'notes']);
const GIT_OPT_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path']);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nice', 'nohup', 'xargs', 'builtin', 'stdbuf', 'timeout']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'powershell', 'pwsh', 'cmd']);
// POSIX / cmd：所有参数都是要写或删的路径 / 只有最后一个是
const POSIX_ALL = new Set(['tee', 'touch', 'truncate', 'rm', 'rmdir', 'mkdir', 'unlink', 'shred', 'del', 'erase', 'rd', 'md', 'ren', 'rename']);
const POSIX_LAST = new Set(['cp', 'install', 'ln', 'rsync', 'copy', 'xcopy', 'robocopy']);
// PowerShell 写文件的命令（含常用别名）→ 第几个位置参数是目标
const PS_WRITE = {
  'set-content': [0], 'add-content': [0], 'clear-content': [0], 'out-file': [0], 'tee-object': [0], 'new-item': [0], 'remove-item': [0], 'rename-item': [0], 'move-item': [0, 1], 'copy-item': [1],
  sc: [0], ac: [0], clc: [0], tee: [0], ni: [0], md: [0], mkdir: [0], ri: [0], rm: [0], del: [0], erase: [0], rd: [0], rmdir: [0], ren: [0], rni: [0], mi: [0, 1], mv: [0, 1], move: [0, 1], cpi: [1], cp: [1], copy: [1],
};
const PS_PATH_PARAMS = ['-path', '-literalpath', '-filepath', '-destination'];
const PS_VALUE_PARAMS = ['-value', '-encoding', '-itemtype', '-type', '-filter', '-include', '-exclude', '-name', '-newname', '-inputobject', '-stream', '-credential', '-delimiter', '-width', '-target'];
const cmdName = (w) => path.basename(String(w).replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');

function shellViolations(command, ps, depth = 0) {
  const res = { git: null, inplace: null, targets: [], dests: [] };
  if (depth > 3) return res;
  const { segs, redirects } = parseShell(command, ps);
  res.targets.push(...redirects);
  for (let words of segs) {
    // 去掉开头的 VAR=1 和 sudo / env 这类包装命令
    let k = 0;
    while (k < words.length) {
      const w = words[k];
      if (/^\w+=/.test(w) || WRAPPERS.has(cmdName(w))) { k++; continue; }
      // 包装命令自己的参数，例如 env -i、timeout 10、nice -n 5
      if (k > 0 && (w.startsWith('-') || /^[\d.]+[smhd]?$/.test(w))) { k++; continue; }
      break;
    }
    words = words.slice(k);
    if (!words.length) continue;
    const name = cmdName(words[0]);
    const args = words.slice(1);
    const merge = (r) => { res.git ||= r.git; res.inplace ||= r.inplace; res.targets.push(...r.targets); res.dests.push(...r.dests); };

    if (SHELLS.has(name)) {
      const isPs = name === 'powershell' || name === 'pwsh';
      for (let j = 0; j < args.length - 1; j++) {
        const a = args[j].toLowerCase();
        if (isPs && /^-e(c|ncodedcommand)?$/.test(a)) { try { merge(shellViolations(Buffer.from(args[j + 1], 'base64').toString('utf16le'), true, depth + 1)); } catch {} break; }
        if ((isPs && /^-c(ommand)?$/.test(a)) || (!isPs && (a === '-c' || a === '/c' || a === '/k' || /^-[a-z]*c$/.test(a)))) { merge(shellViolations(args.slice(j + 1).join(' '), isPs, depth + 1)); break; }
      }
      continue;
    }
    if (name === 'git') {
      let j = 0;
      while (j < args.length && args[j].startsWith('-')) { if (GIT_OPT_WITH_VALUE.has(args[j])) j++; j++; }
      if (j < args.length && GIT_WRITE.has(args[j].toLowerCase())) res.git ||= args[j];
      continue;
    }
    if (ps && PS_WRITE[name]) {
      const positional = [];
      for (let j = 0; j < args.length; j++) {
        const a = args[j];
        const [pname, inline] = a.startsWith('-') ? [a.split(':')[0].toLowerCase(), a.includes(':') ? a.slice(a.indexOf(':') + 1) : null] : [null, null];
        if (pname && PS_PATH_PARAMS.some((p) => p.startsWith(pname) && pname.length >= 3)) {
          const v = inline ?? args[++j];
          // 复制时 -Path 是来源，只有 -Destination 是要写的地方
          const isSource = PS_WRITE[name].length === 1 && PS_WRITE[name][0] === 1 && !'-destination'.startsWith(pname);
          if (v !== undefined && !isSource) ('-destination'.startsWith(pname) ? res.dests : res.targets).push(...v.split(','));
          continue;
        }
        if (pname && PS_VALUE_PARAMS.some((p) => p.startsWith(pname) && pname.length >= 3)) { if (inline === null) j++; continue; }
        if (pname) continue; // 开关参数，例如 -Force -Recurse
        positional.push(a);
      }
      for (const n of PS_WRITE[name]) if (positional[n] !== undefined) (n === 1 ? res.dests : res.targets).push(...positional[n].split(','));
      continue;
    }
    if (!ps || !PS_WRITE[name]) {
      if ((name === 'sed' || name === 'perl') && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) { res.inplace ||= `${name} -i`; continue; }
      const files = args.filter((a) => !/^-/.test(a) && !(/^\/[a-zA-Z?]{1,2}$/.test(a) && ['del', 'erase', 'rd', 'md', 'move', 'copy', 'xcopy', 'robocopy', 'ren', 'rename'].includes(name)));
      if (name === 'dd') { for (const a of args) if (a.startsWith('of=')) res.targets.push(a.slice(3)); continue; }
      if (POSIX_ALL.has(name)) res.targets.push(...files);
      else if ((name === 'mv' || name === 'move') && files.length) { res.targets.push(...files.slice(0, -1)); res.dests.push(files[files.length - 1]); }
      else if (POSIX_LAST.has(name) && files.length) res.dests.push(files[files.length - 1]);
    }
  }
  return res;
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
      input.session_id ? `- 本会话 ID：${input.session_id}。写交接条目时填进"改动人"，做验收时填进验收记录的"验收方式"，用来确认开发和验收不是同一个会话。` : '',
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
    const recordsDir = cfg.records.replace(/\\/g, '/').replace(/\/$/, '');
    const guard = makeGuard(recordsDir, input.cwd || root);
    if (tool === 'Bash' || tool === 'PowerShell') {
      const v = shellViolations(String(ti.command || ''), tool === 'PowerShell');
      if (v.git) deny(`验收人不能提交或改动 git 记录（git ${v.git}），只能写验收记录。`);
      if (v.inplace) deny(`验收人不能用 ${v.inplace} 原地改文件，只能写验收记录。`);
      const bad = v.targets.find((t) => !guard.allowed(t)) ?? v.dests.find((t) => !guard.allowed(t, true));
      if (bad !== undefined) deny(`验收人只能写 ${recordsDir}/ 下的验收记录（临时文件可以放系统临时目录），这条命令会写或删 ${guard.show(bad)}。发现的问题写进验收记录，由开发去修。`);
      out(null);
    }
    const target = ti.file_path || ti.notebook_path || ti.path || '';
    if (!target) out(null);
    if (guard.allowed(target)) out(null);
    deny(`验收人只能写 ${recordsDir}/ 下的验收记录（临时文件可以放系统临时目录），不能改 ${guard.show(target)}。发现的问题写进验收记录，由开发去修。`);
  }

  out(null);
} catch {
  out(null);
}
