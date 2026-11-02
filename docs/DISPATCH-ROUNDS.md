# 画布派发固定模板（主代理复制填空）

公共头（每轮都带）：
```
round=<N 或 2a+2b+3>
Profile <N>｜期望邮箱 <email>
暂存：/workspace/lovart-upload-staging/<短名>/
开局：wmctrl 隐藏 Fork-4；只操作桌面可见 Fork-2（页面工具/Fork-4/sand-playwright-output 不算成功）
Chrome 须由 lovart-canvas-chrome.sh 拉起；裸 switch-profile 禁止用于画布
标签：Fork-2 仅保留 1 个 Lovart 页；禁 Ctrl+T / 禁另开同 project；重开只在当前标签改 URL；进场/收工由主代理跑 lovart-canvas-tabs-trim.sh <projectId>
音频硬闸：未填 audio_scroll_checked（右滑截图）不准写 audio_slot=空、不准本地/素材重挂；右滑见 0:05 即已挂上
evidence 必须写回该暂存下 CANVAS-GATE.md 对应节
任一阶段失败即 STOP 截图回报，禁止跳过闸门硬做下一阶段
```

## round=1 核邮箱 + 锁规格 + 复核（单独派）
成功标准：`email_ok`、`spec_bar_text`（含参考图/视频·目标比例·时长·480P）、`spec_recheck_shot`、`model=Wan 3.0`
默认底栏常是「首尾帧·16:9·5s·1080P」→ **改成**参考图/视频，不是 abort；只有误进首尾帧编辑器改不回才 `abort=首尾帧`
禁止：上传图/音频；粘贴；刷新

## round=2a+2b+3 连锁（推荐，省轮间唤醒）
前置：第 1 节字段齐全
同一 computerUse 内严格按序，**每阶段写完证据才进下一阶段**：

### 2a 四图
成功：`imgs_ok`。「上传图片」多选环境+**三视图全套（正面+斜面+侧面，缺一停）**；禁勾 mp3；禁止只上传正面一张。

### 2b 音频（优先我的素材）
成功：`audio_scroll_checked` + `audio_slot`（显时长）+ `audio_via=素材|本地|unknown-already-present`
0. **先右滑**：点参考条向右箭头，截图写入 `audio_scroll_checked`。已见波形+0:05 → 直接成功，禁止再挂。
1. 仅右滑后仍空：音频槽菜单点 **「我的素材」**（勿先点「音频」——易开本地 Open Files）
2. 已弹出 Open Files → **立刻 Escape**，禁止点 Open
3. 素材无 → STOP；本地仅主代理书面授权；Open 后仍须右滑再判，右滑后仍无时长才 STOP

### 3 粘贴 + 转芯片
成功：`chips_ok` **已写入 GATE**（五枚真芯片含**正面+斜面+侧面全锁** + 已滚到文末「禁止字幕…」各 1 张；禁像素空扫；只锁正面不算过）
`xclip` 贴 `prompt-body-for-paste.txt` → 逐个删 `@图片N`/`@音频1` 纯文字再 `@` 点选成芯片
参考条若有 `0:00`+`0:05`：先删 `0:00`，芯片绑 `0:05`
禁提示词框 Enter/Ctrl+F；禁刷新；禁发送
连锁结束未写齐 `imgs_ok`/`audio_*`/`chips_ok` → 只能报 partial/STOP，不准报 next_allowed=4

任一阶段失败：STOP，回报已写到哪一节；主代理可只重派失败段（如单独 `round=2b` 或 `round=3-finish`）。

## round=2a / 2b / 3 单独派（仅连锁失败后补洞）
模板同上一节对应阶段；前置仍读 CANVAS-GATE。

## round=4 三确认后发送一次（单独派）
前置：1–3 齐全（含已写入的 `chips_ok`）；本轮再读设置条与余额写 `confirm_*`
成功：三项 confirm 证据后**只点一次发送**；写 `send_clicked_at`
`confirm_chips` 可引用未改动的 `chips_ok` 截图；`confirm_spec`/`confirm_balance` 须本轮新截
禁止：缺 confirm 就发；生成中再发；chips_ok 未写就开本轮

## round=5 等待成片并下载（单独派）
前置：`send_clicked_at` 且曾显示生成中
成功：mp4 在 `04-生成/`，写 `download_path`
禁止：再点发送；草稿未发出前勿空等


### 防双扣（2026-10-31）
- 点发送后**禁止**因「没看到 task_id / 像没提交」再点或再派 round4。
- 若走 API：只用 `lovart-wan-create-once.cjs`；成功字段是 `generator_task_id`。
