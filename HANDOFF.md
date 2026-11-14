# Lovart 出片脚本迁移包（公开版）

> 本仓库是 **Grok Bot · Lovart** 机器人的脚本与规则迁移包。  
> **不含** ak/sk、cookie、账号邮箱、余额快照、登录态。密钥与账号请导入方自行配置。

## 克隆

```bash
git clone https://github.com/superfeng53-bot/grok-bot-lovart.git
cd grok-bot-lovart
```

建议放到 Grok Bot box 的 `/workspace/lovart-bot/`（或软链 `bin/` 到 `/home/box/bin/`）。

## 目录

| 路径 | 用途 |
|------|------|
| `bin/` | 画布 Wan 批量入口、纯请求、选号、拷 Mac、防 cookie、画布 Chrome |
| `lovart-auto/` | 每日积分到账程序化扫号（CDP + supercronic） |
| `docs/` | 双扣根因备忘、`CANVAS-GATE.template.md`、`DISPATCH-ROUNDS.md`、`batch-forward.template.md` |
| `docs/SUBMIT-DEFAULTS.md` | 出图默认 Seedream 5.5。CLI 视频与画布 Wan 仍以本文件正文为准 |
| `docs/skills/lovart-seedance.md` | 静图提交摘录（Seedream 5.5）。CLI 视频规则仍以本文件正文为准 |
| `examples/wan-canvas-batch.example.json` | 画布 Wan 批量 manifest 示例（占位邮箱，默认 dry-run） |
| `examples/image-default.example.json` | 出图默认：Seedream 5.5（无账号、无密钥、不发起生成） |
| `examples/accounts.example.json` | CLI 账号占位示例（填自己的 ak/sk） |
| `HANDOFF.md` | 本文件：积分核验与脚本索引（公开版） |

## 积分核验（2026-11-01，现行）

已取消充值号「当天 1 画布 + 1 CLI」次数限制。出片只看积分：

- **画布 Wan 3.0 480p**：余额 **≥ 时长秒×4+2**，且本条预估 **< 当前余额**（出完后余额仍 >0）。选号：`bin/lovart-cli-pick-recharge.sh canvas <秒>`（不再跳过本日已画布）。
- **CLI Seedance 2.5**：余额 **>0** 直接交；禁止因「看起来不够」提交前先问。仅平台 Insufficient／余额 0／生成中途不足时停下询问。选号同脚本 `cli` 模式（只跳过本日 Insufficient）。
- 特殊号（现场余额 >100）出视频前须用户已经说「发送」，并记在 manifest 的 `user_said_send` 或命令行 `--user-said-send <账号>`。未记录则停（exit 4），不 create。
- 非 Seedance 2.5 不出 CLI。出图用免费号，充值号只出视频。

## 出图默认（2026-11-13）

封面、线稿、画中画静图等静图默认模型是 **Seedream 5.5**，工具名 `generate_image_seedream_v5_5`。出图用免费号；充值号只出视频。CLI 视频默认保持 Seedance 2.5（`generate_video_seedance_v2_5`）。画布默认保持 Wan 3.0。

```bash
--prefer-models '{"IMAGE":["generate_image_seedream_v5_5"]}' \
--include-tools generate_image_seedream_v5_5 \
--mode fast
```

`--include-tools` 是强引导。被请求的工具拒单后，Agent 仍可能改用别的工具。跑完先读结果里的 `failures` 和 `warning`。`failures` 非空时，按被拒的工具和原因回报。实际调用的工具以结果记录为准；请求参数里的工具名只表示提交时的引导。带原图的编辑未在本仓实测，不列入已支持能力。机器可读副本：`examples/image-default.example.json`。

## 画布出片优先级

1. 纯请求（真芯片 API）  
2. CDP  
3. computerUse 点点点（兜底）

正式锁脸须画布 @芯片（三视图全套），禁止裸 `reference_image` 当正式母片。

## 画布 Wan 批量（操作员入口）

默认 **dry-run**，不 POST create。计费必须同时给 `--no-dry-run` 和 `--allow-create-once`。只给其中一个会 exit 6。

```bash
bin/lovart-wan-batch.sh --manifest examples/wan-canvas-batch.example.json
bin/lovart-wan-batch.sh --manifest /path/manifest.json --no-dry-run --allow-create-once
bin/lovart-wan-item.sh --prompt P.md --staging DIR --project ID --profile N \
  --account L24 --expect-email you@example.invalid --duration 12 --intent NAME \
  --output-mp4 01-wan-母片.mp4 \
  --mac-project-dir "/Volumes/.../项目/.../母片" \
  --env img1 --front img2 --oblique img3 --side img4 --audio audio1
```

`lovart-wan-batch.sh` 读 manifest，按列表串行调用 `lovart-wan-pure-master.sh`。计费时 pure-master 在现场询价通过后只调用一次 `lovart-wan-create-once.cjs`，成功后 `lovart-wan-finish-item.cjs` 再调用 `lovart-wan-poll-download.cjs` 与 `lovart-wan-write-gate-result.cjs`，写下 size、md5、片长、`CANVAS-GATE.md`、`RESULT.md`。每条结束和整批结束都写出片进度，可原样转发的句子来自 `docs/batch-forward.template.md`。

Manifest 每条要有提示词路径、staging、时长、intent、输出 mp4 文件名。共用字段是项目母片目录（项目夹 `母片/`），以及账号池：账号 id、Chrome Profile、期望邮箱、已有画布 `project_id`。

### 硬规则

脚本里直接判断，停批时把原因写进出片进度和转发句：

- 同一充值号连续最多 2 条。第 2 条仍须过上一节的画布门闩：现场余额 ≥ 时长秒×4+2，且现场报价 < 当前余额。报价来自平台 pricing，脚本不另算更低单价。
- 同一账号做完第 N 条（含下载或明确失败）才开始第 N+1。整批一个进程串行，并用 `/tmp/lovart-wan-batch.lock` 挡住另一个批次同时 create。
- 门闩失败，或平台返回 Insufficient／无积分：停批并写明原因。账号停在 manifest 指定的这一户。
- 现场余额 >100：没有 `user_said_send` 或 `--user-said-send` 就不 create，exit 4，并写明需要用户说「发送」。
- 同一 intent 一旦已有成功的 `generator_task_id`，不再 POST。疑似双扣仍只走 create-once：写 ALERT 后停批。
- 下载成功后只写 Mac 拷贝配方（box 路径、md5、size、项目母片目录；大于 10MiB 则拆成 `.partNNN`）。目标目录没核到文件之前，转发句保持「Mac 未拷贝，两处 md5 未核」。母片拷到项目夹 `母片/`。box 侧 CopyFromBox 和 Mac 上的 `lovart-wan-copy-mac-master.sh` 要另外做。显式 `--run-mac-copy` 且卷不可达时 exit 4。
- 成片后等用户说「剪」。脚本不交接剪辑。

退出码：0 本批按规则跑完（Mac 仍可能待人工）；2 用法；3 无号或积分门闩；4 需用户（特殊号未放行、Insufficient、Mac 卷不可达）；6 政策停（连续超过 2 条、拒绝第二次 create、双扣 ALERT）。

Chrome 切 Profile 只用 `lovart-canvas-chrome.sh`。每次操作前跑 `lovart-anti-cookie-ensure.sh`。选号脚本会跑。计费时如果它退出 3（没有能过余额门槛的号），批次停。如果它给出另一个账号，批次仍用 manifest 里的这一户。dry-run 把选号结果写在出片进度的附注里，仍用 manifest 里的账号，并且不 create。

### 内部步骤（由上面的入口调用）

1. `lovart-wan-prep-staging.cjs` — 抽前缀/块/时长，拷四图一音  
2. `lovart-wan-extract-token.cjs` — 从已登录 CDP Chrome 取 usertoken  
3. `lovart-wan-sign-headers.cjs` — wasm 签名头  
4. `lovart-wan-upload-and-body.cjs` — 上传素材 + pricing + 组 create body（真芯片）  
5. `lovart-wan-create-once.cjs` — **单次** POST + flock + ledger（防双扣；解析优先 `generator_task_id`）  
6. `lovart-wan-poll-download.cjs` — 轮询并下载 mp4  
7. `lovart-wan-write-gate-result.cjs` — 写 GATE / RESULT  
8. `lovart-wan-finish-item.cjs` — 把 6、7 和 Mac 配方接在 create 成功之后  
9. `lovart-wan-copy-mac-master.sh` — 在 Mac 上只拷项目夹母片 + 两处 md5（本仓的批量入口默认不跑它）  
10. `lovart-wan-pure-master.sh` — ensure → prep → pick → token → sign → upload → 可选的一次 create → finish  

配套：`lovart-wan-parse-task-id.cjs`、`lovart-wan-ledger-close.cjs`。旧 sign-and-create 入口应 `exit 99`。详见 `docs/wan-double-create-2026-10-31.md`。

## 防 Cookie（纯 bash，禁止 LLM 巡检）

1. 守护：`bin/kill-sand-cookie-persist.sh`（杀 persist / session-sync / import；种子路径目录化只读）  
2. 每次 Lovart 操作前：`bin/lovart-anti-cookie-ensure.sh`  
3. 画布建议用：`bin/lovart-canvas-chrome.sh`；标签纪律：`bin/lovart-canvas-tabs-trim.sh`  

各 Chrome Profile **禁止** cookie 同步/隔离串号。

## 每日积分检查（`lovart-auto/`）

- 入口：`run.sh first|recheck`；定时：`scheduler.sh` + `crontab`（上海 9/10/11 点，均 `timeout` 包裹：first 75m / recheck 40m）。单号 CDP 超时后须带超时收尸；禁止外层再 `flock`；`scheduler.sh restart` 可清「仍在跑」僵尸（2026-11-03）。  
- 检查器：`check-one.cjs`；主程序：`lovart_auto.py`  
- 摘要写 `summary-YYYY-MM-DD.json`；日报只报 L 编号，不写邮箱  
- 导入方需自备 Chrome Profile 与 `lovart-daily-credits-state.json` 结构（本包不含真实 state）

## 明确不含（勿提交）

- `lovart-sk-pairs.md` / `lovart-lobot-ids.md` / 任意 ak_ sk_ 真值  
- `accounts.json`（真账号）、cookie、usertoken、Chrome user-data  
- 余额快照、积分日报 JSON、项目母片与素材  

CLI 真账号请复制 `examples/accounts.example.json` 为本地 `accounts.json` 后自行填写。

## 与 Bot 模板的关系

Grok Bot「Lovart」分享模板只含技能与说明；**本仓库**提供可执行脚本。导入模板后请再 clone 本仓并按上表落位。

## 许可与免责

脚本按现状提供，面向自行运营的 Lovart.ai 多账号工作流。公开仓不含密钥；泄露风险由导入方自控本地密钥文件。
