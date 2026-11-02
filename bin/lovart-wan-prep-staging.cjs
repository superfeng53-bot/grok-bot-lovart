#!/usr/bin/env node
/**
 * 从提示词 md 抽 ## [H] 提交前缀 / ## 可复制块，解析时长，拷环境图+强哥三视图+音频，
 * 写 prompt-with-prefix.txt、prompt-body-for-paste.txt、staging-manifest.json。
 *
 * Usage:
 *   node lovart-wan-prep-staging.cjs \
 *     --prompt PATH.md --staging DIR [--slug NAME] \
 *     [--env PATH] [--duration N] [--audio PATH] \
 *     [--front PATH] [--oblique PATH] [--side PATH]
 * Exit: 0 ok; 2 usage; 1 missing assets
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
function has(f) { return process.argv.includes(f); }
function help() {
  console.log(`lovart-wan-prep-staging.cjs — build lovart-upload-staging from prompt md
  --prompt PATH.md     required
  --staging DIR        required (created)
  --slug NAME          optional short name note
  --duration N         rewrite 时长N秒 in prefix (optional)
  --env PATH           override 环境图
  --front/--oblique/--side PATH  override 强哥三视图
  --audio PATH         override 音频
  --force              overwrite existing staging files`);
}

if (has('--help') || has('-h')) { help(); process.exit(0); }

const PROMPT = arg('--prompt');
const STAGING = arg('--staging');
if (!PROMPT || !STAGING) { help(); process.exit(2); }
if (!fs.existsSync(PROMPT)) {
  console.error('prompt missing', PROMPT);
  process.exit(1);
}

const DEFAULT_FRONT = '/workspace/项目/_素材库/角色板/强哥/强哥正面-裁脸.png';
const DEFAULT_OBLIQUE = '/workspace/项目/_素材库/角色板/强哥/强哥斜面-裁脸.png';
const DEFAULT_SIDE = '/workspace/项目/_素材库/角色板/强哥/强哥侧面-裁脸.png';
const DEFAULT_AUDIO =
  fs.existsSync('/workspace/短视频-本地规范/角色板/强哥/强哥音频.mp3')
    ? '/workspace/短视频-本地规范/角色板/强哥/强哥音频.mp3'
    : '/workspace/项目/_素材库/角色板/强哥/强哥音频.mp3';

function extractSection(md, headingRe) {
  // headingRe matches a line like ## [H] 提交前缀 or ## 可复制块
  const lines = md.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]) && i > start) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function extractFenced(text) {
  if (!text) return '';
  const m = text.match(/```(?:text|txt)?\n([\s\S]*?)```/);
  if (m) return m[1].replace(/\n$/, '');
  return text.trim();
}

function parseUploadTable(md) {
  const sec = extractSection(md, /^##\s+\[H\]\s*上传/);
  const out = { env: null, front: null, oblique: null, side: null, audio: null };
  if (!sec) return out;
  // Prefer same-line path after @图片1 (markdown table cell), else 环境参考 cell.
  const envM =
    sec.match(/@图片1[^\n]*?(\/workspace\/[^\s|]+)/) ||
    sec.match(/\|\s*环境[^|\n]*\|\s*(\/workspace\/[^\s|]+)/);
  if (envM) out.env = envM[1].replace(/[|·].*$/, '').trim();
  // 强哥 paths may be · separated on one @图片2/@图片3/@图片4 row
  const faceRow = (sec.split('\n').find((l) => l.includes('@图片2') && l.includes('/workspace/')) || '');
  const faceParts = [...faceRow.matchAll(/\/workspace\/[^\s|·]+/g)].map((m) => m[0]);
  if (faceParts[0]) out.front = faceParts[0];
  if (faceParts[1]) out.oblique = faceParts[1];
  if (faceParts[2]) out.side = faceParts[2];
  const audioM =
    sec.match(/@音频1[^\n]*?(\/(?:workspace|home)\/[^\s|]+)/) ||
    sec.match(/强哥音频[^\n]*?(\/(?:workspace|home)\/[^\s|]+)/);
  if (audioM) out.audio = audioM[1].replace(/[|·].*$/, '').trim();
  return out;
}

function parseDuration(prefix, block) {
  const m = (prefix || '').match(/时长\s*(\d+)\s*秒/);
  if (m) return Number(m[1]);
  const m2 = (block || '').match(/(\d+)\s*秒，一镜到底/);
  if (m2) return Number(m2[1]);
  return null;
}

function rewriteDuration(prefix, n) {
  return prefix.replace(/时长\s*\d+\s*秒/, `时长${n}秒`);
}

function cp(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return { src, dest, size: fs.statSync(dest).size };
}

const md = fs.readFileSync(PROMPT, 'utf8');
let prefix = extractSection(md, /^##\s+\[H\]\s*提交前缀/);
let blockSec = extractSection(md, /^##\s+可复制块/);
if (!prefix) {
  console.error('missing ## [H] 提交前缀');
  process.exit(1);
}
if (!blockSec) {
  console.error('missing ## 可复制块');
  process.exit(1);
}
const block = extractFenced(blockSec);
const upload = parseUploadTable(md);

const envSrc = arg('--env', upload.env);
const frontSrc = arg('--front', upload.front || DEFAULT_FRONT);
const obliqueSrc = arg('--oblique', upload.oblique || DEFAULT_OBLIQUE);
const sideSrc = arg('--side', upload.side || DEFAULT_SIDE);
const audioSrc = arg('--audio', upload.audio || DEFAULT_AUDIO);

let duration = parseDuration(prefix, block);
const durOverride = arg('--duration');
if (durOverride != null) {
  duration = Number(durOverride);
  prefix = rewriteDuration(prefix, duration);
}

if (!Number.isFinite(duration) || duration <= 0) {
  console.error('cannot parse duration; pass --duration N');
  process.exit(1);
}

const needed = [
  ['env', envSrc],
  ['front', frontSrc],
  ['oblique', obliqueSrc],
  ['side', sideSrc],
  ['audio', audioSrc],
];
for (const [k, p] of needed) {
  if (!p || !fs.existsSync(p)) {
    console.error('missing asset', k, p);
    process.exit(1);
  }
}

if (fs.existsSync(STAGING) && !has('--force')) {
  const existing = ['img1-env.jpg', 'img2-front.png', 'prompt-with-prefix.txt'].filter((f) =>
    fs.existsSync(path.join(STAGING, f))
  );
  if (existing.length) {
    console.error('staging exists; pass --force to overwrite', STAGING);
    process.exit(1);
  }
}
fs.mkdirSync(STAGING, { recursive: true });

const copies = [];
// env may be jpg or png — upload-and-body accepts img1-env.jpg then .png
{
  const ext = path.extname(envSrc).toLowerCase() || '.jpg';
  if (ext === '.png') {
    copies.push(cp(envSrc, path.join(STAGING, 'img1-env.png')));
  } else {
    copies.push(cp(envSrc, path.join(STAGING, 'img1-env.jpg')));
  }
}
copies.push(cp(frontSrc, path.join(STAGING, 'img2-front.png')));
copies.push(cp(obliqueSrc, path.join(STAGING, 'img3-oblique.png')));
copies.push(cp(sideSrc, path.join(STAGING, 'img4-side.png')));
copies.push(cp(audioSrc, path.join(STAGING, 'audio1-qiangge.mp3')));

const combined = `${prefix.trim()}\n\n${block.trim()}\n`;
fs.writeFileSync(path.join(STAGING, 'prompt-with-prefix.txt'), combined);
fs.writeFileSync(path.join(STAGING, 'prompt-body-for-paste.txt'), combined);

const files = [
  {
    name: fs.existsSync(path.join(STAGING, 'img1-env.jpg')) ? 'img1-env.jpg' : 'img1-env.png',
    file: fs.existsSync(path.join(STAGING, 'img1-env.jpg')) ? 'img1-env.jpg' : 'img1-env.png',
    mime: fs.existsSync(path.join(STAGING, 'img1-env.jpg')) ? 'image/jpeg' : 'image/png',
    kind: 'image',
    label: '图片 1',
  },
  { name: 'img2-front.png', file: 'img2-front.png', mime: 'image/png', kind: 'image', label: '图片 2' },
  { name: 'img3-oblique.png', file: 'img3-oblique.png', mime: 'image/png', kind: 'image', label: '图片 3' },
  { name: 'img4-side.png', file: 'img4-side.png', mime: 'image/png', kind: 'image', label: '图片 4' },
  { name: 'audio1-qiangge.mp3', file: 'audio1-qiangge.mp3', mime: 'audio/mpeg', kind: 'audio', label: '音频 1' },
];

const manifest = {
  ok: true,
  slug: arg('--slug', path.basename(STAGING)),
  prompt_md: path.resolve(PROMPT),
  staging: path.resolve(STAGING),
  duration,
  duration_overridden: durOverride != null,
  sources: { env: envSrc, front: frontSrc, oblique: obliqueSrc, side: sideSrc, audio: audioSrc },
  files,
  copies,
  at: new Date().toISOString(),
};
fs.writeFileSync(path.join(STAGING, 'staging-manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(
  path.join(STAGING, 'STAGING.txt'),
  [
    `slug=${manifest.slug}`,
    `duration=${duration}`,
    `prompt_md=${PROMPT}`,
    `env=${envSrc}`,
    `front=${frontSrc}`,
    `oblique=${obliqueSrc}`,
    `side=${sideSrc}`,
    `audio=${audioSrc}`,
    `files=${files.map((f) => f.file).join(',')}`,
  ].join('\n') + '\n'
);

console.log(JSON.stringify(manifest, null, 2));
