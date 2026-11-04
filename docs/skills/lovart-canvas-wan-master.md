> 摘自 Lovart 出片 bot 技能，供公开仓对照。**权威默认参数一览见** [`../SUBMIT-DEFAULTS.md`](../SUBMIT-DEFAULTS.md)。
> 已去掉本机 machineId / 外接盘绝对路径等私有值；你自己的路径请按本机改。

---
name: lovart-canvas-wan-master
description: >-
  Use only when the user explicitly asks for the second master-output path:
  submit Wan video on Lovart web canvas (not CLI/Seedance 2.5), wait, download
  mp4 as 母片. Prefer pure-request API, then CDP, computerUse last.
---
# Lovart 画布 Wan 出母片（第二种，指定才用）

出片路径**无默认**（2026-10-28）：用户选定「画布 / Wan / 网页出」时用本流程；选定 CLI 时走 [lovart-seedance](sand-workflow:lovart-seedance)。交接未点名＝打回选题雷达，禁止再问用户、禁止默认 CLI。

## 出片手段优先级（2026-11-01 用户定）
1. **优先纯请求**：对照 CDP 抓包的真芯片编码，用 `/workspace/lovart-bot/bin/lovart-wan-create-once.cjs` 直发（OUD `[@image:refId:…]` + `oud.image` + `image_list` role=`reference_image`；提示词正文只用 `[图片N]`）。成功先以 `generator_task_id` 为准。
2. **其次 CDP**：puppeteer-core 驱动画布挂图/转芯片/发送；可抓 create 请求体，用来对照修纯请求。CDP 发送禁 Enter 选芯片菜单、只点一次发送、发送前读询价。
3. **最后兜底 computerUse 点点点**：仅纯请求与 CDP 都不可用或卡住时，再按下方 round 闸门派桌面点击。

正式锁脸无论走哪条：**强哥三视图正面+斜面+侧面全部真 @芯片**；只锁正面或裸 `reference_image` 不算过闸。

## 纯请求流水线脚本（2026-11-01 固化，省 Token）
路径均在 `/workspace/lovart-bot/bin/`（软链 `/home/box/bin/`）。**以后 08+ 只填参调这些脚本，禁止再复制改 `/tmp/yz20-*-upload-and-body.cjs`。**

| 脚本 | 用途 | 关键参数 |
|------|------|----------|
| `lovart-wan-pure-master.sh` | 外壳串 ensure→prep→pick→token→sign→pricing/upload-body；**默认 `--dry-run`，不 create** | `--prompt` `--staging` `--project` `--profile` `--duration`；正式 create 须另加 `--no-dry-run --allow-create-once`（仍只调已有 create-once） |
| `lovart-wan-prep-staging.cjs` | 从提示词 md 抽 `[H] 提交前缀`/`可复制块`、拷环境图+强哥三视图+音频、写 staging | `--prompt` `--staging` `[--duration]` `[--env/--front/--oblique/--side/--audio]` `--force` |
| `lovart-wan-extract-token.cjs` | CDP 取 usertoken | `--profile N` `--cdp` `--out`；或 `--from-file` |
| `lovart-wan-sign-headers.cjs` | wasm 签 `X-Send-Timestamp`/`X-Req-Uuid`/`X-Client-Signature`（优先 `/tmp/lovart-wasm/sign.wasm`） | `--wasm` `--out` `--self-test` |
| `lovart-wan-upload-and-body.cjs` | 上传 staging + 组真芯片 create body（**本脚本永不 POST create**）+ pricing 门闩 | `--staging` `--project` `--duration` `--token-file`；`--dry-run`/`--reuse-urls`/`--skip-pricing` |
| `lovart-wan-create-once.cjs` | **唯一**允许的 create POST（复用，勿重做） | `--project` `--intent` `--body` `--out`；验证用 `--dry-run` |
| `lovart-wan-poll-download.cjs` | 轮询 task 下载 mp4 | `--task` `--out` `--token-file`；`--dry-run` |
| `lovart-wan-write-gate-result.cjs` | 填 CANVAS-GATE.md / RESULT.md / 可选项目卡变更行 | `--staging` `--from-json` `--set k=v` `--project-card` |
| `lovart-wan-copy-mac-master.sh` | **Mac 侧**：`~/.grok-staging`→成品母片+项目母片，三处 md5；卷不可达 exit 4 | `--name` `--mac-project-dir` `[--mac-product-dir]`；box 仍先 CopyFromBox |

退出码约定：0 成功；3 无号/门闩；4 需用户（含 Mac 不可达）；5 建议降级 CDP；6 策略停。真芯片：OUD `[@image:refId:…]` + `oud.image` + `image_list`；禁止裸 `reference_image` 当正式路径。


## 根因纪律（2026-10-24）
散文「禁止/必须」挡不住跳过。本技能靠 **缺证据就不能派下一轮**：每条母片一份 `CANVAS-GATE.md`，派发只能填空模板。细节模板见同目录 `CANVAS-GATE.template.md`、`DISPATCH-ROUNDS.md`。纯请求路径也须写最小闸门（选号/余额/intent/task_id/下载/md5）；走 computerUse 时仍按全套 GATE。

## 耗时复盘
- **2026-10-25 工地③**：墙钟约 78 分，平台生成约 4 分。已改：藏 Fork-4、2a→2b→3 连锁、转芯片快路径、音频优先我的素材。
- **2026-10-27 施工完工⑤⑥**（相对③仍偏慢，未达 25–35 分目标）：
  - ⑤：规格约 12:58 → 发送 14:06（操作约 **68 分**）+ 平台约 **5 分**。大头≈**32 分** 误判音频未挂→本地重挂→才右滑发现已有 0:05（并留下 0:00+0:05 双音频）。
  - ⑥：进场约 14:14 → 发送 15:05（操作约 **51 分**）+ 平台约 **8–11 分**。大头≈**13 分** 芯片已插入却未写 GATE/未核文末 → partial 再开一轮，且文末证据像素空扫爆炸。
- **已补（10-27）**：`audio_scroll_checked`；芯片须滚动核完；见下「证据预算」「双音频」「GATE 未写=未过」「confirm 可引用」。
- 目标仍：**单条操作墙钟约 25–35 分钟（含生成）**；纯请求成功时应远低于此。

## 标签堆积复盘（2026-10-26 ③④）
用户看到顶栏十几个 Lovart 页。根因：
1. 每轮 computerUse / Chrome 被桌面停掉后，用 **新开标签** 再进 `canvas?projectId=…`，旧 home / 旧 project 标签不关；
2. 技能虽写「禁另开同项目标签」，但无进场清理脚本，也未写进派发公共头。

**已加**：`/home/box/bin/lovart-canvas-tabs-trim.sh [projectId]`（CDP :9224 只留一页）；见下「标签纪律」。

## 开画布前（主代理，禁止跳）
1. `/home/box/bin/lovart-anti-cookie-ensure.sh` 见 `OK`（禁 LLM 巡检 cookie）。
2. **必须** `Skill(lovart-canvas-wan-master)`；把本技能关键闸门句粘进派发文案。无 Skill 加载痕迹 → 不准派 computerUse。
3. 暂存：优先 `lovart-wan-prep-staging.cjs --prompt <md> --staging /workspace/lovart-upload-staging/<短名>/`（抽前缀/可复制块、拷环境图+强哥三视图+音频）。缺一不准开画布；**禁止只备正面一张**。纯请求再跑 upload-and-body（或 pure-master dry-run）生成真芯片 body；**不要**贴 [H] 表格进提示词框。
4. 从 `CANVAS-GATE.template.md` 复制出 `…/<短名>/CANVAS-GATE.md`，填 `skill_loaded_at=`（ISO 时间）。缺此文件 → 不准开第 1 轮。纯请求可写精简 GATE（选号/余额/intent/create-once/task_id）。
5. `flock /tmp/lovart-auto.lock`；**画布切号必须**用 `/home/box/bin/lovart-canvas-chrome.sh <N>`。**禁止**裸 `switch-profile.sh`。`ps` 确认 `--profile-directory=Profile N`。纯请求仍须该号 cookie/`usertoken` 与邮箱核验。
6. **进场必做**（CDP/computerUse）：`wmctrl` 隐藏/最小化 Fork-4；只保留 Fork-2 Lovart 置顶。派发文案写死：**禁止 browser_tabs / 页面工具 / 点 Fork-4**。
7. **标签纪律（2026-10-26）**：派 round1 前、每轮结束后、Mac 拷完后，主代理跑 `lovart-canvas-tabs-trim.sh <projectId>`（无 projectId 时只留一个 canvas）。目标：**Fork-2 同时最多 1 个 Lovart 标签**。
8. **音频预热**：派 round1 前确认该号「我的素材」已有 voice/强哥音频。没有则先上传到素材再开画布。纯请求用已上传 artifact URL。

## 积分与账号
- 普通充值号优先；双门闩：余额 **≥ 时长秒×4+2**（例 12s→≥50）且预估 **< 余额**（出完后 >0）。选号：`lovart-cli-pick-recharge.sh canvas <秒>`。特殊号（余额>100）发送前须用户说「发送」。
- **积分核验（2026-11-01）**：已取消「当天画布只能一次」。同号只要过余额门闩可再出。非 Seedance 2.5 不出 CLI。
- **选号**：当前号过不了闸门 → **停下询问用户**，**不自动换号**（用户放权按规则续选时除外）。
- 母片出完直接拷 Mac；禁止因母片自检／“要不要再出一遍”问用户。

## 证据闸门（缺字段 = 不准进下一阶段）
| 轮 | 做完才准开下一阶段 | 必须写入 CANVAS-GATE |
|----|------------------|----------------------|
| 0 预检 | — | `skill_loaded_at` `profile` `email_ok` `staging_ready` `chrome_launch=canvas-chrome` |
| 1 规格 | 未复核不准上传 | `spec_bar_text`（整行原文）`spec_recheck_shot` `model=Wan3.0` |
| 2a 四图 | — | `imgs_ok`（四图缩略图截图） |
| 2b 音频 | 未挂上不准转芯片 | 先 `audio_scroll_checked`（右滑截图）；再 `audio_slot`（0:05）；`audio_via`。未右滑不准判空、不准重挂 |
| 3 芯片 | 缺正面/斜面/侧面任一不准发 | `chips_ok`（环境+**三视图脸**+音频共五枚真芯片；须能辨认正面、斜面、侧面） |
| 4 发送 | 三确认缺一不可 | `confirm_spec` `confirm_chips` `confirm_balance` 全 OK 才点发送 |
| 5 下载 | — | `download_path` 后按 seedance 拷 Mac |
| Mac | 项目卡不得留「待拷Mac」 | `mac_path` `mac_md5` 与 box 一致 |

读 `CANVAS-GATE.md` 缺上表字段 → **STOP**，补证据或截图问用户；禁止凭记忆继续。纯请求路径用精简 GATE 时仍须有选号/余额/intent/`generator_task_id`/下载路径/md5。

## 规格硬规则
- 进「视频」后底栏**常默认**「首尾帧 · 16:9 · 5s · 1080P」——这是**待改的默认态**，不是 abort。正确动作：点规格芯片 → 生成方式改 **参考图/视频** → 9:16 → 目标时长 → **480P**；再开设置复核。
- 只有**误点进首尾帧上传编辑器且改不回来**才写 `abort=首尾帧` 并 STOP。
- 顺序：先 **参考图/视频** → 比例 → 时长 → 分辨率。
- `spec_bar_text` 须含「参考图/视频」+ 目标比例/时长 + **480P** + 模型仍 Wan 3.0（列表**下滑**找 Wan，禁只看首屏；误点 Kling/Veo 立即改回）。
- 挂图/贴词期间：设置条冲回首尾帧、参考条变空、Chrome 无 Profile N → STOP；**禁止硬刷新/关窗/另开同项目标签**。

## 标签与重开硬规则（2026-10-26）
1. **禁止** Ctrl+T / 地址栏新开 / 从首页再点进同 project 开第二标签。
2. 需要回到某 `projectId`：先在已有标签里找；有则点该标签（或 CDP activate）；没有才在**当前唯一标签**地址栏改 URL 回车（同标签导航）。
3. Chrome/桌面被停后重开：`lovart-canvas-chrome.sh` 拉起后 **只开一个** project URL，立刻 `lovart-canvas-tabs-trim.sh <projectId>`。
4. round=5 进场：若进程不在，按上条重开；**禁止**为「多等几次」再叠开标签。
5. 派发公共头必写：`开局先确认 Fork-2 仅 1 个 Lovart 标签；多则主代理已 trim 或本轮先关到 1 个；禁新开标签`。

## 挂音频硬规则（崩窗 + 参考条遮挡）
1. **优先**：音频槽弹出菜单后点 **「我的素材」**（不要先点菜单里的「音频」——那项常开本地 Open Files）。角色/Audio → 勾选 voice → **「添加到生成器」**（禁「添加到对话」）。槽显时长才算。
2. 若已弹出 **Open Files / 本地文件框**：立刻 **Escape** 取消，**禁止点 Open**；改走我的素材。
3. **判空硬闸门（2026-10-26 用户教；2026-10-27 改成证据字段）**：参考条人脸多时，音频缩略图常被挤到右侧，左侧槽位仍显示「+ / 音频」。**任何**「未挂上／重挂／本地／STOP」之前，必须先点参考条 **向右箭头**（或拖轴）并把截图写入 `audio_scroll_checked`。右滑后见到波形 + `0:05` → 已挂上，写 `audio_slot`，**禁止**再开素材/本地重挂。未填 `audio_scroll_checked` = 主代理不准接受「2b 失败」、不准派本地补挂。
4. 仅当 `audio_scroll_checked` 已填且右滑后仍无波形，才准走素材「添加到生成器」或主代理授权的本地文件框。
5. 素材没有 → STOP 回报主代理预传；禁止在 computerUse 死磕文件框。
6. 本地文件框仅主代理书面授权 + canvas-chrome；Open 后须先右滑再判；右滑后 5s 仍无时长 → STOP，禁连点、禁子代理内重启 Chrome。
7. 「上传图片」禁勾 mp3。

## 转芯片快路径（压 round3）
1. `xclip -selection clipboard < prompt-body-for-paste.txt` 后点输入框 Ctrl+V（一次贴全文）。
2. 对 `@图片1`…`@图片4` `@音频1`：选中纯文字 → 删 → 键入 `@` → 点对应缩略图/音频。五个都变成真芯片再截图；其中三张脸必须是**三视图全套**（正面/斜面/侧面），缺一停。
3. **禁提示词框 Enter / Ctrl+F**（芯片菜单禁 ArrowDown+Enter，易误发草稿，曾致 L1 双扣）。
4. **证据预算**：核芯片/文末时，提示词区滚到可见五枚 + 文末「禁止字幕…」各截 **1** 张即可写 `chips_ok`。禁止为找文末做大面积像素扫描、反复 crop/zoom（⑥曾为此空转约 13 分）。
5. 五枚同屏放不下须滚动核完；滚到 `scrollTop` 最大或见到文末句即止。
6. 若只剩部分 `@` 未转成芯片：只补派失败段，禁止整段重贴。
7. **GATE 未写 = 未过**：五枚已插入但未写 `chips_ok` / 未截文末 → 回报 `partial`，主代理只派 `round=3-finish`（滚文末+写 GATE），禁止当过闸开 round4。

## 双音频清理（误挂本地后）
参考条若同时出现 `0:00` 与 `0:05`（常见于误点本地 Open 留下空波形）：转芯片前删掉 `0:00` 那枚，只留 `0:05`；芯片必须点时长为 `0:05` 的那枚（菜单里可能是「音频 2」）。禁止把 `0:00` 绑进提示词。

## round4 confirm 可引用
`confirm_chips`：若 `chips_ok` 已写且本轮未再粘贴/上传/改规格，可直接引用既有 chips 截图路径，不必整段重滚重截。`confirm_spec` / `confirm_balance` 仍须本轮只读复核截图（设置可能被冲掉、余额会变）。

## computerUse 派发策略（2026-10-25 改；仅兜底路径）
主代理派发形态（模板见 `DISPATCH-ROUNDS.md`）：
1. **round=1** 单独派（规格敏感，失败要早停）。
2. **round=2a→2b→3 可连锁**：同一 computerUse 内按序做完，**每阶段写完 CANVAS-GATE 对应节才准进下一阶段**；任一阶段失败立即 STOP 回报，禁止跳过证据。连锁结束时 `imgs_ok`/`audio_*`/`chips_ok` 必须已写入文件，否则 `next_allowed` 只能报 STOP/partial，不准报 4。
3. **round=4** 单独派（三确认 + 只点一次发送）。
4. **round=5** 单独派（等待/下载）；Mac 拷贝仍归主代理/executor；结束后 `lovart-canvas-tabs-trim.sh`。

仍禁止「从开画布一口气做到下载」的无闸门全能任务。优先走纯请求/CDP 时不要默认开 computerUse 全套 round。

每轮/每连锁派发必含：`round=`（或 `round=2a+2b+3`）、Profile N、期望邮箱、暂存路径、成功标准、禁止项、`evidence 写回 CANVAS-GATE`、**只操作 Fork-2**、开局隐藏 Fork-4、**禁新开标签 / 仅 1 个 Lovart 页**。

子代理回报：`round=` `evidence=` `next_allowed=`。

## Mac 拷贝
照 [lovart-seedance](sand-workflow:lovart-seedance)「下载」节：`CopyFromBox` → Mac `~/.grok-staging/`（>10M 不稳则 split）→ 外接硬盘项目 `母片/` → md5 → 项目卡「母片已出…等用户说剪」。**等「剪」再交剪辑。**

## 单一真相源
- 可执行正文只在本技能（workflows）。`/workspace/cloud-repo/pipeline/skills/lovart-canvas-wan-master` 只许指针文件。
- HANDOFF 画布节只做索引。
- `_archived/coords-*` 已作废；勿盲坐标，辨认标签后点。

## API / CDP 发送防双扣（2026-10-31）
根因：create 响应字段是 **`generator_task_id`**，脚本只读 `task_id` → 假失败 → 立刻第二次 POST → 双扣积分（L24 100→3）。

硬规则（脚本层，不只靠口述）：
1. 解析 id **必须优先** `data.generator_task_id`（`lovart-wan-parse-task-id.cjs`；有 id 即成功）。
2. 计费 create **只许** `lovart-wan-create-once.cjs`：同进程 `postedOnce` 禁二发；flock；2h ledger 按 **intent / cid / body 指纹** 拒重；同 project 未 closed 拒；ALERT 未清拒。
3. **禁止**「换 schema / media-only / 没解析到 task_id」二次 POST。失败只停报。
4. 余额骤降 > 询价+2 → 写 `/tmp/lovart-wan-double-charge-ALERT.json` 并 STOP（清文件前禁再 create）。
5. UI/CDP round4：**只点一次发送**；点后进等待，禁止因「没看到 task_id」再点或再派 round4。同线程禁二次 Wan。
6. 正式锁脸：**强哥三视图正面+斜面+侧面（素材库裁脸全套）必须全部挂上并转成真 @芯片**；只挂正面 / 只挂一张脸图 / 裸 `reference_image` URL **一律不算**锁脸通过。`chips_ok` 须能看出三张脸图芯片都在（可滚动核）。纯请求须 OUD 真芯片字段，禁止明文 `@图片N`。

复盘：`/workspace/lovart-bot/docs/wan-double-create-2026-10-31.md`。

## 不做
不自动当默认出片路径。选号/是否能出只看余额门闩，不看「本日是否已画布」。
