# Lovart 提交默认参数（Bot 最佳实践）

从 Lovart 出片 bot 的技能与本机作业脚本提炼。别人接这套脚本/模板时，**按下列默认走**；只有用户点名才降档或改路。

出片路径本身**无默认**：交接须已点名「CLI Seedance 2.5」或「画布 Wan 3.0 480p」；未点名＝打回选题，禁止默认 CLI、禁止再问用户选路。

---

## 1. CLI Seedance 2.5（有人脸/口播母片）

| 项 | 默认 | 说明 |
|---|---|---|
| 工具 / 模型 | `generate_video_seedance_v2_5` | `--include-tools` + `--prefer-models '{"VIDEO":["generate_video_seedance_v2_5"]}'` |
| 模式 | `--mode fast` | 作业脚本与技能均写死 |
| 分辨率 | 1080p | 用户点名才降档 |
| 画幅 | 9:16 | |
| 有声 | 必须 | CLI **无** `--audio`；写在提交前缀里 |
| 时长 | 提示词 `<N>` 秒 | 跟可复制块/口播定稿 |
| Seedance Mini | 仅无人无脸 B-roll | 有人脸禁止当默认 |

**CLI 固定参数片段：**

```bash
--include-tools generate_video_seedance_v2_5 \
--prefer-models '{"VIDEO":["generate_video_seedance_v2_5"]}' \
--mode fast
```

**提交前缀（口播，前缀不进可复制块）：**

```text
用 Seedance 2.5 直接生成一条口播视频，规格：1080p，时长<N>秒，9:16，有声=必须带口播人声音轨（开口同步出声，禁止只出无声画面）。严格按下面提示词执行，一字不改台词。禁止先生成分镜图、规划图、首帧图或任何静图；禁止视觉规划子代理；只调用 Seedance 2.5 出视频。
```

无口播：把「一条口播视频」改成「一条视频」，删掉「一字不改台词」和「有声=…」；有台词仍挂 `@音频1`。

**余额门闩：** 余额 `>0` 直接交；禁止因「看起来不够」先问。平台 Insufficient／余额 0 才停问、不自动换号。余额 `>100` 视为特殊充值号，出前须用户放行。选号：过闸优先余额 `<100`、越小越先；`=100` 靠后。非 Seedance 2.5 不出 CLI。

---

## 2. 画布 Wan 3.0（用户点名「画布 / Wan / 网页出」）

UI 进「视频」后底栏常落在「首尾帧 · 16:9 · 5s · 1080P」——这是**待改的平台默认态**，不是目标规格。须改成：

| 项 | 默认（正确态） | 平台易错默认 |
|---|---|---|
| 模型 | Wan 3.0（`wan/wan-3-0`） | 列表下滑找 Wan；误点 Kling/Veo 立即改回 |
| 生成方式 | **参考图/视频** | 首尾帧 |
| 画幅 | **9:16** | 16:9 |
| 分辨率 | **480P** | 1080P |
| 时长 | 提示词目标秒（脚本解析失败时兜底 **12**） | 5s |
| 参考 | 环境图 + 强哥三视图 + 口播音频（缺一不准开） | 禁止只备正面一张 |
| 真芯片 | OUD `[@image:]`×4 + `[@audio:]`×1；`image_list`/`audio_list` | 提示词正文只用 `[图片N]`，不贴 [H] 表格 |

**纯请求 body 脚本默认（`lovart-wan-upload-and-body.cjs`）：**

```text
--ratio 9:16
--resolution 480P
--duration <从提示词解析，否则 12>
generator_name: wan/wan-3-0
```

**余额门闩：** ① 余额 ≥ `时长秒×4+2`（例 12s→≥50）② 本条预估价 `<` 当前余额（出完后仍 >0）。选号：`lovart-cli-pick-recharge.sh canvas <秒>`。不看「本日是否已画布」。

计费 create **只许** `lovart-wan-create-once.cjs` 发一次；禁止二次 create / 同线程二次 Wan。

---

## 3. 出图（封面 / 线稿 / 静图）— 一律免费号

| 用途 | 模型 | CLI 参数 | 规格 |
|---|---|---|---|
| 封面海报 | GPT Image 2.5 **Flare High** | `--include-tools generate_image_gpt_image_2_5_flare_high` + prefer-models IMAGE + `--mode fast` | **3:4**，约 **1536×2048** |
| 站位线稿 | 同上 Flare High | 同上 + `--mode fast` | 有环境图：跟原图画幅不裁切；无环境图：提示词写的 **1K 横版 16:9** |
| 画中画静图 | 同上 Flare High | 同上 | 照规划 |
| 禁用 | Flare Low、Nano Banana、回退 GPT Image 2 | — | 用户点名才改 |

充值号**只出视频**；出图用免费号（充值号开 unlimited 出图仍扣分）。

封面 chat 导语要点：竖版约 3:4 抖音封面、含大标题中文、直接调用 Flare High、不要只回文字。线稿导语：只调用 Flare High 直接出 1 张图，不要规划/分镜/草图/视频。

---

## 4. 上传上限（Seedance 2.5）

- 图片 ≤30；视频 ≤10 条且合计 ≤30s；音频 ≤10 条且合计 ≤30s  
- 效果最好：主体图 1–8、主体音视频 1–5；单段参考 5–10s  

---

## 5. 参考价（实测量级，非门闩）

- Seedance Mini ~5s ≈ 30 积分  
- Seedance 2.5 正式版 ~5s ≈ 50 积分  
- 画布 Wan 门闩公式见上（时长×4+2）  

---

## 6. 仓库里对应文件

| 文件 | 作用 |
|---|---|
| `docs/SUBMIT-DEFAULTS.md` | 本页（默认参数一览） |
| `docs/skills/lovart-seedance.md` | CLI / 出图技能摘录（去本机路径敏感句） |
| `docs/skills/lovart-canvas-wan-master.md` | 画布 Wan 技能摘录 |
| `bin/lovart-wan-upload-and-body.cjs` | Wan body：`ratio`/`resolution`/`duration`/`generator_name` 默认 |
| `bin/lovart-cli-pick-recharge.sh` | CLI / canvas 选号门闩 |
| `examples/` | 账号占位；真 ak/sk 勿提交 |

技能全文以发布 bot 模板内嵌为准；本仓保证**发送默认参数**与作业脚本一致，方便第三方照抄。
