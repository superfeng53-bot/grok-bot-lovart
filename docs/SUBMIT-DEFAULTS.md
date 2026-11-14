# 提交默认里的出图

CLI Seedance 2.5（`generate_video_seedance_v2_5`）与画布 Wan 3.0 的门闩、分辨率和脚本以 [`HANDOFF.md`](../HANDOFF.md) 为准。本页只写出图默认。

## 出图（2026-11-13）

封面、线稿、画中画静图等静图默认模型是 **Seedream 5.5**，工具名 `generate_image_seedream_v5_5`。出图用免费号；充值号只出视频。

```bash
--prefer-models '{"IMAGE":["generate_image_seedream_v5_5"]}' \
--include-tools generate_image_seedream_v5_5 \
--mode fast
```

`--include-tools` 是强引导。被请求的工具拒单后，Agent 仍可能改用别的工具。跑完先读结果里的 `failures` 和 `warning`。`failures` 非空时，按被拒的工具和原因回报。实际调用的工具以结果记录为准；请求参数里的工具名只表示提交时的引导。带原图的编辑未在本仓实测，不列入已支持能力。

机器可读副本：[`examples/image-default.example.json`](../examples/image-default.example.json)。本文件不发起登录、生成或计费。
