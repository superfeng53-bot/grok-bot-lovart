#!/usr/bin/env node
/**
 * 从已打开的画布 Chrome（CDP）提取 Lovart usertoken（及可选邮箱）。
 * 要求：已用 lovart-canvas-chrome.sh N 拉起 Fork-2，CDP 默认可达。
 *
 * Usage:
 *   node lovart-wan-extract-token.cjs --profile N [--cdp URL] [--out PATH] [--email-out PATH]
 *   node lovart-wan-extract-token.cjs --from-file PATH  # just validate/copy existing token
 * Exit: 0 ok; 2 usage; 4 need user (no chrome/login); 5 CDP fail suggest retry
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
  console.log(`lovart-wan-extract-token.cjs — pull Lovart usertoken from CDP Chrome
  --profile N          Chrome Profile number (informational + default out name)
  --cdp URL            default http://127.0.0.1:9224
  --out PATH           default /tmp/l{profile}-usertoken.txt or /tmp/lovart-usertoken.txt
  --email-out PATH     optional write detected email
  --from-file PATH     copy/validate existing token file (no CDP)
  --timeout MS         default 90000`);
}
if (has('--help') || has('-h')) { help(); process.exit(0); }

const FROM = arg('--from-file');
if (FROM) {
  if (!fs.existsSync(FROM)) {
    console.error('missing', FROM);
    process.exit(2);
  }
  const t = fs.readFileSync(FROM, 'utf8').trim();
  if (t.length < 20) {
    console.error('token too short');
    process.exit(4);
  }
  const out = arg('--out', FROM);
  if (out !== FROM) fs.writeFileSync(out, t + '\n');
  console.log(JSON.stringify({ ok: true, from_file: FROM, out, token_len: t.length }));
  process.exit(0);
}

const PROFILE = arg('--profile');
const CDP = arg('--cdp', 'http://127.0.0.1:9224');
const OUT = arg(
  '--out',
  PROFILE ? `/tmp/l${PROFILE}-usertoken.txt` : '/tmp/lovart-usertoken.txt'
);
const EMAIL_OUT = arg('--email-out');
const TIMEOUT = Number(arg('--timeout', 90000));

async function main() {
  let puppeteer;
  const candidates = [
    '/home/box/tools/hypit/node_modules/.pnpm/puppeteer-core@25.10.0/node_modules/puppeteer-core',
    'puppeteer-core',
  ];
  for (const c of candidates) {
    try {
      puppeteer = require(c);
      break;
    } catch (_) {}
  }
  if (!puppeteer) {
    console.error('puppeteer-core not found');
    process.exit(5);
  }

  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
  } catch (e) {
    console.error('CDP_CONNECT_FAIL', String(e.message || e));
    console.error('hint: /home/box/bin/lovart-canvas-chrome.sh', PROFILE || 'N');
    process.exit(4);
  }

  try {
    const pages = await browser.pages();
    let page = pages.find((p) => (p.url() || '').includes('lovart.ai')) || pages[0];
    if (!page) {
      console.error('no pages');
      process.exit(4);
    }
    const client = await page.createCDPSession();
    await client.send('Network.enable');
    const signed = [];
    const take = (h) => {
      let foundSig, foundTs, foundUuid, foundToken;
      for (const [k, v] of Object.entries(h || {})) {
        const lk = String(k).toLowerCase();
        if (lk === 'x-client-signature') foundSig = v;
        if (lk === 'x-send-timestamp') foundTs = v;
        if (lk === 'x-req-uuid') foundUuid = v;
        if (lk === 'token') foundToken = v;
      }
      if (foundToken || foundSig) {
        signed.push({
          token: foundToken,
          'X-Client-Signature': foundSig,
          'X-Send-Timestamp': foundTs,
          'X-Req-Uuid': foundUuid,
        });
      }
    };
    client.on('Network.requestWillBeSentExtraInfo', (params) => take(params.headers || {}));
    client.on('Network.requestWillBeSent', (params) => {
      if ((params.request.url || '').includes('lgw.lovart.ai')) take(params.request.headers || {});
    });

    if (!(page.url() || '').includes('lovart.ai')) {
      await page.goto('https://www.lovart.ai/zh/home', { waitUntil: 'networkidle2', timeout: TIMEOUT });
    } else {
      // soft reload to stir network
      try {
        await page.reload({ waitUntil: 'networkidle2', timeout: TIMEOUT });
      } catch (_) {}
    }
    await new Promise((r) => setTimeout(r, 2000));

    let email = await page.evaluate(() => {
      try {
        for (const k of Object.keys(localStorage)) {
          const v = localStorage.getItem(k) || '';
          const m = v.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (m) return m[0];
        }
      } catch (_) {}
      return null;
    });

    let token = null;
    for (let i = signed.length - 1; i >= 0; i--) {
      if (signed[i].token) {
        token = String(signed[i].token).trim();
        break;
      }
    }
    if (!token) {
      const cookies = await page.cookies();
      const hit = cookies.find((c) => /usertoken|token/i.test(c.name));
      if (hit) token = decodeURIComponent(hit.value).trim();
    }
    if (!token) {
      const cookieStr = await page.evaluate(() => document.cookie || '');
      const m = cookieStr.match(/(?:^|;\s*)(?:token|usertoken)=([^;]+)/i);
      if (m) token = decodeURIComponent(m[1]).trim();
    }

    if (!token || token.length < 20) {
      console.error('NO_TOKEN — login required?');
      process.exit(4);
    }
    fs.writeFileSync(OUT, token + '\n');
    if (EMAIL_OUT && email) fs.writeFileSync(EMAIL_OUT, email + '\n');
    const lastSig = [...signed].reverse().find((s) => s['X-Client-Signature']);
    const sigPath = arg('--sig-out');
    if (sigPath && lastSig) {
      fs.writeFileSync(
        sigPath,
        JSON.stringify(
          {
            'X-Client-Signature': lastSig['X-Client-Signature'],
            'X-Send-Timestamp': String(lastSig['X-Send-Timestamp'] || ''),
            'X-Req-Uuid': lastSig['X-Req-Uuid'] || '',
          },
          null,
          2
        )
      );
    }
    console.log(
      JSON.stringify({
        ok: true,
        profile: PROFILE ? Number(PROFILE) : null,
        cdp: CDP,
        out: OUT,
        token_len: token.length,
        email,
        n_signed: signed.length,
      })
    );
  } finally {
    try {
      await browser.disconnect();
    } catch (_) {}
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(5);
});
