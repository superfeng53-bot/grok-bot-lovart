#!/usr/bin/env node
/**
 * 用 Lovart sign.wasm 生成 X-Send-Timestamp / X-Req-Uuid / X-Client-Signature。
 * 优先 --wasm /tmp/lovart-wasm/sign.wasm
 *
 * Usage:
 *   node lovart-wan-sign-headers.cjs [--wasm PATH] [--out PATH] [--print-env]
 * Exit 0 ok; 1 wasm fail; 2 usage
 */
'use strict';
const fs = require('fs');
const { randomUUID } = require('crypto');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
function has(f) { return process.argv.includes(f); }
function help() {
  console.log(`lovart-wan-sign-headers.cjs — wasm-sign Lovart client headers
  --wasm PATH   default /tmp/lovart-wasm/sign.wasm
  --out PATH    write JSON {X-Send-Timestamp,X-Req-Uuid,X-Client-Signature}
  --print-env   also print export LOVART_SIG_HEADERS_JSON=...
  --self-test   sign twice and check non-empty`);
}
if (has('--help') || has('-h')) { help(); process.exit(0); }

const WASM = arg('--wasm', '/tmp/lovart-wasm/sign.wasm');
const OUT = arg('--out');

async function loadSign(buf) {
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
      let a2 = u.encode(e),
        rr = t(a2.length, 1) >>> 0;
      i().subarray(rr, rr + a2.length).set(a2);
      p = a2.length;
      return rr;
    }
    let rr = e.length,
      oo = t(rr, 1) >>> 0,
      nn = i(),
      ll = 0;
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
      let x = s(e, r.__wbindgen_export2, r.__wbindgen_export3),
        y = p;
      let w = s(t, r.__wbindgen_export2, r.__wbindgen_export3),
        k = p;
      let C = s(a, r.__wbindgen_export2, r.__wbindgen_export3),
        S = p;
      let j = s(oo, r.__wbindgen_export2, r.__wbindgen_export3),
        _ = p;
      r.gs(b, x, y, w, k, C, S, j, _);
      let f = n().getInt32(b + 0, true),
        v = n().getInt32(b + 4, true);
      l2 = f;
      u2 = v;
      let mptr = f >>> 0,
        glen = v;
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

(async () => {
  if (!fs.existsSync(WASM)) {
    console.error('wasm missing', WASM);
    process.exit(1);
  }
  const sign = await loadSign(fs.readFileSync(WASM));
  const ts = String(Date.now());
  const uuid = randomUUID().replace(/-/g, '');
  const sig = sign(ts, uuid);
  if (!sig || sig.length < 8) {
    console.error('empty signature');
    process.exit(1);
  }
  if (has('--self-test')) {
    const ts2 = String(Date.now() + 1);
    const uuid2 = randomUUID().replace(/-/g, '');
    const sig2 = sign(ts2, uuid2);
    if (!sig2 || sig2 === sig) {
      console.error('self-test fail');
      process.exit(1);
    }
    console.error('self-test ok', { len: sig.length, len2: sig2.length });
  }
  const headersOut = {
    'X-Send-Timestamp': ts,
    'X-Req-Uuid': uuid,
    'X-Client-Signature': sig,
  };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(headersOut, null, 2));
  console.log(JSON.stringify(headersOut));
  if (has('--print-env')) {
    console.log('export LOVART_SIG_HEADERS_JSON=' + JSON.stringify(JSON.stringify(headersOut)));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
