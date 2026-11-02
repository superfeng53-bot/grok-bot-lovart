#!/usr/bin/env node
/**
 * Billable Wan create — EXACTLY ONE POST per process, and at most one
 * successful create per (project_id, intent) / body fingerprint / cid in 2h.
 *
 * Hard guards (2026-10-31 double-charge postmortem L24 100→3):
 * 1. Parse success id from data.generator_task_id (NOT task_id alone).
 * 2. Never retry / never "schema fallback" second POST after any create attempt.
 * 3. Process-global postedOnce: a second call to POST /tasks in this process aborts.
 * 4. flock per project + ledger (intent / cid / body fingerprint).
 * 5. Optional --balance-before / --max-price: after create, if balance dropped
 *    more than max-price+2 → ALERT file; still never create again.
 *
 * Usage:
 *   LOVART_TOKEN=... LOVART_SIG_HEADERS_JSON='{...}' \
 *   node lovart-wan-create-once.cjs \
 *     --project <projectId> --intent yz20-03 \
 *     --body /path/create-body.json --out /path/result.json \
 *     [--balance-before 100] [--max-price 48]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const { parseWanTaskId, createSucceeded } = require('./lovart-wan-parse-task-id.cjs');

const LEDGER = '/workspace/lovart-bot/state/wan-create-ledger.json';
const ALERT = '/tmp/lovart-wan-double-charge-ALERT.json';
const CREATE_URL = 'https://lgw.lovart.ai/v1/generator/tasks';

/** Process-global: forbids a second billable create POST in this Node process. */
let postedOnce = false;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function bodyFingerprint(createBody) {
  const ia = createBody.input_args || {};
  const refs = [];
  for (const k of Object.keys(ia).sort()) {
    if (/reference|image|audio|media/i.test(k)) {
      try { refs.push([k, JSON.stringify(ia[k]).slice(0, 800)]); } catch { refs.push([k, String(ia[k]).slice(0, 200)]); }
    }
  }
  const core = {
    project_id: createBody.project_id,
    generator_name: createBody.generator_name,
    duration: ia.duration,
    resolution: ia.resolution,
    ratio: ia.ratio,
    prompt: String(ia.prompt || '').slice(0, 400),
    refs,
  };
  return crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 24);
}

function httpJson(method, url, headers, bodyObj) {
  if (url.includes('/v1/generator/tasks') && method === 'POST') {
    if (postedOnce) {
      const err = new Error('REFUSED_SECOND_CREATE_POST: process already POSTed /v1/generator/tasks once');
      err.code = 'SECOND_POST';
      throw err;
    }
    postedOnce = true;
  }
  const u = new URL(url);
  const body = bodyObj == null ? null : JSON.stringify(bodyObj);
  const opts = {
    method, hostname: u.hostname, path: u.pathname + u.search,
    headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return { version: 1, entries: [] }; }
}
function saveLedger(L) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const tmp = LEDGER + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(L, null, 2));
  fs.renameSync(tmp, LEDGER);
}

function recentOk(entries, now) {
  return (entries || []).filter((e) => e.ok && now - new Date(e.at).getTime() < 2 * 3600 * 1000);
}

async function main() {
  const projectId = arg('--project');
  const intent = arg('--intent', 'default');
  const bodyPath = arg('--body');
  const outPath = arg('--out', '/tmp/lovart-wan-create-once-result.json');
  const balanceBefore = arg('--balance-before') != null ? Number(arg('--balance-before')) : null;
  const maxPrice = arg('--max-price') != null ? Number(arg('--max-price')) : null;
  const dryRun = process.argv.includes('--dry-run');

  if (!projectId || !bodyPath) {
    console.error('need --project and --body');
    process.exit(2);
  }
  const token = process.env.LOVART_TOKEN || '';
  if (!dryRun && !token) { console.error('missing LOVART_TOKEN'); process.exit(2); }
  let sig = {};
  if (process.env.LOVART_SIG_HEADERS_JSON) sig = JSON.parse(process.env.LOVART_SIG_HEADERS_JSON);
  if (!dryRun) {
    for (const k of ['X-Send-Timestamp', 'X-Req-Uuid', 'X-Client-Signature']) {
      if (!sig[k]) { console.error('missing sig header', k); process.exit(2); }
    }
  }

  const createBody = JSON.parse(fs.readFileSync(bodyPath, 'utf8'));
  if (!createBody.cid) createBody.cid = randomUUID();
  createBody.project_id = createBody.project_id || projectId;
  createBody.generator_name = createBody.generator_name || 'wan/wan-3-0';
  const fp = bodyFingerprint(createBody);
  const cid = createBody.cid;

  const L = loadLedger();
  const now = Date.now();
  const recent = recentOk(L.entries, now);

  // Gate A: same project + intent
  const dupIntent = recent.find((e) => e.project_id === projectId && e.intent === intent);
  if (dupIntent) {
    const result = { error: 'ledger_duplicate_intent', message: 'same project+intent already created within 2h', prior: dupIntent };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.error('LEDGER_DUP_INTENT', dupIntent.generator_task_id);
    process.exit(6);
  }
  // Gate B: same cid reused
  const dupCid = recent.find((e) => e.cid && e.cid === cid);
  if (dupCid) {
    const result = { error: 'ledger_duplicate_cid', prior: dupCid };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.error('LEDGER_DUP_CID', dupCid.generator_task_id);
    process.exit(8);
  }
  // Gate C: same body fingerprint (prompt+refs+spec) — blocks CREATE2 with "media-only" that still bills same clip
  const dupFp = recent.find((e) => e.fingerprint === fp);
  if (dupFp) {
    const result = { error: 'ledger_duplicate_fingerprint', message: 'same create body fingerprint within 2h — refusing second billable POST', prior: dupFp };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.error('LEDGER_DUP_FP', dupFp.generator_task_id, fp);
    process.exit(9);
  }
  // Gate D: open (unclosed) task on same project
  const openSameProject = recent.find((e) => e.project_id === projectId && !e.closed);
  if (openSameProject) {
    const result = { error: 'project_busy', prior: openSameProject };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.error('PROJECT_BUSY', openSameProject.generator_task_id);
    process.exit(7);
  }
  // Gate E: existing ALERT file from prior double-charge — hard stop until human clears
  if (fs.existsSync(ALERT)) {
    const result = { error: 'double_charge_alert_uncleared', alert: ALERT };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.error('ALERT_UNCLEARED', ALERT);
    process.exit(10);
  }

  if (dryRun) {
    const result = { ok: true, dry_run: true, project_id: projectId, intent, cid, fingerprint: fp, note: 'gates passed; no POST' };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    return;
  }

  const lockPath = `/tmp/lovart-wan-create-${projectId}.lock`;
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, intent, projectId, fingerprint: fp }));
  } catch (e) {
    const result = { error: 'lock_held', lockPath, detail: String(e.message || e) };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.error('LOCK_HELD');
    process.exit(5);
  }

  const headers = {
    token,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'accept-language': 'zh-CN',
    Referer: 'https://www.lovart.ai/',
    Origin: 'https://www.lovart.ai',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    ...sig,
  };

  try {
    // ===== ONE POST. No CREATE2. No schema-fallback retry. =====
    let r;
    try {
      r = await httpJson('POST', CREATE_URL, headers, createBody);
    } catch (e) {
      if (e && e.code === 'SECOND_POST') {
        fs.writeFileSync(outPath, JSON.stringify({ ok: false, error: 'SECOND_POST', note: 'refused in-process second create' }, null, 2));
        console.error('SECOND_POST_REFUSED');
        process.exit(11);
      }
      throw e;
    }

    const taskId = parseWanTaskId(r.body);
    const ok = createSucceeded(r.status, r.body);
    let parsedBody;
    try { parsedBody = JSON.parse(r.body); } catch { parsedBody = r.body; }

    const entry = {
      at: new Date().toISOString(),
      project_id: projectId,
      intent,
      cid,
      fingerprint: fp,
      ok: !!(ok && taskId),
      generator_task_id: taskId,
      http_status: r.status,
      balance_before: balanceBefore,
      max_price: maxPrice,
      closed: false,
    };

    // Even if createSucceeded false: if generator_task_id present → treat as billed success, NEVER retry.
    const recovered = !taskId ? parseWanTaskId(parsedBody) : null;
    const finalId = taskId || recovered;

    if (finalId && (ok || r.status === 200 || r.status === 201)) {
      entry.ok = true;
      entry.generator_task_id = finalId;
      if (recovered && !ok) entry.note = 'recovered generator_task_id; refused second POST';
      L.entries = (L.entries || []).concat([entry]);
      saveLedger(L);

      let balanceAlert = null;
      if (balanceBefore != null && maxPrice != null) {
        try {
          const priceBody = {
            generator_name: 'wan/wan-3-0',
            input_args: {
              duration: (createBody.input_args && createBody.input_args.duration) || 12,
              resolution: (createBody.input_args && createBody.input_args.resolution) || '480P',
              ratio: (createBody.input_args && createBody.input_args.ratio) || '9:16',
              prompt: '.',
            },
          };
          const pr = await httpJson('POST', 'https://lgw.lovart.ai/v1/generator/pricing', headers, priceBody);
          const bal = JSON.parse(pr.body)?.data?.balance;
          if (typeof bal === 'number') {
            const dropped = balanceBefore - bal;
            if (dropped > maxPrice + 2) {
              balanceAlert = {
                balance_before: balanceBefore,
                balance_after: bal,
                dropped,
                max_price: maxPrice,
                message: 'balance dropped more than one task — possible double charge; DO NOT create again',
              };
              fs.writeFileSync(ALERT, JSON.stringify({
                ...balanceAlert, project_id: projectId, generator_task_id: finalId, at: new Date().toISOString(),
              }, null, 2));
            }
          }
        } catch (_) {}
      }

      const result = {
        ok: true,
        generator_task_id: finalId,
        project_id: projectId,
        intent,
        cid,
        fingerprint: fp,
        status: r.status,
        body: parsedBody,
        balance_alert: balanceAlert,
        note: 'single POST; ledger recorded; never retry create in this process',
      };
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ generator_task_id: finalId, project_id: projectId, balance_alert: !!balanceAlert }));
      if (balanceAlert) process.exit(12);
      return;
    }

    // True failure (no id): still write ledger attempt, exit, DO NOT retry.
    entry.ok = false;
    entry.note = 'create failed; NOT retrying';
    L.entries = (L.entries || []).concat([entry]);
    saveLedger(L);
    fs.writeFileSync(outPath, JSON.stringify({ ok: false, status: r.status, body: parsedBody, note: entry.note, fingerprint: fp }, null, 2));
    console.error('CREATE_FAILED_NO_RETRY', r.status, String(r.body).slice(0, 400));
    process.exit(4);
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
