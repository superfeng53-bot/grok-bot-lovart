#!/usr/bin/env node
/**
 * 参数化：presign+PUT 上传 staging 素材，询价门闩，组装真芯片 create-body.json。
 * 禁止本脚本 POST /v1/generator/tasks（计费 create 只走 lovart-wan-create-once.cjs）。
 *
 * Usage:
 *   LOVART_TOKEN=... node lovart-wan-upload-and-body.cjs \
 *     --staging DIR --project ID [--duration 12] [--token-file PATH] \
 *     [--out-body PATH] [--out-urls PATH] [--result PATH] \
 *     [--dry-run] [--reuse-urls] [--skip-pricing] [--skip-upload]
 * Exit: 0 ok; 2 usage; 3 gate; 1 other
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { randomUUID } = crypto;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
function has(flag) { return process.argv.includes(flag); }

function help() {
  console.log(`lovart-wan-upload-and-body.cjs — upload staging + build true-chip create body (NO create)
  --staging DIR          required
  --project ID           required (Lovart project_id)
  --duration N           default: from prompt-with-prefix or 12
  --token / --token-file PATH | env LOVART_TOKEN
  --out-body PATH        default: <staging>/create-body.json
  --out-urls PATH        default: <staging>/uploaded-urls.json
  --result PATH          default: <staging>/upload-body-result.json
  --min-balance N        override gate floor (default duration*4+2)
  --dry-run              no network upload; build body (needs --reuse-urls or placeholders)
  --reuse-urls           reuse <staging>/uploaded-urls.json (or --out-urls)
  --skip-upload          same as dry-run upload skip; still may call pricing unless --skip-pricing
  --skip-pricing         skip /v1/generator/pricing (dry unit test)
  --ratio 9:16 --resolution 480P
Exit 0 ok; 3 pricing/balance gate; 2 usage`);
}

if (has('--help') || has('-h')) { help(); process.exit(0); }

const STAGING = arg('--staging');
const PROJECT_ID = arg('--project');
if (!STAGING || !PROJECT_ID) {
  help();
  process.exit(2);
}

const OUT_URLS = arg('--out-urls', path.join(STAGING, 'uploaded-urls.json'));
const OUT_BODY = arg('--out-body', path.join(STAGING, 'create-body.json'));
const RESULT = arg('--result', path.join(STAGING, 'upload-body-result.json'));
const RATIO = arg('--ratio', '9:16');
const RESOLUTION = arg('--resolution', '480P');
const DRY = has('--dry-run');
const REUSE = has('--reuse-urls');
const SKIP_UPLOAD = has('--skip-upload') || DRY;
const SKIP_PRICING = has('--skip-pricing') || (DRY && !has('--pricing'));

function readToken() {
  if (process.env.LOVART_TOKEN) return process.env.LOVART_TOKEN.trim();
  const tf = arg('--token-file', arg('--token'));
  if (tf && fs.existsSync(tf)) return fs.readFileSync(tf, 'utf8').trim();
  // common drop points
  for (const p of ['/tmp/l24-usertoken.txt', '/tmp/l15-usertoken.txt', path.join(STAGING, 'usertoken.txt')]) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  }
  return '';
}

const TOKEN = readToken();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function headers() {
  return {
    token: TOKEN,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'accept-language': 'zh-CN',
    Referer: 'https://www.lovart.ai/',
    Origin: 'https://www.lovart.ai',
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  };
}
function mkRefId() {
  return `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function probeImage(file) {
  try {
    const out = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x ${JSON.stringify(file)}`,
      { encoding: 'utf8' }
    ).trim();
    const [w, h] = out.split('x').map(Number);
    if (w && h) return { width: w, height: h };
  } catch (_) {}
  // PNG IHDR
  try {
    const buf = fs.readFileSync(file);
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      // crude JPEG SOF scan
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xc3) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch (_) {}
  return { width: 0, height: 0 };
}

function probeAudioDuration(file) {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${JSON.stringify(file)}`,
      { encoding: 'utf8' }
    ).trim();
    const d = Math.round(Number(out));
    return Number.isFinite(d) && d > 0 ? d : 5;
  } catch (_) {
    return 5;
  }
}

function parseDurationFromPrompt(raw) {
  const m = raw.match(/时长\s*(\d+)\s*秒/);
  if (m) return Number(m[1]);
  const m2 = raw.match(/(\d+)\s*秒，一镜到底/);
  if (m2) return Number(m2[1]);
  return null;
}

function toPlainBracketPrompt(raw) {
  return raw
    .replace(/@图片(\d+)/g, '[图片$1]')
    .replace(/@音频(\d+)/g, '[音频$1]');
}

function toChipPrompt(plain, imageChips, audioChip) {
  let p = plain;
  for (const c of imageChips) {
    const n = c.label.replace('图片 ', '');
    const bare = `[图片${n}]`;
    const chip = `[@image:${c.refId}:${c.label}:${c.url}]`;
    if (!p.includes(bare)) throw new Error('missing bare token ' + bare);
    p = p.split(bare).join(chip);
  }
  {
    const bare = '[音频1]';
    const chip = `[@audio:${audioChip.refId}:${audioChip.label}:${audioChip.url}]`;
    if (!p.includes(bare)) throw new Error('missing bare token ' + bare);
    p = p.split(bare).join(chip);
  }
  if (/\[图片\d+\]/.test(p) || /\[音频\d+\]/.test(p) || /@图片\d+/.test(p) || /@音频\d+/.test(p)) {
    throw new Error('leftover bare media tokens in chip prompt');
  }
  return p;
}

function discoverFiles(staging) {
  const defaults = [
    { name: 'img1-env.jpg', file: 'img1-env.jpg', mime: 'image/jpeg', kind: 'image', label: '图片 1' },
    { name: 'img2-front.png', file: 'img2-front.png', mime: 'image/png', kind: 'image', label: '图片 2' },
    { name: 'img3-oblique.png', file: 'img3-oblique.png', mime: 'image/png', kind: 'image', label: '图片 3' },
    { name: 'img4-side.png', file: 'img4-side.png', mime: 'image/png', kind: 'image', label: '图片 4' },
    { name: 'audio1-qiangge.mp3', file: 'audio1-qiangge.mp3', mime: 'audio/mpeg', kind: 'audio', label: '音频 1' },
  ];
  const manifestPath = path.join(staging, 'staging-manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (Array.isArray(m.files) && m.files.length) return m.files;
    } catch (_) {}
  }
  // allow alternate audio name
  return defaults.map((f) => {
    if (fs.existsSync(path.join(staging, f.file))) return f;
    if (f.kind === 'audio') {
      const alt = ['audio1.mp3', 'audio.mp3', 'voice.mp3'].find((n) => fs.existsSync(path.join(staging, n)));
      if (alt) return { ...f, name: alt, file: alt };
    }
    if (f.kind === 'image' && f.file.endsWith('.jpg') && !fs.existsSync(path.join(staging, f.file))) {
      const png = f.file.replace(/\.jpg$/, '.png');
      if (fs.existsSync(path.join(staging, png))) {
        return { ...f, name: png, file: png, mime: 'image/png' };
      }
    }
    return f;
  });
}

function writeResult(obj) {
  fs.writeFileSync(RESULT, JSON.stringify(obj, null, 2));
}

async function main() {
  const promptPath = path.join(STAGING, 'prompt-with-prefix.txt');
  if (!fs.existsSync(promptPath)) {
    writeResult({ error: 'missing_prompt', path: promptPath });
    throw new Error('missing prompt-with-prefix.txt');
  }
  const rawPrompt = fs.readFileSync(promptPath, 'utf8');
  const parsedDur = parseDurationFromPrompt(rawPrompt);
  const DURATION = Number(arg('--duration', parsedDur != null ? parsedDur : 12));
  const minBalDefault = DURATION * 4 + 2;
  const MIN_BAL = arg('--min-balance') != null ? Number(arg('--min-balance')) : minBalDefault;

  const plainPrompt = toPlainBracketPrompt(rawPrompt);
  const FILES = discoverFiles(STAGING);

  let balanceBefore = null;
  let price = null;

  if (!SKIP_PRICING) {
    if (!TOKEN) {
      writeResult({ error: 'missing_token' });
      console.error('missing token for pricing');
      process.exit(2);
    }
    const priceBody = {
      generator_name: 'wan/wan-3-0',
      input_args: {
        prompt: plainPrompt.slice(0, 200),
        ratio: RATIO,
        duration: DURATION,
        resolution: RESOLUTION,
        total_duration: DURATION,
        has_ref_video: '0',
      },
    };
    const r = await fetch('https://lgw.lovart.ai/v1/generator/pricing', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(priceBody),
    });
    const txt = await r.text();
    console.error('pricing', r.status, txt.slice(0, 350));
    try {
      const j = JSON.parse(txt);
      balanceBefore = j?.data?.balance;
      price = j?.data?.price ?? j?.data?.credit ?? j?.data?.cost;
    } catch (_) {}
    if (
      balanceBefore == null ||
      Number(balanceBefore) < MIN_BAL ||
      (price != null && !(Number(price) < Number(balanceBefore)))
    ) {
      writeResult({ error: 'gate_fail', balanceBefore, price, minBal: MIN_BAL, duration: DURATION });
      console.error('GATE_FAIL bal=' + balanceBefore + ' price=' + price + ' min=' + MIN_BAL);
      process.exit(3);
    }
  } else {
    console.error('skip-pricing (dry/unit)');
    balanceBefore = null;
    price = null;
  }

  let uploaded = [];

  if (REUSE || (SKIP_UPLOAD && fs.existsSync(OUT_URLS))) {
    const urlsPath = fs.existsSync(OUT_URLS)
      ? OUT_URLS
      : path.join(STAGING, 'uploaded-urls-l24.json');
    if (!fs.existsSync(urlsPath) && !fs.existsSync(OUT_URLS)) {
      // try legacy name
      const legacy = path.join(STAGING, 'uploaded-urls-l24.json');
      if (fs.existsSync(legacy)) {
        const prev = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        uploaded = prev.uploaded || [];
        if (balanceBefore == null && prev.balanceBefore != null) balanceBefore = prev.balanceBefore;
        if (price == null && prev.price != null) price = prev.price;
        console.error('reuse-urls', legacy, uploaded.length);
      } else {
        writeResult({ error: 'reuse_urls_missing', tried: [OUT_URLS, urlsPath, legacy] });
        throw new Error('reuse-urls but no uploaded-urls json');
      }
    } else {
      const p = fs.existsSync(OUT_URLS) ? OUT_URLS : urlsPath;
      const prev = JSON.parse(fs.readFileSync(p, 'utf8'));
      uploaded = prev.uploaded || [];
      if (balanceBefore == null && prev.balanceBefore != null) balanceBefore = prev.balanceBefore;
      if (price == null && prev.price != null) price = prev.price;
      console.error('reuse-urls', p, uploaded.length);
    }
  } else if (SKIP_UPLOAD) {
    // placeholder URLs for shape-only dry-run
    console.error('dry-run placeholders (no upload)');
    for (const f of FILES) {
      const fp = path.join(STAGING, f.file);
      if (!fs.existsSync(fp)) {
        uploaded.push({ name: f.name, error: 'missing_file' });
        continue;
      }
      const dims = f.kind === 'image' ? probeImage(fp) : {};
      uploaded.push({
        name: f.name,
        kind: f.kind,
        label: f.label,
        mime: f.mime,
        url: `https://a.lovart.ai/context-forge/temp/upload/dry-run-${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
        putStatus: 200,
        dry_run: true,
        ...dims,
      });
    }
  } else {
    if (!TOKEN) {
      writeResult({ error: 'missing_token' });
      console.error('missing token for upload');
      process.exit(2);
    }
    for (const f of FILES) {
      const fp = path.join(STAGING, f.file);
      if (!fs.existsSync(fp)) {
        uploaded.push({ name: f.name, error: 'missing_file', file: f.file });
        continue;
      }
      const buf = fs.readFileSync(fp);
      const tries = [
        { filename: f.file, content_type: f.mime },
        { file_name: f.file, content_type: f.mime },
        { name: f.file, contentType: f.mime },
      ];
      let preJson = null,
        preTxt = '',
        preStatus = 0,
        usedBody = null;
      for (const body of tries) {
        const rr = await fetch('https://lgw.lovart.ai/v1/kit/presign-temp', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(body),
        });
        preStatus = rr.status;
        preTxt = await rr.text();
        try {
          preJson = JSON.parse(preTxt);
        } catch {
          preJson = null;
        }
        usedBody = body;
        if (preJson && (preJson.code === 'SUCCESS' || preJson.code === 0)) break;
        console.error('presign fail', f.name, JSON.stringify(body), preStatus, preTxt.slice(0, 200));
      }
      if (!preJson || (preJson.code !== 'SUCCESS' && preJson.code !== 0)) {
        uploaded.push({ name: f.name, error: 'presign_failed', preStatus, preTxt: preTxt.slice(0, 500) });
        continue;
      }
      const data = preJson.data || {};
      const uploadUrl = data.upload_url || data.uploadUrl;
      const fileUrl = data.file_url || data.fileUrl || data.url;
      if (!uploadUrl || !fileUrl) {
        uploaded.push({ name: f.name, error: 'presign_missing_urls', data });
        continue;
      }
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': f.mime },
        body: buf,
      });
      console.error('PUT', f.name, put.status, '->', String(fileUrl).slice(0, 80));
      const dims = f.kind === 'image' ? probeImage(fp) : {};
      uploaded.push({
        name: f.name,
        kind: f.kind,
        label: f.label,
        mime: f.mime,
        url: fileUrl,
        putStatus: put.status,
        usedBody,
        ...dims,
      });
      await sleep(200);
    }
    fs.writeFileSync(
      OUT_URLS,
      JSON.stringify(
        { projectId: PROJECT_ID, balanceBefore, price, duration: DURATION, uploaded, at: new Date().toISOString(), dry_run: false },
        null,
        2
      )
    );
  }

  const imgs = uploaded.filter((u) => u.kind === 'image' && u.url && (u.putStatus === 200 || u.dry_run));
  const auds = uploaded.filter((u) => u.kind === 'audio' && u.url && (u.putStatus === 200 || u.dry_run));
  console.error('upload summary', { imgs: imgs.length, auds: auds.length, dry: SKIP_UPLOAD });
  if (imgs.length < 4 || auds.length < 1) {
    writeResult({ error: 'upload_incomplete', uploaded, balanceBefore, price });
    throw new Error('upload incomplete imgs=' + imgs.length + ' auds=' + auds.length);
  }

  const imageMeta = imgs.map((u, idx) => {
    const fp = path.join(STAGING, u.name);
    const probed = fs.existsSync(fp) ? probeImage(fp) : {};
    return {
      url: u.url,
      type: 'image',
      refId: mkRefId(),
      width: u.width || probed.width || 0,
      height: u.height || probed.height || 0,
      label: u.label || `图片 ${idx + 1}`,
    };
  });
  await sleep(5);
  const audioFile = path.join(STAGING, auds[0].name);
  const AUDIO_DURATION = fs.existsSync(audioFile) ? probeAudioDuration(audioFile) : 5;
  const audioMeta = {
    url: auds[0].url,
    type: 'audio',
    refId: mkRefId(),
    duration: AUDIO_DURATION,
    label: auds[0].label || '音频 1',
  };

  const chipPrompt = toChipPrompt(plainPrompt, imageMeta, audioMeta);
  const image_list = imageMeta.map((m) => ({
    role: 'reference_image',
    type: 'image_url',
    image_url: { url: m.url },
  }));
  const audio_list = [
    {
      role: 'reference_audio',
      type: 'audio_url',
      audio_url: { url: audioMeta.url },
    },
  ];

  const original_unit_data = {
    mode: 'pro',
    count: 1,
    image: imageMeta.map(({ url, type, refId, width, height }) => ({ url, type, refId, width, height })),
    ratio: RATIO,
    width: RESOLUTION === '480P' ? 480 : 480,
    height: RESOLUTION === '480P' ? 832 : 832,
    prompt: chipPrompt,
    duration: DURATION,
    audio_list: [{ url: audioMeta.url, type: 'audio', refId: audioMeta.refId, duration: audioMeta.duration }],
    multi_shot: false,
    paramsText: `参考图/视频 · ${RATIO} · ${DURATION}s · ${RESOLUTION}`,
    resolution: RESOLUTION,
    video_list: [],
    multi_prompt: [],
    referenceMode: 'multiImage',
    generator_name: 'wan/wan-3-0',
    generator_type: 'video',
    isAdaptiveSize: false,
  };

  const createBody = {
    cid: randomUUID(),
    project_id: PROJECT_ID,
    generator_name: 'wan/wan-3-0',
    input_args: {
      ratio: RATIO,
      prompt: plainPrompt,
      duration: DURATION,
      audio_list,
      image_list,
      resolution: RESOLUTION,
      original_unit_data,
    },
  };

  const checks = {
    plain_has_bracket_images: ['[图片1]', '[图片2]', '[图片3]', '[图片4]', '[音频1]'].every((t) =>
      plainPrompt.includes(t)
    ),
    plain_has_no_at: !/@图片\d+/.test(plainPrompt) && !/@音频\d+/.test(plainPrompt),
    oud_has_chips:
      (chipPrompt.match(/\[@image:/g) || []).length === 4 &&
      (chipPrompt.match(/\[@audio:/g) || []).length === 1,
    oud_image_n: original_unit_data.image.length,
    oud_audio_n: original_unit_data.audio_list.length,
    image_list_n: image_list.length,
    audio_list_n: audio_list.length,
    mode: original_unit_data.mode,
    referenceMode: original_unit_data.referenceMode,
    no_bare_reference_only: true,
  };
  console.error('checks', checks);
  if (!checks.plain_has_bracket_images || !checks.oud_has_chips || checks.oud_image_n !== 4) {
    writeResult({ error: 'chip_build_fail', checks });
    throw new Error('chip build fail');
  }

  fs.writeFileSync(OUT_BODY, JSON.stringify(createBody, null, 2));
  if (SKIP_UPLOAD && !REUSE) {
    fs.writeFileSync(
      OUT_URLS,
      JSON.stringify(
        {
          projectId: PROJECT_ID,
          balanceBefore,
          price,
          duration: DURATION,
          uploaded,
          at: new Date().toISOString(),
          dry_run: true,
        },
        null,
        2
      )
    );
  }

  const prep = {
    ok: true,
    dry_run: !!(DRY || SKIP_UPLOAD),
    project_id: PROJECT_ID,
    duration: DURATION,
    minBal: MIN_BAL,
    balanceBefore,
    price,
    body_path: OUT_BODY,
    urls_path: OUT_URLS,
    checks,
    image_urls: imageMeta.map((m) => m.url),
    audio_url: audioMeta.url,
    refIds: { images: imageMeta.map((m) => m.refId), audio: audioMeta.refId },
    note: 'NO create POST from this script; use lovart-wan-create-once.cjs',
  };
  writeResult(prep);
  console.log(JSON.stringify(prep, null, 2));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
