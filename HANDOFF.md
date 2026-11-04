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
| `bin/` | 画布纯请求 Wan、选号、拷 Mac、防 cookie、画布 Chrome 助手 |
| `lovart-auto/` | 每日积分到账程序化扫号（CDP + supercronic） |
| `docs/` | 双扣根因备忘、`CANVAS-GATE.template.md`、`DISPATCH-ROUNDS.md` |
| `examples/accounts.example.json` | CLI 账号占位示例（填自己的 ak/sk） |
| `HANDOFF.md` | 本文件：积分核验与脚本索引（公开版） |

## 积分核验（2026-11-01，现行）

已取消充值号「当天 1 画布 + 1 CLI」次数限制。出片只看积分：

- **画布 Wan 3.0 480p**：余额 **≥ 时长秒×4+2**，且本条预估 **< 当前余额**（出完后余额仍 >0）。选号：`bin/lovart-cli-pick-recharge.sh canvas <秒>`（不再跳过本日已画布）。
- **CLI Seedance 2.5**：余额 **>0** 直接交；禁止因「看起来不够」提交前先问。仅平台 Insufficient／余额 0／生成中途不足时停下询问。选号同脚本 `cli` 模式（只跳过本日 Insufficient）。
- 特殊号（余额 >100）出视频前须用户放行。
- 非 Seedance 2.5 不出 CLI。出图用免费号，充值号只出视频。

## 画布出片优先级

1. 纯请求（真芯片 API）  
2. CDP  
3. computerUse 点点点（兜底）

正式锁脸须画布 @芯片（三视图全套），禁止裸 `reference_image` 当正式母片。

## 纯请求流水线（`bin/`）

默认 **dry-run**（`lovart-wan-pure-master.sh`）。真跑需显式去掉 dry-run。

1. `lovart-wan-prep-staging.cjs` — 抽前缀/块/时长，拷四图一音  
2. `lovart-wan-extract-token.cjs` — 从已登录 CDP Chrome 取 usertoken  
3. `lovart-wan-sign-headers.cjs` — wasm 签名头  
4. `lovart-wan-upload-and-body.cjs` — 上传素材 + pricing + 组 create body（真芯片）  
5. `lovart-wan-create-once.cjs` — **单次** POST + flock + ledger（防双扣；解析优先 `generator_task_id`）  
6. `lovart-wan-poll-download.cjs` — 轮询并下载 mp4  
7. `lovart-wan-write-gate-result.cjs` — 写 GATE 结果行  
8. `lovart-wan-copy-mac-master.sh` — 双目录拷 Mac + 三处 md5  
9. `lovart-wan-pure-master.sh` — 外壳串起来  

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
