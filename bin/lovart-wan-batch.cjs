#!/usr/bin/env node
/**
 * 画布 Wan 3.0 批量入口（纯请求）。
 * 默认 dry-run：不 POST create。计费必须同时 --no-dry-run 与 --allow-create-once。
 * create 只发生在 lovart-wan-pure-master.sh → lovart-wan-create-once.cjs，每个 intent 最多一次。
 *
 * 硬规则（代码里判断，不是注释）：
 * - 同一充值号连续最多 2 条；第 2 条仍须过现场门闩（余额 ≥ 时长秒×4+2 且报价 < 余额）。
 * - 整批串行，上一条结束才开始下一条；批次锁禁止并行 create。
 * - 门闩失败或 Insufficient／无积分：停批，不换号。
 * - 余额 >100 且未记录用户已说「发送」：exit 4，不 create。
 * - 已有成功 generator_task_id 的 intent 不再 create。
 * - 双扣 ALERT：停。不把 ALERT 当成可以悄悄续跑。
 *
 * Exit: 0 完成（Mac 默认仍未核）；2 用法；3 无号或门闩；4 需用户；6 政策停。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = __dirname;
const REPO = path.resolve(BIN, '..');
const LEDGER = '/workspace/lovart-bot/state/wan-create-ledger.json';
const ALERT = '/tmp/lovart-wan-double-charge-ALERT.json';
const LOCK = '/tmp/lovart-wan-batch.lock';
const MAX_STREAK = 2;
const WASM_DEFAULT = '/tmp/lovart-wasm/sign.wasm';
const INSUFF_RE = /insufficient|not enough|don'?t have enough|do not have enough|no credits|余额不足|积分不足|没有足够/i;

function asNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function normAccount(id) {
  const s = String(id || '').trim();
  const m = s.match(/^(?:acc|L|l)(\d+)$/);
  return m ? `L${m[1]}` : s;
}

function evaluateGate(balance, price, duration) {
  const dur = Number(duration);
  if (!Number.isFinite(dur) || dur <= 0) {
    return { ok: false, code: 2, reason: 'bad_duration', need: null };
  }
  const need = dur * 4 + 2;
  if (balance == null || price == null) {
    return { ok: false, code: 3, reason: 'missing_quote', need, balance, price };
  }
  if (!(Number(balance) >= need)) {
    return { ok: false, code: 3, reason: 'balance_below_floor', need, balance, price };
  }
  if (!(Number(price) < Number(balance))) {
    return { ok: false, code: 3, reason: 'price_not_below_balance', need, balance, price };
  }
  return { ok: true, code: 0, reason: 'gate_ok', need, balance, price };
}

function specialAccountHold(balance, userSaidSend) {
  if (balance == null) return { hold: false, unknown: true };
  if (Number(balance) > 100 && !userSaidSend) {
    return { hold: true, code: 4, reason: 'special_account_needs_user_send' };
  }
  return { hold: false, unknown: false };
}

function selectQuote({ dryRun, fixtureBalance, fixturePrice, liveBalance, livePrice }) {
  if (!dryRun) {
    return { balance: asNumber(liveBalance), price: asNumber(livePrice), source: 'live' };
  }
  const balance = asNumber(fixtureBalance);
  const price = asNumber(fixturePrice);
  if (balance == null && price == null) return { balance: null, price: null, source: 'dry-unquoted' };
  return { balance, price, source: 'fixture' };
}

function streakDecision(streak) {
  if (streak > MAX_STREAK) {
    return {
      code: 6,
      reason: `同一充值号连续已满 ${MAX_STREAK} 条，禁止开始下一条。不自动换号。`,
    };
  }
  return { code: 0, reason: 'streak_ok' };
}

function taskIdOf(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (obj.balance_alert) return '';
  if (obj.generator_task_id && obj.error == null) return String(obj.generator_task_id);
  if (obj.prior && obj.prior.generator_task_id) return String(obj.prior.generator_task_id);
  if (obj.generator_task_id) return String(obj.generator_task_id);
  return '';
}

function ledgerTask(projectId, intent) {
  const L = readJson(LEDGER);
  if (!L) return '';
  for (const e of L.entries || []) {
    if (!e || !e.ok || !e.generator_task_id) continue;
    if (e.project_id !== projectId || e.intent !== intent) continue;
    return String(e.generator_task_id);
  }
  return '';
}

function existingTaskId(staging, projectId, intent) {
  const local = readJson(path.join(staging, 'create-once-result.json'));
  if (local && local.balance_alert) return '';
  const fromFile = taskIdOf(local);
  if (fromFile) return fromFile;
  return ledgerTask(projectId, intent);
}

function decideBeforeCreate({ balance, price, duration, userSaidSend, existingTaskId: existing, alertPresent, balanceAlert }) {
  if (alertPresent || balanceAlert) {
    return {
      code: 6,
      action: 'stop',
      reason: 'double_charge_alert',
      message: '双扣 ALERT 未清除，或结果里有 balance_alert。禁止 create。',
    };
  }
  if (existing) {
    return {
      code: 20,
      action: 'resume',
      reason: 'existing_generator_task_id',
      generator_task_id: existing,
      message: `已有 generator_task_id ${existing}，不再 POST create。`,
    };
  }
  const gate = evaluateGate(balance, price, duration);
  if (!gate.ok) {
    return {
      code: gate.code === 2 ? 2 : 3,
      action: 'stop',
      reason: gate.reason,
      need: gate.need,
      balance_before: balance,
      price,
      message: `积分门闩未过：余额 ${balance}，报价 ${price}，门槛 ${gate.need}（时长秒×4+2）。不 create，不换号。`,
    };
  }
  const special = specialAccountHold(balance, userSaidSend);
  if (special.hold) {
    return {
      code: 4,
      action: 'stop',
      reason: special.reason,
      balance_before: balance,
      price,
      message: `余额 ${balance} > 100。需要用户先说「发送」，并写入 user_said_send 或 --user-said-send。本次不 create。`,
    };
  }
  return {
    code: 0,
    action: 'create',
    reason: 'gate_ok',
    balance_before: balance,
    price,
    duration: Number(duration),
    need: gate.need,
    message: '门闩通过，允许单次 create。',
  };
}

function acquireBatchLock() {
  const stealIfDead = () => {
    let cur = null;
    try {
      cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    } catch {
      cur = null;
    }
    const pid = cur && cur.pid;
    let alive = false;
    if (pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        alive = e.code === 'EPERM';
      }
    }
    if (alive) return false;
    try {
      fs.unlinkSync(LOCK);
    } catch {
      return false;
    }
    return true;
  };
  const open = () => {
    const fd = fs.openSync(LOCK, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return {
      ok: true,
      fd,
      release() {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
        try {
          const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
          if (cur && cur.pid === process.pid) fs.unlinkSync(LOCK);
        } catch {
          /* lock already gone */
        }
      },
    };
  };
  try {
    return open();
  } catch (e) {
    if (e.code !== 'EEXIST') {
      return { ok: false, code: 6, reason: `批次锁失败：${e.message}` };
    }
  }
  if (!stealIfDead()) {
    return { ok: false, code: 6, reason: '已有批次在跑（lock），禁止并行 create。' };
  }
  try {
    return open();
  } catch (e) {
    return { ok: false, code: 6, reason: `批次锁无法获取，禁止并行 create。（${e.message}）` };
  }
}

function saidSend(value) {
  return value === true || value === 'true' || value === '发送';
}

function loadTemplates() {
  const p = path.join(REPO, 'docs/batch-forward.template.md');
  const text = fs.readFileSync(p, 'utf8');
  function section(name) {
    const re = new RegExp(`(?:^|\\n)## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`);
    const m = text.match(re);
    if (!m) throw new Error(`模板缺少 ## ${name}`);
    const line = m[1]
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (!line || !line.includes('{{')) throw new Error(`模板 ## ${name} 没有可填的句子`);
    return line;
  }
  return { item: section('item'), batch: section('batch') };
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\{\{([a-z0-9_]+)\}\}/g, (_, k) => {
    const v = vars[k];
    if (v == null || v === '') return '（无）';
    return String(v).replace(/\s+/g, ' ').trim();
  });
}

function shanghaiNow() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date()) + ' Asia/Shanghai';
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function spawnLogged(trace, cmd, args, extra) {
  const base = path.basename(cmd);
  if (base === 'switch-profile.sh' || String(cmd).includes('switch-profile.sh')) {
    const err = new Error('REFUSE bare switch-profile.sh；画布切 Profile 只用 lovart-canvas-chrome.sh');
    err.code = 6;
    throw err;
  }
  const shown = [cmd, ...args].map(shellQuote).join(' ');
  fs.appendFileSync(trace, `$ ${shown}\n`);
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: (extra && extra.env) || process.env,
  });
  const status = r.status == null ? 1 : r.status;
  fs.appendFileSync(trace, `exit=${status}\n`);
  if (r.stdout) fs.appendFileSync(trace, String(r.stdout).slice(0, 4000) + '\n');
  if (r.stderr) fs.appendFileSync(trace, String(r.stderr).slice(0, 4000) + '\n');
  return r;
}

function resolveExisting(p, manifestDir) {
  if (!p) return '';
  if (path.isAbsolute(p)) return p;
  const candidates = [path.resolve(manifestDir, p), path.resolve(process.cwd(), p), path.resolve(REPO, p)];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return path.resolve(manifestDir, p);
}

function parsePick(stdout) {
  const line = String(stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .pop() || '';
  if (!line || line.startsWith('NONE')) return { ok: false, id: '', line };
  return { ok: true, id: line.split(/\s+/)[0], line };
}

function mapExit(code, staging, stderr) {
  const upload = readJson(path.join(staging, 'upload-body-result.json')) || {};
  const check = readJson(path.join(staging, 'pre-create-check.json')) || {};
  const created = readJson(path.join(staging, 'create-once-result.json')) || {};
  const blob = [stderr || '', JSON.stringify(upload), JSON.stringify(check), JSON.stringify(created)].join('\n');
  if (INSUFF_RE.test(blob)) {
    return { code: 4, message: '平台返回 Insufficient／无积分。批次已停，不换号。请用户处理。' };
  }
  if (code === 12 || created.balance_alert) {
    return { code: 6, message: '疑似双扣，已写 ALERT。批次已停，禁止再 create。' };
  }
  if (code === 4 || check.code === 4) {
    return { code: 4, message: check.message || '需要用户确认后才能继续。本次不 create，不换号。' };
  }
  if (code === 3 || upload.error === 'gate_fail' || check.code === 3) {
    const bal = upload.balanceBefore != null ? upload.balanceBefore : check.balance_before;
    const price = upload.price != null ? upload.price : check.price;
    const need = upload.minBal != null ? upload.minBal : check.need;
    return {
      code: 3,
      message: `积分门闩未过：余额 ${bal}，报价 ${price}，门槛 ${need}（时长秒×4+2）。批次已停，不换号。`,
    };
  }
  if ([5, 6, 7, 8, 9, 10, 11].includes(code) || [6, 7, 8, 9, 10, 11].includes(check.code)) {
    return {
      code: 6,
      message: check.message || `政策停止（退出 ${code || check.code}）。不重试 create，不换号。`,
    };
  }
  if (code === 0) return { code: 0, message: '' };
  return { code: code || 1, message: `子进程退出 ${code}。批次已停，不换号，不重试 create。` };
}

function blank(v, empty) {
  if (v == null || v === '') return empty;
  return String(v);
}

function renderItemLine(templates, report) {
  return fillTemplate(templates.item, {
    account: report.account,
    profile: report.profile,
    email: report.email,
    balance_before: blank(report.balance_before, '（无）'),
    balance_after: blank(report.balance_after, '（无）'),
    price: blank(report.price, '（无）'),
    generator_task_id: blank(report.generator_task_id, '（未 create）'),
    box_path: blank(report.box_path, '（未下载）'),
    size: blank(report.size, '（无）'),
    md5: blank(report.md5, '（无）'),
    mp4_duration: blank(report.mp4_duration, '（无）'),
    mac_status: report.mac_status || 'Mac 未拷贝，三处 md5 未核',
    note: report.note || '（无）',
  });
}

function renderBatchLine(templates, summary) {
  return fillTemplate(templates.batch, summary);
}

function writeAggregate(outDir, templates, reports, summary) {
  fs.mkdirSync(outDir, { recursive: true });
  const lines = [
    '# 出片进度',
    '',
    `- 模式: ${summary.mode}`,
    `- 更新时间: ${shanghaiNow()}`,
    `- 计划: ${summary.item_count} 条`,
    `- 已跑完: ${summary.done_count}`,
    `- 停止原因: ${summary.stop_reason}`,
    '',
  ];
  const forward = [];
  reports.forEach((report, i) => {
    const sentence = renderItemLine(templates, report);
    forward.push(sentence);
    lines.push(`## ${i + 1} ${report.intent || '（未开始）'}`);
    lines.push('');
    lines.push(`- 状态: ${report.stateLabel}`);
    lines.push(`- 账号: ${report.account || '（无）'}`);
    lines.push(`- Profile: ${report.profile || '（无）'}`);
    lines.push(`- 邮箱: ${report.email || '（无）'}`);
    lines.push(`- 余额: ${blank(report.balance_before, '（无）')} → ${blank(report.balance_after, '（无）')}`);
    lines.push(`- 报价: ${blank(report.price, '（无）')}（${report.quote_source || '无'}）`);
    lines.push(`- generator_task_id: ${blank(report.generator_task_id, '（未 create）')}`);
    lines.push(`- box: ${blank(report.box_path, '（未下载）')}`);
    lines.push(`- size: ${blank(report.size, '（无）')}`);
    lines.push(`- md5: ${blank(report.md5, '（无）')}`);
    lines.push(`- 片长: ${blank(report.mp4_duration, '（无）')}`);
    lines.push(`- Mac: ${report.mac_status || 'Mac 未拷贝，三处 md5 未核'}`);
    if (report.detail) lines.push(`- 附注: ${report.detail}`);
    lines.push('');
    lines.push('### 可原样转发');
    lines.push('');
    lines.push(sentence);
    lines.push('');
  });
  const batchLine = renderBatchLine(templates, summary);
  forward.push(batchLine);
  lines.push('## 汇总');
  lines.push('');
  lines.push('### 可原样转发');
  lines.push('');
  lines.push(batchLine);
  lines.push('');
  fs.writeFileSync(path.join(outDir, '出片进度.md'), lines.join('\n'));
  fs.writeFileSync(path.join(outDir, '转发.txt'), forward.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'batch-report.json'), JSON.stringify({ summary, reports }, null, 2));
  return { batchLine, forward };
}

function writeItemFiles(staging, markdownSnippet, sentence) {
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, '出片进度.md'), markdownSnippet);
  fs.writeFileSync(path.join(staging, '转发.txt'), sentence + '\n');
}

function pendingRecipe(staging, item, macProduct, macProject) {
  const name = item.output_mp4;
  const recipe = {
    mac_copy_status: 'not_downloaded',
    mac_verified: false,
    three_md5_ok: false,
    box_path: '',
    md5: '',
    size: null,
    split: false,
    limit_bytes: 10 * 1024 * 1024,
    parts: [],
    mac_product_dir: macProduct,
    mac_project_dir: macProject,
    output_name: name,
    note: '尚无成片。未执行 CopyFromBox，未跑 Mac 拷贝，三处 md5 未核。',
    mac_command: [
      'lovart-wan-copy-mac-master.sh',
      '--name',
      shellQuote(name),
      '--src',
      shellQuote(`~/.grok-staging/${name}`),
      '--mac-product-dir',
      shellQuote(macProduct),
      '--mac-project-dir',
      shellQuote(macProject),
    ].join(' '),
  };
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'copy-recipe.json'), JSON.stringify(recipe, null, 2));
}

function baseReport(partial) {
  return {
    index: partial.index,
    intent: partial.intent || '',
    account: partial.account || '',
    profile: partial.profile == null ? '' : String(partial.profile),
    email: partial.email || '',
    balance_before: partial.balance_before == null ? '' : partial.balance_before,
    balance_after: partial.balance_after == null ? '' : partial.balance_after,
    price: partial.price == null ? '' : partial.price,
    quote_source: partial.quote_source || '',
    generator_task_id: partial.generator_task_id || '',
    box_path: partial.box_path || '',
    size: partial.size == null ? '' : partial.size,
    md5: partial.md5 || '',
    mp4_duration: partial.mp4_duration == null ? '' : partial.mp4_duration,
    mac_status: partial.mac_status || 'Mac 未拷贝，三处 md5 未核',
    note: partial.note || '',
    detail: partial.detail || '',
    stateLabel: partial.stateLabel || '',
    code: partial.code,
  };
}

function writeDryGate(staging, report, duration, projectId) {
  const args = [
    path.join(BIN, 'lovart-wan-write-gate-result.cjs'),
    '--staging',
    staging,
    '--title',
    report.intent,
    '--set',
    `intent=${report.intent}`,
    '--set',
    `project_id=${projectId}`,
    '--set',
    `duration=${duration}`,
    '--set',
    `profile=${report.profile}`,
    '--set',
    `account=${report.account}`,
    '--set',
    `expect_email=${report.email}`,
    '--set',
    `balance_before=${report.balance_before}`,
    '--set',
    `price=${report.price}`,
    '--set',
    `generator_task_id=${report.generator_task_id || ''}`,
    '--set',
    'path=pure-request',
    '--set',
    'ok=true',
    '--set',
    'billable_creates=0',
    '--set',
    'dry_run=1',
    '--set',
    'stopped_short=dry-run:未create',
    '--set',
    'mac_copy_status=not_downloaded',
    '--set',
    'mac_md5_ok=false',
    '--set',
    `note=${report.note}`,
  ];
  return args;
}

function runItem(ctx) {
  const { item, account, opts, state, trace, index, streak } = ctx;
  const staging = item.stagingAbs;
  const duration = item.duration;
  const said = saidSend(item.user_said_send) || saidSend(account.user_said_send) || state.userSaid.has(account.id) || state.userSaid.has(normAccount(account.id));
  const streakHit = streakDecision(streak);
  if (streakHit.code !== 0) {
    return {
      code: 6,
      report: baseReport({
        index,
        intent: item.intent,
        account: account.id,
        profile: account.chrome_profile,
        email: account.expect_email,
        note: streakHit.reason,
        stateLabel: '未开始',
        code: 6,
        quote_source: opts.dryRun ? '未跑' : '未跑',
      }),
    };
  }

  fs.mkdirSync(staging, { recursive: true });
  if (fs.existsSync(ALERT)) {
    return {
      code: 6,
      report: baseReport({
        index,
        intent: item.intent,
        account: account.id,
        profile: account.chrome_profile,
        email: account.expect_email,
        note: '双扣 ALERT 未清除。批次已停，禁止 create。',
        stateLabel: '政策停止',
        code: 6,
      }),
    };
  }

  const existing = existingTaskId(staging, account.project_id, item.intent);
  const quote = selectQuote({
    dryRun: opts.dryRun,
    fixtureBalance: item.fixture_balance,
    fixturePrice: item.fixture_price,
    liveBalance: null,
    livePrice: null,
  });

  if (opts.dryRun && quote.source === 'fixture') {
    const gate = evaluateGate(quote.balance, quote.price, duration);
    if (!gate.ok) {
      return {
        code: 3,
        report: baseReport({
          index,
          intent: item.intent,
          account: account.id,
          profile: account.chrome_profile,
          email: account.expect_email,
          balance_before: quote.balance,
          price: quote.price,
          quote_source: 'fixture',
          generator_task_id: existing || '',
          note: `积分门闩未过：余额 ${quote.balance}，报价 ${quote.price}，门槛 ${gate.need}（时长秒×4+2）。批次已停，不换号。dry-run 未 create。`,
          stateLabel: '门闩未过',
          code: 3,
        }),
      };
    }
    const special = specialAccountHold(quote.balance, said);
    if (special.hold) {
      return {
        code: 4,
        report: baseReport({
          index,
          intent: item.intent,
          account: account.id,
          profile: account.chrome_profile,
          email: account.expect_email,
          balance_before: quote.balance,
          price: quote.price,
          quote_source: 'fixture',
          note: `余额 ${quote.balance} > 100。manifest / --user-said-send 没有记录用户已说「发送」。需要用户确认。本次不 create，不换号。`,
          stateLabel: '等待用户说发送',
          code: 4,
        }),
      };
    }
  }

  const ensure = spawnLogged(trace, path.join(BIN, 'lovart-anti-cookie-ensure.sh'), []);
  if (ensure.status !== 0 && !opts.dryRun) {
    return {
      code: 6,
      report: baseReport({
        index,
        intent: item.intent,
        account: account.id,
        profile: account.chrome_profile,
        email: account.expect_email,
        note: 'lovart-anti-cookie-ensure.sh 失败。未 create。',
        stateLabel: '政策停止',
        code: 6,
      }),
    };
  }

  const pick = spawnLogged(trace, path.join(BIN, 'lovart-cli-pick-recharge.sh'), ['canvas', String(duration)]);
  const picked = parsePick(pick.stdout);
  let pickNote = '';
  if (!opts.dryRun) {
    if (pick.status !== 0 || !picked.ok) {
      return {
        code: 3,
        report: baseReport({
          index,
          intent: item.intent,
          account: account.id,
          profile: account.chrome_profile,
          email: account.expect_email,
          note: `选号/门闩：lovart-cli-pick-recharge.sh 退出 ${pick.status}。批次已停，不换号。`,
          stateLabel: '无号或门闩',
          code: 3,
        }),
      };
    }
    if (normAccount(picked.id) !== normAccount(account.id)) {
      pickNote = `选号脚本给出 ${picked.id}，本批不改用它，仍用 manifest 账号 ${account.id}。`;
    }
  } else if (pick.status !== 0 || !picked.ok) {
    pickNote = `选号脚本退出 ${pick.status == null ? 1 : pick.status}，dry-run 仍用 manifest 账号 ${account.id}，不换号。`;
  } else if (normAccount(picked.id) !== normAccount(account.id)) {
    pickNote = `选号脚本给出 ${picked.id}，本批不改用它，仍用 ${account.id}。`;
  }

  if (!opts.dryRun) {
    if (state.chrome !== String(account.chrome_profile)) {
      const chrome = spawnLogged(trace, path.join(BIN, 'lovart-canvas-chrome.sh'), [String(account.chrome_profile)]);
      if (chrome.status !== 0) {
        return {
          code: 4,
          report: baseReport({
            index,
            intent: item.intent,
            account: account.id,
            profile: account.chrome_profile,
            email: account.expect_email,
            note: `画布 Chrome Profile ${account.chrome_profile} 未就绪（lovart-canvas-chrome.sh）。未 create。`,
            stateLabel: '需要用户',
            code: 4,
          }),
        };
      }
      state.chrome = String(account.chrome_profile);
    }
  }

  if (!opts.dryRun && existing) {
    if (state.createdIntents.has(item.intent)) {
      return {
        code: 6,
        report: baseReport({
          index,
          intent: item.intent,
          account: account.id,
          profile: account.chrome_profile,
          email: account.expect_email,
          generator_task_id: existing,
          note: '同一进程内禁止对同一 intent 第二次 create。',
          stateLabel: '政策停止',
          code: 6,
        }),
      };
    }
    const finishArgs = finishArgsFor(item, account, staging, opts);
    const finish = spawnLogged(trace, process.execPath, finishArgs);
    const status = readJson(path.join(staging, 'item-status.json')) || {};
    const mapped = finish.status === 0 ? { code: 0, message: '' } : mapExit(finish.status == null ? 1 : finish.status, staging, finish.stderr);
    return {
      code: mapped.code,
      report: reportFromStatus(index, account, item, status, {
        code: mapped.code,
        note: [status.note || mapped.message || '沿用已有 generator_task_id，未再 POST。', pickNote].filter(Boolean).join(''),
        stateLabel: mapped.code === 0 ? '已下载（未再 create）' : '已停',
        generator_task_id: existing,
      }),
    };
  }

  const pureArgs = [
    path.join(BIN, 'lovart-wan-pure-master.sh'),
    '--prompt',
    item.promptAbs,
    '--staging',
    staging,
    '--project',
    account.project_id,
    '--profile',
    String(account.chrome_profile),
    '--duration',
    String(duration),
    '--intent',
    item.intent,
    '--account',
    account.id,
    '--expect-email',
    account.expect_email,
    '--out-mp4',
    item.mp4Abs,
    '--mac-product-dir',
    ctx.macProduct,
    '--mac-project-dir',
    ctx.macProject,
    '--skip-pick',
    '--skip-ensure',
  ];
  for (const [flag, key] of [
    ['--env', 'env'],
    ['--front', 'front'],
    ['--oblique', 'oblique'],
    ['--side', 'side'],
    ['--audio', 'audio'],
  ]) {
    if (item.assets[key]) pureArgs.push(flag, item.assets[key]);
  }
  if (opts.wasm) pureArgs.push('--wasm', opts.wasm);
  if (said) pureArgs.push('--user-said-send');
  if (opts.dryRun) {
    pureArgs.push('--dry-run');
    const wasm = opts.wasm || WASM_DEFAULT;
    if (!fs.existsSync(wasm)) pureArgs.push('--skip-sign');
  } else {
    if (state.createdIntents.has(item.intent)) {
      return {
        code: 6,
        report: baseReport({
          index,
          intent: item.intent,
          account: account.id,
          profile: account.chrome_profile,
          email: account.expect_email,
          note: '同一进程内禁止对同一 intent 第二次 create。',
          stateLabel: '政策停止',
          code: 6,
        }),
      };
    }
    state.createdIntents.add(item.intent);
    pureArgs.push('--no-dry-run', '--allow-create-once');
  }
  if (opts.dryRun && (pureArgs.includes('--allow-create-once') || pureArgs.includes('--no-dry-run'))) {
    throw new Error('internal: dry-run args included a create flag');
  }

  const hadCreateResult = fs.existsSync(path.join(staging, 'create-once-result.json'));
  const pure = spawnLogged(trace, 'bash', pureArgs);
  if (opts.dryRun && !hadCreateResult && fs.existsSync(path.join(staging, 'create-once-result.json'))) {
    return {
      code: 6,
      report: baseReport({
        index,
        intent: item.intent,
        account: account.id,
        profile: account.chrome_profile,
        email: account.expect_email,
        note: 'dry-run 却出现 create-once 结果文件。已停，请检查脚本。',
        stateLabel: '政策停止',
        code: 6,
      }),
    };
  }
  if (pure.status !== 0) {
    const mapped = mapExit(pure.status == null ? 1 : pure.status, staging, (pure.stderr || '') + (pure.stdout || ''));
    const upload = readJson(path.join(staging, 'upload-body-result.json')) || {};
    return {
      code: mapped.code,
      report: baseReport({
        index,
        intent: item.intent,
        account: account.id,
        profile: account.chrome_profile,
        email: account.expect_email,
        balance_before: upload.balanceBefore != null ? upload.balanceBefore : quote.balance,
        price: upload.price != null ? upload.price : quote.price,
        quote_source: opts.dryRun ? quote.source : 'live',
        note: [mapped.message, pickNote].filter(Boolean).join(''),
        stateLabel: mapped.code === 3 ? '门闩未过' : mapped.code === 4 ? '需要用户' : '已停',
        code: mapped.code,
      }),
    };
  }

  if (opts.dryRun) {
    const note = [
      'dry-run 未 POST create。',
      quote.source === 'fixture' ? '余额/报价来自 manifest fixture，不是现场询价。' : '未做现场询价。',
      existing ? `staging/账本已有 generator_task_id ${existing}，本次未再 create，也未下载。` : '',
      '不自动换号。不自动剪辑。等用户说「剪」。',
    ]
      .filter(Boolean)
      .join('');
    const report = baseReport({
      index,
      intent: item.intent,
      account: account.id,
      profile: account.chrome_profile,
      email: account.expect_email,
      balance_before: quote.balance == null ? '' : quote.balance,
      price: quote.price == null ? '' : quote.price,
      quote_source: quote.source,
      generator_task_id: existing || '',
      note,
      detail: pickNote,
      stateLabel: 'dry-run 未 create',
      code: 0,
      mac_status: 'Mac 未拷贝，三处 md5 未核',
    });
    pendingRecipe(staging, item, ctx.macProduct, ctx.macProject);
    const gateArgs = writeDryGate(staging, report, duration, account.project_id);
    const gate = spawnLogged(trace, process.execPath, gateArgs);
    if (gate.status !== 0) {
      return {
        code: gate.status || 1,
        report: baseReport({
          ...report,
          note: 'write-gate-result 失败。未 create。',
          stateLabel: '已停',
          code: gate.status || 1,
        }),
      };
    }
    fs.writeFileSync(
      path.join(staging, 'item-status.json'),
      JSON.stringify({ ...report, dry_run: true, created: false, mac_verified: false, three_md5_ok: false }, null, 2)
    );
    return { code: 0, report };
  }

  const status = readJson(path.join(staging, 'item-status.json')) || {};
  return {
    code: 0,
    report: reportFromStatus(index, account, item, status, {
      code: 0,
      stateLabel: status.mac_verified ? '已下载且 Mac 已核' : '已下载，Mac 未核',
      note: [status.note || '已下载。Mac 未核。等用户说「剪」。', pickNote].filter(Boolean).join(''),
    }),
  };
}

function finishArgsFor(item, account, staging, opts) {
  const args = [
    path.join(BIN, 'lovart-wan-finish-item.cjs'),
    '--staging',
    staging,
    '--result',
    path.join(staging, 'create-once-result.json'),
    '--project',
    account.project_id,
    '--intent',
    item.intent,
    '--duration',
    String(item.duration),
    '--profile',
    String(account.chrome_profile),
    '--account',
    account.id,
    '--expect-email',
    account.expect_email,
    '--out-mp4',
    item.mp4Abs,
    '--mac-product-dir',
    item.macProduct,
    '--mac-project-dir',
    item.macProject,
  ];
  const token = `/tmp/l${account.chrome_profile}-usertoken.txt`;
  if (fs.existsSync(token)) args.push('--token-file', token);
  if (opts.wasm) args.push('--wasm', opts.wasm);
  return args;
}

function reportFromStatus(index, account, item, status, overlay) {
  return baseReport({
    index,
    intent: item.intent,
    account: account.id,
    profile: account.chrome_profile,
    email: account.expect_email,
    balance_before: status.balance_before,
    balance_after: status.balance_after,
    price: status.price,
    quote_source: status.quote_source || 'live',
    generator_task_id: overlay.generator_task_id || status.generator_task_id,
    box_path: status.box_path,
    size: status.size,
    md5: status.md5,
    mp4_duration: status.mp4_duration,
    mac_status: status.mac_verified ? 'Mac 已核，三处 md5 一致' : 'Mac 未拷贝，三处 md5 未核',
    note: overlay.note,
    stateLabel: overlay.stateLabel,
    code: overlay.code,
  });
}

function summarize(reports, opts, stopMessage) {
  const done = reports.filter((r) => r.code === 0 && r.stateLabel !== '未开始').length;
  return {
    mode: opts.dryRun ? 'dry-run' : '计费',
    item_count: String(reports.length),
    done_count: String(done),
    stop_reason: stopMessage || (reports.every((r) => r.code === 0) ? '全部按规则跑完。Mac 拷贝未在本机核验。' : '已停'),
  };
}

function executeManifest(manifest, opts, manifestDir) {
  const templates = loadTemplates();
  const workRoot = path.resolve(opts.workRoot || '/tmp/lovart-wan-batch');
  const outDir = path.resolve(opts.out || path.join(workRoot, 'report'));
  fs.mkdirSync(outDir, { recursive: true });
  const trace = path.join(outDir, 'tool-trace.txt');
  fs.writeFileSync(trace, `# lovart-wan-batch ${shanghaiNow()} dry=${opts.dryRun} allow=${!!opts.allowCreate}\n`);

  const accounts = new Map();
  for (const a of manifest.accounts || []) accounts.set(a.id, a);
  const macProduct = manifest.mac_product_dir;
  const macProject = manifest.mac_project_dir;
  const prepared = [];
  const seenIntent = new Set();
  const seenName = new Set();
  for (const raw of manifest.items || []) {
    const account = accounts.get(raw.account_id);
    if (!account) {
      console.error(`manifest 账号不存在: ${raw.account_id}`);
      return 2;
    }
    if (seenIntent.has(raw.intent)) {
      console.error(`manifest intent 重复: ${raw.intent}。禁止对同一 intent 创建两次。`);
      return 6;
    }
    seenIntent.add(raw.intent);
    if (seenName.has(raw.output_mp4)) {
      console.error(`output_mp4 重复: ${raw.output_mp4}`);
      return 2;
    }
    seenName.add(raw.output_mp4);
    const stagingAbs = path.isAbsolute(raw.staging) ? raw.staging : path.join(workRoot, raw.staging);
    const assets = {};
    const merged = Object.assign({}, manifest.assets || {}, raw.assets || {});
    for (const key of ['env', 'front', 'oblique', 'side', 'audio']) {
      if (merged[key]) assets[key] = resolveExisting(merged[key], manifestDir);
    }
    prepared.push({
      ...raw,
      stagingAbs,
      promptAbs: resolveExisting(raw.prompt, manifestDir),
      mp4Abs: path.join(stagingAbs, '04-生成', raw.output_mp4),
      assets,
      macProduct,
      macProject,
      account,
    });
  }

  for (const item of prepared) {
    if (!fs.existsSync(item.promptAbs)) {
      console.error('prompt 不存在', item.promptAbs);
      return 2;
    }
    for (const key of ['env', 'front', 'oblique', 'side', 'audio']) {
      if (!item.assets[key] || !fs.existsSync(item.assets[key])) {
        console.error(`素材不存在 ${key}`, item.assets[key]);
        return 2;
      }
    }
    if (!item.output_mp4 || item.output_mp4.includes('/') || item.output_mp4.includes('..') || !item.output_mp4.endsWith('.mp4')) {
      console.error('output_mp4 必须是文件名且以 .mp4 结尾', item.output_mp4);
      return 2;
    }
  }

  const state = {
    chrome: null,
    createdIntents: new Set(),
    userSaid: new Set(opts.userSaid || []),
  };
  const reports = [];
  let finalCode = 0;
  let stopMessage = '';
  let lastAccount = null;
  let streak = 0;
  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i];
    const account = item.account;
    streak = normAccount(account.id) === normAccount(lastAccount) ? streak + 1 : 1;
    lastAccount = account.id;
    let outcome;
    try {
      outcome = runItem({
        item,
        account,
        opts,
        state,
        trace,
        index: i + 1,
        streak,
        macProduct,
        macProject,
      });
    } catch (e) {
      outcome = {
        code: e.code === 6 ? 6 : 1,
        report: baseReport({
          index: i + 1,
          intent: item.intent,
          account: account.id,
          profile: account.chrome_profile,
          email: account.expect_email,
          note: e.message || String(e),
          stateLabel: '已停',
          code: e.code === 6 ? 6 : 1,
        }),
      };
    }
    reports.push(outcome.report);
    const sentence = renderItemLine(templates, outcome.report);
    writeItemFiles(
      item.stagingAbs,
      `# 出片进度 ${item.intent}\n\n${sentence}\n`,
      sentence
    );
    if (!fs.existsSync(path.join(item.stagingAbs, 'copy-recipe.json'))) {
      pendingRecipe(item.stagingAbs, item, item.macProduct, item.macProject);
    }
    console.log(sentence);
    if (outcome.code !== 0) {
      finalCode = outcome.code;
      stopMessage = outcome.report.note || `退出 ${outcome.code}`;
      for (let j = i + 1; j < prepared.length; j++) {
        const rest = prepared[j];
        reports.push(
          baseReport({
            index: j + 1,
            intent: rest.intent,
            account: rest.account.id,
            profile: rest.account.chrome_profile,
            email: rest.account.expect_email,
            note: '前序已停，本条未开始。不自动换号。',
            stateLabel: '未开始',
            code: null,
          })
        );
      }
      break;
    }
    const summaryNow = summarize(reports, opts, '进行中');
    summaryNow.item_count = String(prepared.length);
    writeAggregate(outDir, templates, reports, summaryNow);
  }
  const summary = summarize(reports, opts, stopMessage);
  summary.item_count = String(prepared.length);
  const agg = writeAggregate(outDir, templates, reports, summary);
  console.log(agg.batchLine);
  console.error(`[batch] exit ${finalCode} report ${outDir}`);
  return finalCode;
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.accounts) || !manifest.accounts.length) return 'accounts 不能为空';
  if (!Array.isArray(manifest.items) || !manifest.items.length) return 'items 不能为空';
  if (!manifest.mac_product_dir || !manifest.mac_project_dir) return '需要 mac_product_dir 与 mac_project_dir';
  for (const a of manifest.accounts) {
    if (!a.id || a.chrome_profile == null || !a.expect_email || !a.project_id) {
      return `账号字段不全（id / chrome_profile / expect_email / project_id）: ${a.id || '?'}`;
    }
    if (!String(a.expect_email).includes('@')) return `expect_email 不像邮箱: ${a.id}`;
    if (!Number.isInteger(Number(a.chrome_profile))) return `chrome_profile 必须是整数: ${a.id}`;
  }
  for (const item of manifest.items) {
    for (const k of ['prompt', 'staging', 'duration', 'intent', 'output_mp4', 'account_id']) {
      if (item[k] == null || item[k] === '') return `条目缺少 ${k}`;
    }
    if (!Number.isInteger(Number(item.duration)) || Number(item.duration) <= 0) return `duration 必须是正整数: ${item.intent}`;
  }
  return '';
}

function flagsRefuse(opts) {
  if (opts.allowCreate && opts.dryRun) {
    console.error('REFUSE: --allow-create-once 必须同时 --no-dry-run');
    return 6;
  }
  if (!opts.dryRun && !opts.allowCreate) {
    console.error('REFUSE: --no-dry-run 必须同时 --allow-create-once。默认 dry-run 不会 create。');
    return 6;
  }
  return 0;
}

function take(argv, i) {
  if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) {
    throw new Error(`缺少参数值: ${argv[i]}`);
  }
  return argv[i + 1];
}

function parseBatchArgs(argv) {
  const opts = { dryRun: true, allowCreate: false, userSaid: [], wasm: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-dry-run') opts.dryRun = false;
    else if (a === '--allow-create-once') opts.allowCreate = true;
    else if (a === '--manifest') opts.manifest = take(argv, i++);
    else if (a === '--out') opts.out = take(argv, i++);
    else if (a === '--work-root') opts.workRoot = take(argv, i++);
    else if (a === '--wasm') opts.wasm = take(argv, i++);
    else if (a === '--user-said-send') opts.userSaid.push(take(argv, i++));
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`未知参数 ${a}`);
  }
  return opts;
}

function batchCli(argv) {
  let opts;
  try {
    opts = parseBatchArgs(argv);
  } catch (e) {
    console.error(e.message);
    help();
    return 2;
  }
  if (opts.help) {
    help();
    return 0;
  }
  const refused = flagsRefuse(opts);
  if (refused) return refused;
  if (!opts.manifest) {
    console.error('需要 --manifest');
    help();
    return 2;
  }
  const manifestPath = path.resolve(opts.manifest);
  const manifest = readJson(manifestPath);
  if (!manifest) {
    console.error('manifest 读不了', manifestPath);
    return 2;
  }
  const why = validateManifest(manifest);
  if (why) {
    console.error(why);
    return 2;
  }
  const lock = acquireBatchLock();
  if (!lock.ok) {
    console.error(lock.reason);
    return lock.code;
  }
  try {
    return executeManifest(manifest, opts, path.dirname(manifestPath));
  } finally {
    lock.release();
  }
}

function parseOnceArgs(argv) {
  const opts = { dryRun: true, allowCreate: false, userSaid: [], wasm: '', once: {} };
  const o = opts.once;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') continue;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-dry-run') opts.dryRun = false;
    else if (a === '--allow-create-once') opts.allowCreate = true;
    else if (a === '--user-said-send') o.userSaid = true;
    else if (a === '--prompt') o.prompt = take(argv, i++);
    else if (a === '--staging') o.staging = take(argv, i++);
    else if (a === '--project') o.project = take(argv, i++);
    else if (a === '--profile') o.profile = take(argv, i++);
    else if (a === '--account') o.account = take(argv, i++);
    else if (a === '--expect-email') o.email = take(argv, i++);
    else if (a === '--duration') o.duration = take(argv, i++);
    else if (a === '--intent') o.intent = take(argv, i++);
    else if (a === '--output-mp4') o.output = take(argv, i++);
    else if (a === '--mac-product-dir') o.macProduct = take(argv, i++);
    else if (a === '--mac-project-dir') o.macProject = take(argv, i++);
    else if (a === '--fixture-balance') o.fixtureBalance = take(argv, i++);
    else if (a === '--fixture-price') o.fixturePrice = take(argv, i++);
    else if (a === '--env') o.env = take(argv, i++);
    else if (a === '--front') o.front = take(argv, i++);
    else if (a === '--oblique') o.oblique = take(argv, i++);
    else if (a === '--side') o.side = take(argv, i++);
    else if (a === '--audio') o.audio = take(argv, i++);
    else if (a === '--consecutive') o.consecutive = take(argv, i++);
    else if (a === '--out') opts.out = take(argv, i++);
    else if (a === '--work-root') opts.workRoot = take(argv, i++);
    else if (a === '--wasm') opts.wasm = take(argv, i++);
    else throw new Error(`未知参数 ${a}`);
  }
  return opts;
}

function onceCli(argv) {
  let opts;
  try {
    opts = parseOnceArgs(argv);
  } catch (e) {
    console.error(e.message);
    help();
    return 2;
  }
  const refused = flagsRefuse(opts);
  if (refused) return refused;
  const o = opts.once;
  const need = ['prompt', 'staging', 'project', 'profile', 'account', 'email', 'duration', 'intent', 'output', 'macProduct', 'macProject'];
  for (const k of need) {
    if (!o[k]) {
      console.error(`--once 缺少 --${k === 'macProduct' ? 'mac-product-dir' : k === 'macProject' ? 'mac-project-dir' : k === 'output' ? 'output-mp4' : k === 'email' ? 'expect-email' : k}`);
      return 2;
    }
  }
  const consecutive = o.consecutive == null ? 1 : Number(o.consecutive);
  const streak = streakDecision(consecutive);
  if (streak.code !== 0) {
    console.error(streak.reason);
    return 6;
  }
  if (o.userSaid) opts.userSaid.push(o.account);
  const manifest = {
    mac_product_dir: o.macProduct,
    mac_project_dir: o.macProject,
    assets: { env: o.env, front: o.front, oblique: o.oblique, side: o.side, audio: o.audio },
    accounts: [
      {
        id: o.account,
        chrome_profile: Number(o.profile),
        expect_email: o.email,
        project_id: o.project,
        user_said_send: !!o.userSaid,
      },
    ],
    items: [
      {
        prompt: o.prompt,
        staging: o.staging,
        duration: Number(o.duration),
        intent: o.intent,
        output_mp4: o.output,
        account_id: o.account,
        fixture_balance: o.fixtureBalance,
        fixture_price: o.fixturePrice,
      },
    ],
  };
  const why = validateManifest(manifest);
  if (why) {
    console.error(why);
    return 2;
  }
  const lock = acquireBatchLock();
  if (!lock.ok) {
    console.error(lock.reason);
    return lock.code;
  }
  try {
    return executeManifest(manifest, opts, process.cwd());
  } finally {
    lock.release();
  }
}

function checkCli(argv) {
  const o = { userSaid: false };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--check-before-create') continue;
      else if (a === '--user-said-send') o.userSaid = true;
      else if (a === '--staging') o.staging = take(argv, i++);
      else if (a === '--project') o.project = take(argv, i++);
      else if (a === '--intent') o.intent = take(argv, i++);
      else if (a === '--out') o.out = take(argv, i++);
      else if (a === '--duration') o.duration = take(argv, i++);
      else if (a === '--account') o.account = take(argv, i++);
      else throw new Error(`未知参数 ${a}`);
    }
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (!o.staging || !o.project || !o.intent) {
    console.error('check-before-create 需要 --staging --project --intent');
    return 2;
  }
  const upload = readJson(path.join(o.staging, 'upload-body-result.json')) || {};
  const local = readJson(path.join(o.staging, 'create-once-result.json'));
  const balance = asNumber(upload.balanceBefore != null ? upload.balanceBefore : upload.balance_before);
  const price = asNumber(upload.price);
  const duration = asNumber(upload.duration != null ? upload.duration : o.duration);
  const decision = decideBeforeCreate({
    balance,
    price,
    duration,
    userSaidSend: o.userSaid,
    existingTaskId: local && local.balance_alert ? '' : taskIdOf(local) || ledgerTask(o.project, o.intent),
    alertPresent: fs.existsSync(ALERT),
    balanceAlert: !!(local && local.balance_alert),
  });
  if (o.account && decision.code === 4) {
    decision.message += ` 账号 ${o.account}。`;
  }
  if (o.out) fs.writeFileSync(o.out, JSON.stringify(decision, null, 2));
  console.log(JSON.stringify(decision));
  if (decision.code === 4 || decision.code === 3 || decision.code === 6) console.error(decision.message);
  return decision.code;
}

function help() {
  console.log(`lovart-wan-batch.sh — 画布 Wan 批量（默认 dry-run，不 create）
  --manifest PATH
  --work-root DIR          相对 staging 放这里（默认 /tmp/lovart-wan-batch）
  --out DIR                出片进度与转发句（默认 <work-root>/report）
  --dry-run                默认
  --no-dry-run --allow-create-once
                           两个一起才会计费；只给一个会 exit 6
  --user-said-send 账号ID  可重复。表示用户已对该号说「发送」
  --wasm PATH

lovart-wan-item.sh 同脚本 --once，单条参数：
  --prompt --staging --project --profile --account --expect-email
  --duration --intent --output-mp4
  --mac-product-dir --mac-project-dir
  [--fixture-balance N --fixture-price N] [--user-said-send]
  [--env --front --oblique --side --audio]
  [--consecutive N]   大于 2 则 exit 6

退出码：0 完成（Mac 默认未核）；2 用法；3 无号或门闩；4 需用户（特殊号／Insufficient／Mac 卷不可达）；6 政策停。
`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    help();
    return 0;
  }
  if (argv.includes('--check-before-create')) return checkCli(argv);
  if (argv.includes('--once')) return onceCli(argv);
  return batchCli(argv);
}

module.exports = {
  MAX_STREAK,
  INSUFF_RE,
  evaluateGate,
  specialAccountHold,
  selectQuote,
  streakDecision,
  decideBeforeCreate,
  normAccount,
  acquireBatchLock,
  fillTemplate,
  taskIdOf,
  mapExit,
};

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
