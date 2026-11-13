# 静图默认

本页是公开仓里的静图提交说明。CLI 视频仍按 [`HANDOFF.md`](../../HANDOFF.md) 提交 Seedance 2.5（`generate_video_seedance_v2_5`）。画布仍是 Wan 3.0。

封面、线稿、画中画静图默认 **Seedream 5.5**，工具名 `generate_image_seedream_v5_5`。出图用免费号；充值号只出视频。

```bash
--prefer-models '{"IMAGE":["generate_image_seedream_v5_5"]}' \
--include-tools generate_image_seedream_v5_5 \
--mode fast
```

`--include-tools` 是强引导。被请求的工具拒单后，Agent 仍可能改用别的工具。跑完先读结果里的 `failures` 和 `warning`。`failures` 非空时，按被拒的工具和原因回报。实际调用的工具以结果记录为准；请求参数里的工具名只表示提交时的引导。带原图的编辑未在本仓实测，不列入已支持能力。

本仓没有 `cover_oneshot.py`。导入方若自备该脚本，把 `COVER_IMAGE_MODEL` 设为 `generate_image_seedream_v5_5`。已有的生成日志保持原样，不回写成这个默认。
