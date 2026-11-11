#!/usr/bin/env node
/**
 * 按字段填 CANVAS-GATE.md / RESULT.md，并可追加 00-项目卡 变更行。
 *
 * Usage:
 *   node lovart-wan-write-gate-result.cjs --staging DIR --set key=val [--set ...]
 *   node lovart-wan-write-gate-result.cjs --staging DIR --from-json PATH
 *   optional: --project-card PATH --card-line "变更行全文"
 * Exit 0 ok; 2 usage
 */
'use strict';
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
function has(f) { return process.argv.includes(f); }
function help() {
  console.log(`lovart-wan-write-gate-result.cjs — fill CANVAS-GATE.md + RESULT.md
  --staging DIR
  --from-json PATH     merge keys from JSON
  --set key=value      repeatable (balance_before, price, generator_task_id, ...)
  --project-card PATH  optional 00-项目卡.md
  --card-line TEXT     append under 变更 (creates ## 变更 if missing)
  --title TEXT         RESULT/GATE title slug`);
}
if (has('--help') || has('-h')) { help(); process.exit(0); }

const STAGING = arg('--staging');
if (!STAGING) { help(); process.exit(2); }
fs.mkdirSync(STAGING, { recursive: true });

const fields = {};
const fromJson = arg('--from-json');
if (fromJson) {
  Object.assign(fields, JSON.parse(fs.readFileSync(fromJson, 'utf8')));
}
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--set' && process.argv[i + 1]) {
    const raw = process.argv[i + 1];
    const eq = raw.indexOf('=');
    if (eq > 0) fields[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
}

const title = arg('--title', fields.title || fields.intent || path.basename(STAGING));
const now = new Date();
const isoLocal = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(now).replace(' ', 'T') + '+08:00';

function g(k, d = '') {
  return fields[k] != null ? String(fields[k]) : d;
}

const gatePath = path.join(STAGING, 'CANVAS-GATE.md');
const gate = `# CANVAS-GATE ${title}（纯请求优先）
- skill_loaded_at: ${g('skill_loaded_at', isoLocal)}
- path: ${g('path', 'pure-request')}
- profile: ${g('profile')}
- expect_email: ${g('expect_email', g('email'))}
- account: ${g('account')}
- staging_ready: ${g('staging_ready', 'yes')}
- intent: ${g('intent')}
- project_id: ${g('project_id')}
- duration: ${g('duration')}
- mp4_duration: ${g('mp4_duration')}
- balance_before: ${g('balance_before', g('balanceBefore'))}
- price: ${g('price')}
- balance_after: ${g('balance_after', g('balanceAfter'))}
- generator_task_id: ${g('generator_task_id')}
- download_path: ${g('download_path', g('box_path'))}
- box_md5: ${g('box_md5', g('md5'))}
- size: ${g('size')}
- artifact_url: ${g('artifact_url')}
- mac_path: ${g('mac_path', [g('mac_path_成品'), g('mac_path_项目')].filter(Boolean).join(' + '))}
- mac_md5: ${g('mac_md5')}
- mac_copy_status: ${g('mac_copy_status')}
- true_chips: ${g('true_chips', 'oud [@image:]×4 + [@audio:]×1')}
- used_canvas: ${g('used_canvas', g('account'))}
- note: ${g('note', '日配额已取消；只看积分核验（bal≥秒×4+2 且 price<bal）')}
`;
fs.writeFileSync(gatePath, gate);

const resultPath = path.join(STAGING, 'RESULT.md');
const result = `# RESULT ${title}

- ok: ${g('ok', 'true')}
- account: ${g('account')} / ${g('expect_email', g('email'))} / Chrome Profile ${g('profile')}
- path: ${g('path', 'pure-request')}
- intent: ${g('intent')}
- project_id: ${g('project_id')}
- generator_task_id: ${g('generator_task_id')}
- balance_before: ${g('balance_before', g('balanceBefore'))}
- price: ${g('price')}
- balance_after: ${g('balance_after', g('balanceAfter'))}
- true_chips: ${g('true_chips', 'oud [@image:]×4 + [@audio:]×1；image_list×4；audio_list×1')}
- artifact_url: ${g('artifact_url')}
- box_path: ${g('download_path', g('box_path'))}
- box_md5: ${g('box_md5', g('md5'))}
- size: ${g('size')}
- mp4_duration: ${g('mp4_duration')}
- mac_成品: ${g('mac_path_成品', g('mac_成品'))}
- mac_项目: ${g('mac_path_项目', g('mac_项目'))}
- mac_md5: ${g('mac_md5')}
- mac_copy_status: ${g('mac_copy_status')}
- mac_md5_ok: ${g('mac_md5_ok')}
- used_canvas: ${g('used_canvas', g('account'))}
- billable_creates: ${g('billable_creates', fields.dry_run ? '0' : '')}
- stopped_short: ${g('stopped_short', '')}
- at: ${g('at', isoLocal.replace('T', ' ').replace('+08:00', ' Asia/Shanghai'))}
`;
fs.writeFileSync(resultPath, result);

const card = arg('--project-card');
const cardLine = arg('--card-line');
if (card && cardLine) {
  let txt = fs.existsSync(card) ? fs.readFileSync(card, 'utf8') : '';
  if (!/##\s*变更/.test(txt)) txt += (txt.endsWith('\n') ? '' : '\n') + '\n## 变更\n';
  if (!txt.endsWith('\n')) txt += '\n';
  txt += `- ${cardLine}\n`;
  fs.writeFileSync(card, txt);
}

console.log(JSON.stringify({ ok: true, gate: gatePath, result: resultPath, project_card: card || null }, null, 2));
