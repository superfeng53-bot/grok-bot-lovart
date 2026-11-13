#!/usr/bin/env node
"use strict";

// 静态检查：只读本仓文件，不登录、不生成、不计费。
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const TOOL = "generate_image_seedream_v5_5";
const failures = [];

function check(cond, msg) {
  if (!cond) failures.push(msg);
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function walk(dir, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git" || ent.name === "node_modules") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const spec = JSON.parse(read("examples/image-default.example.json"));
check(spec.display_name === "Seedream 5.5", "example display_name");
check(spec.tool === TOOL, "example tool");
check(
  JSON.stringify(spec.prefer_models) ===
    JSON.stringify({ IMAGE: [TOOL] }),
  "example prefer_models"
);
check(
  JSON.stringify(spec.include_tools) === JSON.stringify([TOOL]),
  "example include_tools"
);
check(spec.include_tools_is_enforced_whitelist === false, "include-tools 不是强制白名单");
check(
  Array.isArray(spec.read_result_fields) &&
    spec.read_result_fields.includes("failures") &&
    spec.read_result_fields.includes("warning"),
  "example 必须要求读 failures 与 warning"
);
check(spec.actual_tool_source === "result_record", "实际工具以结果记录为准");
check(spec.mode === "fast", "example mode");
check(spec.account_kind === "free", "出图仍用免费号");
check(spec.source_image_edit_verified === false, "带原图编辑未实测");
check(spec.video_tool_unchanged === "generate_video_seedance_v2_5", "视频工具保持 Seedance 2.5");
check(spec.canvas_generator_unchanged === "wan/wan-3-0", "画布生成器保持 Wan 3.0");
check(!/ak_|sk_|@/.test(JSON.stringify(spec)), "example 含有密钥或邮箱");

for (const name of ["HANDOFF.md", "README.md"]) {
  const text = read(name);
  check(text.includes("## 出图默认（2026-11-13）"), `${name} 缺少出图默认节`);
  check(text.includes(TOOL), `${name} 缺少工具名`);
  check(text.includes("Seedream 5.5"), `${name} 缺少显示名`);
  check(text.includes("`--include-tools` 是强引导"), `${name} 未说明 include-tools 只是强引导`);
  check(text.includes("`failures`") && text.includes("`warning`"), `${name} 未要求读 failures / warning`);
  check(text.includes("实际调用的工具以结果记录为准"), `${name} 用请求工具名代替了实际工具`);
  check(text.includes("带原图的编辑未在本仓实测"), `${name} 把带原图编辑写成了已支持`);
  check(text.includes("generate_video_seedance_v2_5"), `${name} 去掉了 CLI Seedance 2.5`);
  check(text.includes("Wan 3.0"), `${name} 去掉了画布 Wan 3.0`);
  check(text.includes("出图用免费号"), `${name} 去掉了出图免费号`);
}

const otherImageTool = /generate_image_(?!seedream_v5_5\b)[a-z0-9_]+/;
const files = walk(root, []);
for (const file of files) {
  const rel = path.relative(root, file);
  if (rel === "tests/出图默认静态检查.cjs" || rel.startsWith("tests/")) continue;
  if (!/\.(md|py|cjs|js|json|sh|yml|yaml)$/.test(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  check(!otherImageTool.test(text), `${rel} 仍写着别的出图工具名`);
  if (file.endsWith(".py") && text.includes("COVER_IMAGE_MODEL")) {
    check(
      new RegExp(`COVER_IMAGE_MODEL\\s*=\\s*['"]${TOOL}['"]`).test(text),
      `${rel} 的 COVER_IMAGE_MODEL 不是 ${TOOL}`
    );
  }
}

for (const rel of ["docs/SUBMIT-DEFAULTS.md", "docs/skills/lovart-seedance.md"]) {
  const abs = path.join(root, rel);
  check(fs.existsSync(abs), `${rel} 缺失`);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, "utf8");
  check(text.includes(TOOL), `${rel} 的出图默认不是 Seedream 5.5`);
  check(text.includes("`--include-tools` 是强引导"), `${rel} 未说明 include-tools 只是强引导`);
  check(text.includes("`failures`") && text.includes("`warning`"), `${rel} 未要求读 failures / warning`);
  check(text.includes("实际调用的工具以结果记录为准"), `${rel} 用请求工具名代替了实际工具`);
  check(text.includes("带原图的编辑未在本仓实测"), `${rel} 把带原图编辑写成了已支持`);
  check(text.includes("generate_video_seedance_v2_5"), `${rel} 去掉了 CLI Seedance 2.5`);
  check(text.includes("Wan 3.0"), `${rel} 去掉了画布 Wan 3.0`);
  check(!/generate_image_gpt_image/.test(text), `${rel} 仍把 GPT Image 写成出图默认`);
  check(!/Flare High/.test(text), `${rel} 仍把 Flare High 写成出图默认`);
}

const upload = read("bin/lovart-wan-upload-and-body.cjs");
check(upload.includes("generator_name: 'wan/wan-3-0'"), "画布 body 默认生成器被改动");
check(upload.includes("const RESOLUTION = arg('--resolution', '480P')"), "画布默认分辨率被改动");
check(!upload.includes(TOOL), "出图工具名写进了画布脚本");

const createOnce = read("bin/lovart-wan-create-once.cjs");
check(createOnce.includes("generator_name: 'wan/wan-3-0'"), "create-once 的 Wan 生成器被改动");

const coverScripts = files.filter((file) => path.basename(file) === "cover_oneshot.py");
check(
  coverScripts.every((file) => {
    const text = fs.readFileSync(file, "utf8");
    return new RegExp(`COVER_IMAGE_MODEL\\s*=\\s*['"]${TOOL}['"]`).test(text);
  }),
  "cover_oneshot.py 的 COVER_IMAGE_MODEL 不是 Seedream 5.5"
);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("ok: 出图默认是 Seedream 5.5；Seedance 2.5 与画布 Wan 未改；未访问网络");
for (const rel of [
  "docs/SUBMIT-DEFAULTS.md",
  "docs/skills/lovart-seedance.md",
  "cover_oneshot.py",
]) {
  const present = fs.existsSync(path.join(root, rel));
  console.log(`${present ? "present" : "absent"}: ${rel}`);
}
