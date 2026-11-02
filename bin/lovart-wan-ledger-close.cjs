#!/usr/bin/env node
const fs = require('fs');
const LEDGER = '/workspace/lovart-bot/state/wan-create-ledger.json';
const id = process.argv[2];
if (!id) { console.error('usage: lovart-wan-ledger-close.cjs <generator_task_id>'); process.exit(2); }
let L; try { L = JSON.parse(fs.readFileSync(LEDGER,'utf8')); } catch { L = { version:1, entries:[] }; }
let n=0;
for (const e of L.entries||[]) {
  if (e.generator_task_id === id) { e.closed = true; e.closed_at = new Date().toISOString(); n++; }
}
fs.mkdirSync(require('path').dirname(LEDGER), { recursive: true });
fs.writeFileSync(LEDGER, JSON.stringify(L, null, 2));
console.log(JSON.stringify({ closed: n, id }));
