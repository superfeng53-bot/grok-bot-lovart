#!/usr/bin/env node
/**
 * 单条收尾：create-once 已经成功（或账本里已有 generator_task_id）之后
 * 调用 lovart-wan-poll-download.cjs 下载 mp4，记录 size/md5/片长，
 * 调用 lovart-wan-write-gate-result.cjs 写 CANVAS-GATE.md + RESULT.md，
 * 写 Mac 拷贝配方。不 POST create。
 *
 * 大于 10MiB 时在 box 上拆成 .partNNN，供之后 CopyFromBox。
 * 不运行 lovart-wan-copy-mac-master.sh，除非显式 --run-mac-copy，
 * 且只有该脚本打印 three_md5_ok 才把 Mac 标成已核验。
 *
 * Exit: 0 下载并写完（Mac 默认仍未核）；2 用法；4 需用户（无成片/任务失败/Mac 卷不可达）；
 *       其他码来自 poll（5 任务失败会改写成 4）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = __dirname;
const TEN_MIB = 10 * 1024 * 1024;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
function has(flag) {
  return process.argv.includes(flag);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function taskIdOf(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (obj.generator_task_id) return String(obj.generator_task_id);
  if (obj.prior && obj.prior.generator_task_id) return String(obj.prior.generator_task_id);
  return '';
}

function md5File(file) {
  const r = spawnSync('md5sum', [file], { encoding: 'utf8' });
  if (r.status !== 0) return '';
  return String(r.stdout || '').trim().split(/\s+/)[0] || '';
}

function probeDuration(file) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) return { seconds: null, source: 'ffprobe_unavailable' };
  const n = Number(String(r.stdout || '').trim());
  if (!Number.isFinite(n) || n <= 0) return { seconds: null, source: 'ffprobe_empty' };
  return { seconds: Math.round(n * 1000) / 1000, source: 'ffprobe' };
}

function splitIfNeeded(mp4Path) {
  const size = fs.statSync(mp4Path).size;
  const base = path.basename(mp4Path);
  const dir = path.dirname(mp4Path);
  const stale = fs.readdirSync(dir).filter((n) => n.startsWith(base + '.part'));
  for (const n of stale) fs.unlinkSync(path.join(dir, n));
  if (size <= TEN_MIB) {
    return { split: false, limit_bytes: TEN_MIB, size, parts: [] };
  }
  const r = spawnSync('split', ['-b', String(TEN_MIB), '-d', '-a', '3', mp4Path, mp4Path + '.part'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error('split failed: ' + (r.stderr || r.stdout || r.status));
  }
  const parts = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(base + '.part'))
    .sort()
    .map((n) => ({
      name: n,
      bytes: fs.statSync(path.join(dir, n)).size,
      staging_name: n,
    }));
  return { split: true, limit_bytes: TEN_MIB, size, parts };
}

function writeRecipe(staging, info) {
  const recipe = {
    mac_copy_status: 'recipe_only',
    mac_verified: false,
    three_md5_ok: false,
    box_path: info.boxPath,
    md5: info.md5,
    size: info.size,
    split: info.split.split,
    limit_bytes: info.split.limit_bytes,
    parts: info.split.parts,
    mac_product_dir: info.macProduct || '',
    mac_project_dir: info.macProject || '',
    output_name: path.basename(info.boxPath),
    note:
      '只准备 box 侧配方。CopyFromBox 与 Mac 上 lovart-wan-copy-mac-master.sh 未执行。' +
      '目标目录未核验，三处 md5 不能写成已通过。',
    mac_command: info.macCommand,
  };
  const jsonPath = path.join(staging, 'copy-recipe.json');
  fs.writeFileSync(jsonPath, JSON.stringify(recipe, null, 2));
  const partLines = recipe.parts.length
    ? recipe.parts.map((p) => `- ${p.name}  ${p.bytes} bytes`).join('\n')
    : '- （未拆分，文件不超过 10MiB）';
  const md = [
    '# Mac 拷贝配方（未执行）',
    '',
    `- mac_copy_status: ${recipe.mac_copy_status}`,
    `- mac_verified: false`,
    `- three_md5_ok: false`,
    `- box_path: ${recipe.box_path}`,
    `- md5: ${recipe.md5}`,
    `- size: ${recipe.size}`,
    `- 成品母片目录: ${recipe.mac_product_dir || '（未提供）'}`,
    `- 项目母片目录: ${recipe.mac_project_dir || '（未提供）'}`,
    '',
    '## 拆分',
    '',
    partLines,
    '',
    '## 人工步骤',
    '',
    '1. 把 box 上的 mp4（若已拆分则带上 `.partNNN`）CopyFromBox 到 Mac `~/.grok-staging/`。',
    '2. 在 Mac 上执行下面的命令。体积大于 10MiB 时，Mac 脚本会把 `名称.part*` 拼回去再拷两处母片。',
    '3. 只有该命令退出 0 且输出 `three_md5_ok: true`，才能说三处 md5 已核。本配方不代表这一步已完成。',
    '',
    '```bash',
    recipe.mac_command,
    '```',
    '',
    recipe.note,
    '',
  ].join('\n');
  const mdPath = path.join(staging, 'copy-recipe.md');
  fs.writeFileSync(mdPath, md);
  return { jsonPath, mdPath, recipe };
}

function macCommand(info) {
  const name = path.basename(info.boxPath);
  const parts = [
    'lovart-wan-copy-mac-master.sh',
    '--name',
    shellQuote(name),
    '--src',
    shellQuote(`~/.grok-staging/${name}`),
    '--mac-product-dir',
    shellQuote(info.macProduct || ''),
    '--mac-project-dir',
    shellQuote(info.macProject || ''),
  ];
  if (info.md5) parts.push('--box-md5', info.md5);
  return parts.join(' ');
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function writeStatus(staging, status) {
  fs.writeFileSync(path.join(staging, 'item-status.json'), JSON.stringify(status, null, 2));
}

function gateSets(status) {
  const pairs = [
    ['intent', status.intent],
    ['project_id', status.project_id],
    ['duration', status.duration],
    ['mp4_duration', status.mp4_duration == null ? '' : status.mp4_duration],
    ['path', 'pure-request'],
    ['profile', status.profile],
    ['account', status.account],
    ['expect_email', status.email],
    ['balance_before', status.balance_before == null ? '' : status.balance_before],
    ['price', status.price == null ? '' : status.price],
    ['balance_after', status.balance_after == null ? '' : status.balance_after],
    ['generator_task_id', status.generator_task_id],
    ['download_path', status.box_path],
    ['box_path', status.box_path],
    ['box_md5', status.md5],
    ['md5', status.md5],
    ['size', status.size == null ? '' : status.size],
    ['artifact_url', status.artifact_url || ''],
    ['mac_copy_status', status.mac_copy_status],
    ['mac_md5_ok', status.three_md5_ok ? 'true' : 'false'],
    ['mac_path_成品', status.mac_product_file || ''],
    ['mac_path_项目', status.mac_project_file || ''],
    ['ok', status.ok ? 'true' : 'false'],
    ['billable_creates', status.billable_creates],
    ['stopped_short', status.stopped_short || ''],
    ['note', status.note],
    ['title', status.intent],
  ];
  if (status.three_md5_ok && status.md5) pairs.push(['mac_md5', status.md5]);
  const args = [];
  for (const [k, v] of pairs) args.push('--set', `${k}=${v == null ? '' : v}`);
  return args;
}

function help() {
  console.log(`lovart-wan-finish-item.cjs — poll, download, GATE/RESULT, Mac copy recipe (no create)
  --staging DIR
  --result PATH          create-once result JSON (generator_task_id or prior.generator_task_id)
  --project ID --intent NAME [--duration N]
  --out-mp4 PATH         default <staging>/04-生成/<intent>-wan-母片.mp4
  --token-file PATH | env LOVART_TOKEN
  --profile N --account ID --expect-email ADDR
  --mac-product-dir DIR --mac-project-dir DIR
  --wasm PATH
  --run-mac-copy         actually run lovart-wan-copy-mac-master.sh (fails if the Mac volume is unreachable)
`);
}

function main() {
  if (has('--help') || has('-h')) {
    help();
    process.exit(0);
  }
  const staging = arg('--staging');
  const resultPath = arg('--result', staging ? path.join(staging, 'create-once-result.json') : '');
  if (!staging || !resultPath) {
    help();
    process.exit(2);
  }
  fs.mkdirSync(staging, { recursive: true });
  const created = readJson(resultPath);
  const taskId = taskIdOf(created);
  const intent = arg('--intent', (created && created.intent) || 'item');
  const projectId = arg('--project', (created && created.project_id) || '');
  const duration = arg('--duration', '');
  const profile = arg('--profile', '');
  const account = arg('--account', '');
  const email = arg('--expect-email', '');
  const macProduct = arg('--mac-product-dir', '');
  const macProject = arg('--mac-project-dir', '');
  const wasm = arg('--wasm', '');
  const outMp4 =
    arg('--out-mp4') || path.join(staging, '04-生成', `${intent}-wan-母片.mp4`);
  const tokenFile = arg('--token-file', '');
  const upload = readJson(path.join(staging, 'upload-body-result.json')) || {};
  const resumed = !(created && created.ok === true && created.generator_task_id && !created.error);

  if (!taskId) {
    const status = baseStatus({
      ok: false,
      intent,
      projectId,
      duration,
      profile,
      account,
      email,
      balance: upload.balanceBefore,
      price: upload.price,
      note: '没有 generator_task_id，不能下载，也不会另起 create。',
      stopped: 'no-generator-task-id',
    });
    writeStatus(staging, status);
    console.error('NO_TASK_ID');
    process.exit(4);
  }

  const pollArgs = [
    path.join(BIN, 'lovart-wan-poll-download.cjs'),
    '--task',
    taskId,
    '--out',
    outMp4,
    '--result',
    path.join(staging, 'download.json'),
  ];
  if (tokenFile) pollArgs.push('--token-file', tokenFile);
  if (wasm) pollArgs.push('--wasm', wasm);
  const poll = spawnSync(process.execPath, pollArgs, { encoding: 'utf8' });
  if (poll.stdout) process.stderr.write(poll.stdout.slice(0, 2000) + '\n');
  if (poll.stderr) process.stderr.write(poll.stderr.slice(0, 2000));
  const pollCode = poll.status == null ? 1 : poll.status;
  if (pollCode !== 0) {
    const mapped = pollCode === 5 || pollCode === 6 ? 4 : pollCode;
    const status = baseStatus({
      ok: false,
      intent,
      projectId,
      duration,
      profile,
      account,
      email,
      balance: upload.balanceBefore,
      price: upload.price,
      taskId,
      note:
        pollCode === 5
          ? '任务失败。已停，不另起 create。'
          : pollCode === 6
            ? '没有成片地址。已停，不另起 create。'
            : `poll-download 退出 ${pollCode}。不另起 create。`,
      stopped: `poll_exit_${pollCode}`,
      billable: resumed ? '0' : '1',
    });
    writeStatus(staging, status);
    console.error(`POLL_EXIT ${pollCode} mapped ${mapped}`);
    process.exit(mapped);
  }

  const downloaded = readJson(path.join(staging, 'download.json')) || {};
  if (!fs.existsSync(outMp4)) {
    console.error('MP4_MISSING', outMp4);
    process.exit(4);
  }
  const md5 = md5File(outMp4);
  if (downloaded.md5 && md5 && downloaded.md5 !== md5) {
    console.error(`MD5_MISMATCH download_json=${downloaded.md5} file=${md5}`);
    process.exit(4);
  }
  const size = fs.statSync(outMp4).size;
  const probed = probeDuration(outMp4);
  let split;
  try {
    split = splitIfNeeded(outMp4);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
  const info = {
    boxPath: outMp4,
    md5: md5 || downloaded.md5 || '',
    size,
    split,
    macProduct,
    macProject,
  };
  info.macCommand = macCommand(info);
  const recipeOut = writeRecipe(staging, info);

  let macVerified = false;
  let macStatus = 'recipe_only';
  let macProductFile = '';
  let macProjectFile = '';
  if (has('--run-mac-copy')) {
    const copy = spawnSync(
      path.join(BIN, 'lovart-wan-copy-mac-master.sh'),
      [
        '--name',
        path.basename(outMp4),
        '--src',
        outMp4,
        '--mac-product-dir',
        macProduct,
        '--mac-project-dir',
        macProject,
        '--box-md5',
        info.md5,
      ],
      { encoding: 'utf8' }
    );
    if (copy.stdout) process.stderr.write(copy.stdout);
    if (copy.stderr) process.stderr.write(copy.stderr);
    let parsed = null;
    try {
      parsed = JSON.parse(String(copy.stdout || '').trim().split('\n').pop());
    } catch {
      parsed = null;
    }
    if (copy.status === 0 && parsed && parsed.three_md5_ok === true) {
      macVerified = true;
      macStatus = 'verified';
      macProductFile = parsed.mac_product || '';
      macProjectFile = parsed.mac_project || '';
    } else {
      const status = baseStatus({
        ok: false,
        intent,
        projectId,
        duration,
        profile,
        account,
        email,
        balance: upload.balanceBefore,
        price: upload.price,
        balanceAfter: downloaded.balance_after,
        taskId,
        boxPath: outMp4,
        md5: info.md5,
        size,
        mp4Duration: probed.seconds,
        note: 'Mac 拷贝未核验（卷不可达或 md5 不一致）。box 文件已在。不另起 create。',
        stopped: 'mac_unverified',
        billable: resumed ? '0' : '1',
        macStatus: 'failed',
      });
      writeStatus(staging, status);
      process.exit(copy.status === 4 ? 4 : 4);
    }
  }

  const close = spawnSync(process.execPath, [path.join(BIN, 'lovart-wan-ledger-close.cjs'), taskId], {
    encoding: 'utf8',
  });
  if (close.status !== 0) {
    console.error('LEDGER_CLOSE_FAIL', close.stderr || close.stdout);
    const status = baseStatus({
      ok: false,
      intent,
      projectId,
      duration,
      profile,
      account,
      email,
      balance: upload.balanceBefore,
      price: upload.price,
      balanceAfter: downloaded.balance_after,
      taskId,
      boxPath: outMp4,
      md5: info.md5,
      size,
      mp4Duration: probed.seconds,
      note: '成片已下载，但 ledger close 失败。批次停止，避免同 project 再 create。不另起 POST。',
      stopped: 'ledger_close_failed',
      billable: resumed ? '0' : '1',
      macStatus,
    });
    status.copy_recipe = recipeOut.jsonPath;
    writeStatus(staging, status);
    process.exit(6);
  }

  const noteParts = [
    resumed ? '沿用已有 generator_task_id，本次未再 POST create。' : 'create-once 一次成功后已下载。',
    probed.source === 'ffprobe' ? `片长 ${probed.seconds}s（ffprobe）。` : '未能 ffprobe，片长未冒充成请求时长。',
    macVerified
      ? 'Mac 两处母片已核，三处 md5 一致。'
      : 'Mac 未拷贝，三处 md5 未核。见 copy-recipe。',
    '不自动剪辑。等用户说「剪」。',
  ];
  const status = baseStatus({
    ok: true,
    intent,
    projectId,
    duration,
    profile,
    account,
    email,
    balance: upload.balanceBefore,
    price: upload.price,
    balanceAfter: downloaded.balance_after,
    taskId,
    boxPath: outMp4,
    md5: info.md5,
    size,
    mp4Duration: probed.seconds,
    artifact: downloaded.artifact_url || '',
    note: noteParts.join(''),
    stopped: '',
    billable: resumed ? '0' : '1',
    macStatus,
    macVerified,
    macProductFile,
    macProjectFile,
  });
  status.copy_recipe = recipeOut.jsonPath;
  status.duration_source = probed.source;
  writeStatus(staging, status);

  const gateArgs = [path.join(BIN, 'lovart-wan-write-gate-result.cjs'), '--staging', staging, '--title', intent];
  gateArgs.push(...gateSets(status));
  const gate = spawnSync(process.execPath, gateArgs, { encoding: 'utf8' });
  if (gate.status !== 0) {
    console.error(gate.stderr || gate.stdout);
    process.exit(gate.status == null ? 1 : gate.status);
  }
  console.log(JSON.stringify({ ok: true, generator_task_id: taskId, box_path: outMp4, md5: info.md5, size, mac_verified: macVerified }));
}

function baseStatus(o) {
  return {
    ok: !!o.ok,
    dry_run: false,
    created: o.billable === '1',
    account: o.account || '',
    profile: o.profile || '',
    email: o.email || '',
    intent: o.intent || '',
    project_id: o.projectId || '',
    duration: o.duration || '',
    balance_before: o.balance == null ? null : o.balance,
    balance_after: o.balanceAfter == null ? null : o.balanceAfter,
    price: o.price == null ? null : o.price,
    quote_source: 'live',
    generator_task_id: o.taskId || '',
    box_path: o.boxPath || '',
    size: o.size == null ? null : o.size,
    md5: o.md5 || '',
    mp4_duration: o.mp4Duration == null ? null : o.mp4Duration,
    artifact_url: o.artifact || '',
    mac_copy_status: o.macStatus || 'recipe_only',
    mac_verified: !!o.macVerified,
    three_md5_ok: !!o.macVerified,
    mac_product_file: o.macProductFile || '',
    mac_project_file: o.macProjectFile || '',
    billable_creates: o.billable || '0',
    stopped_short: o.stopped || '',
    note: o.note || '',
  };
}

module.exports = {
  TEN_MIB,
  splitIfNeeded,
  taskIdOf,
  probeDuration,
  md5File,
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
