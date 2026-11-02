#!/usr/bin/env node
/**
 * 轮询 generator task → 下载 mp4 → 写结果 JSON（含 md5）。
 *
 * Usage:
 *   LOVART_TOKEN=... node lovart-wan-poll-download.cjs \
 *     --task UUID --out /path/母片.mp4 \
 *     [--token-file PATH] [--result PATH] [--final-json PATH] \
 *     [--max-polls 90] [--interval-ms 8000] [--wasm PATH]
 * Exit: 0 ok; 2 usage; 5 task failed; 6 no artifact
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { randomUUID } = require('crypto');
const { execSync } = require('child_process');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
function has(f) { return process.argv.includes(f); }
function help() {
  console.log(`lovart-wan-poll-download.cjs — poll Wan task and download mp4
  --task UUID          required generator_task_id
  --out PATH.mp4       required
  --token-file PATH | env LOVART_TOKEN
  --result PATH        default <out>.download.json
  --final-json PATH    raw last task payload
  --wasm PATH          default /tmp/lovart-wasm/sign.wasm
  --max-polls N        default 90
  --interval-ms N      default 8000
  --dry-run            only validate args / write stub (no network)`);
}
if (has('--help') || has('-h')) { help(); process.exit(0); }

const TASK = arg('--task');
const OUT_MP4 = arg('--out');
if (!TASK || !OUT_MP4) { help(); process.exit(2); }

const RESULT = arg('--result', OUT_MP4.replace(/\.mp4$/i, '') + '.download.json');
const FINAL = arg('--final-json', path.join(path.dirname(OUT_MP4), path.basename(OUT_MP4, path.extname(OUT_MP4)) + '-task-final.json'));
const WASM = arg('--wasm', '/tmp/lovart-wasm/sign.wasm');
const MAX = Number(arg('--max-polls', 90));
const INTERVAL = Number(arg('--interval-ms', 8000));

function readToken() {
  if (process.env.LOVART_TOKEN) return process.env.LOVART_TOKEN.trim();
  const tf = arg('--token-file', arg('--token'));
  if (tf && fs.existsSync(tf)) return fs.readFileSync(tf, 'utf8').trim();
  return '';
}

async function loadSign() {
  const buf = fs.readFileSync(WASM);
  const { instance } = await WebAssembly.instantiate(buf, {});
  const r = instance.exports;
  let o = null, l = null, p = 0, c = 0;
  const u = new TextEncoder();
  let d = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  d.decode();
  function n() {
    if (null === o || o.buffer !== r.memory.buffer) o = new DataView(r.memory.buffer);
    return o;
  }
  function i() {
    if (null === l || 0 === l.byteLength) l = new Uint8Array(r.memory.buffer);
    return l;
  }
  function s(e, t, a) {
    if (void 0 === a) {
      let a2 = u.encode(e), rr = t(a2.length, 1) >>> 0;
      i().subarray(rr, rr + a2.length).set(a2);
      p = a2.length;
      return rr;
    }
    let rr = e.length, oo = t(rr, 1) >>> 0, nn = i(), ll = 0;
    for (; ll < rr; ll++) {
      let t2 = e.charCodeAt(ll);
      if (t2 > 127) break;
      nn[oo + ll] = t2;
    }
    if (ll !== rr) {
      0 !== ll && (e = e.slice(ll));
      oo = a(oo, rr, (rr = ll + 3 * e.length), 1) >>> 0;
      let t2 = i().subarray(oo + ll, oo + rr);
      ll += u.encodeInto(e, t2).written;
      oo = a(oo, rr, ll, 1) >>> 0;
    }
    return (p = ll), oo;
  }
  function m(e, t, a, oo) {
    let l2, u2;
    try {
      let b = r.__wbindgen_add_to_stack_pointer(-16);
      let x = s(e, r.__wbindgen_export2, r.__wbindgen_export3), y = p;
      let w = s(t, r.__wbindgen_export2, r.__wbindgen_export3), k = p;
      let C = s(a, r.__wbindgen_export2, r.__wbindgen_export3), S = p;
      let j = s(oo, r.__wbindgen_export2, r.__wbindgen_export3), _ = p;
      r.gs(b, x, y, w, k, C, S, j, _);
      let f = n().getInt32(b + 0, true), v = n().getInt32(b + 4, true);
      l2 = f; u2 = v;
      let mptr = f >>> 0, glen = v;
      if ((c += glen) >= 0x7ff00000) {
        d = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        d.decode();
        c = glen;
      }
      return d.decode(i().subarray(mptr, mptr + glen));
    } finally {
      r.__wbindgen_add_to_stack_pointer(16);
      r.__wbindgen_export(l2, u2, 1);
    }
  }
  return (ts, uuidHex) => m(String(ts), String(uuidHex), '', '');
}

function httpJson(method, url, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = bodyObj == null ? null : Buffer.from(JSON.stringify(bodyObj));
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: { ...headers, ...(data ? { 'Content-Length': data.length } : {}) },
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const lib = url.startsWith('https') ? https : http;
    lib
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          return download(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', reject);
  });
}

(async () => {
  if (has('--dry-run')) {
    const stub = { ok: true, dry_run: true, generator_task_id: TASK, out: OUT_MP4, note: 'no poll' };
    fs.writeFileSync(RESULT, JSON.stringify(stub, null, 2));
    console.log(JSON.stringify(stub));
    return;
  }
  const TOKEN = readToken();
  if (!TOKEN) {
    console.error('missing token');
    process.exit(2);
  }
  if (!fs.existsSync(WASM)) {
    console.error('wasm missing', WASM);
    process.exit(2);
  }
  const sign = await loadSign();
  function hdrs() {
    const ts = String(Date.now()),
      uuid = randomUUID().replace(/-/g, '');
    return {
      token: TOKEN,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'accept-language': 'zh-CN',
      Referer: 'https://www.lovart.ai/',
      Origin: 'https://www.lovart.ai',
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
      'X-Send-Timestamp': ts,
      'X-Req-Uuid': uuid,
      'X-Client-Signature': sign(ts, uuid),
    };
  }

  let detail = null;
  for (let i = 0; i < MAX; i++) {
    const r = await httpJson(
      'GET',
      `https://lgw.lovart.ai/v1/generator/tasks?task_id=${TASK}`,
      hdrs(),
      null
    );
    let j;
    try {
      j = JSON.parse(r.body);
    } catch {
      console.error('parse', r.status, r.body.slice(0, 200));
      await new Promise((x) => setTimeout(x, INTERVAL));
      continue;
    }
    detail = j.data || j;
    const st = detail.status || detail.task_status;
    console.error('poll', i, st, detail.progress || detail.percent || '');
    if (['completed', 'success', 'SUCCESS', 'COMPLETED', 'done'].includes(st) || st === 2) break;
    if (['failed', 'FAILED', 'error', 'cancelled', 'CANCELED', 'canceled'].includes(String(st))) {
      fs.writeFileSync(FINAL, JSON.stringify({ error: 'task_failed', detail }, null, 2));
      process.exit(5);
    }
    await new Promise((x) => setTimeout(x, INTERVAL));
  }
  fs.mkdirSync(path.dirname(FINAL), { recursive: true });
  fs.writeFileSync(FINAL, JSON.stringify({ code: 0, message: 'success', data: detail }, null, 2));

  const blob = JSON.stringify(detail);
  let artifactUrl = null;
  if (Array.isArray(detail.artifacts)) {
    const v = detail.artifacts.find((a) => a.type === 'video' || String(a.content || '').endsWith('.mp4'));
    if (v) artifactUrl = v.content || v.url;
  }
  const m = blob.match(/https:\/\/[^"\\]+\.mp4[^"\\]*/);
  if (!artifactUrl && m) artifactUrl = m[0].replace(/\\u0026/g, '&');
  console.error('artifact', artifactUrl);
  if (!artifactUrl) {
    console.error('NO_ARTIFACT');
    process.exit(6);
  }

  fs.mkdirSync(path.dirname(OUT_MP4), { recursive: true });
  await download(artifactUrl, OUT_MP4);
  const md5 = execSync(`md5sum ${JSON.stringify(OUT_MP4)}`).toString().trim().split(/\s+/)[0];
  const sz = fs.statSync(OUT_MP4).size;

  let balanceAfter = null;
  try {
    const priceBody = {
      generator_name: 'wan/wan-3-0',
      input_args: {
        prompt: 't',
        ratio: '9:16',
        duration: 12,
        resolution: '480P',
        total_duration: 12,
        has_ref_video: '0',
      },
    };
    const pr = await httpJson('POST', 'https://lgw.lovart.ai/v1/generator/pricing', hdrs(), priceBody);
    balanceAfter = JSON.parse(pr.body)?.data?.balance;
  } catch (_) {}

  const out = {
    ok: true,
    generator_task_id: TASK,
    artifact_url: artifactUrl,
    box_path: OUT_MP4,
    md5,
    size: sz,
    balance_after: balanceAfter,
    status: detail.status,
  };
  fs.writeFileSync(RESULT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
