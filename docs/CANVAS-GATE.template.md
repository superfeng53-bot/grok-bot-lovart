# CANVAS-GATE — 每条母片一份，复制到 /workspace/lovart-upload-staging/<短名>/CANVAS-GATE.md
# 缺字段 = 主代理不准派下一轮。值填路径或原文，禁止只写「OK」。

## 0 预检
- skill_loaded_at:
- profile:          # 如 Profile 24
- expect_email:
- email_ok:         # 页面邮箱截图路径或「已核=<邮箱>」
- staging_ready:    # img1+img2+img3+img4+audio1+prompt 齐
- anti_cookie_ok:   # lovart-anti-cookie-ensure.sh 输出含 OK
- flock_held:       # yes/no
- chrome_launch:    # 必须=canvas-chrome（lovart-canvas-chrome.sh）

## 1 规格复核（未填不准派 round=2）
- model:            # Wan 3.0
- spec_bar_text:    # 设置条整行原文，须含「参考图/视频」+比例+时长+480P
- spec_recheck_shot:# 复核截图路径
- abort:            # 若点进首尾帧填「首尾帧」并 STOP

## 2a 四图（未填不准派 2b）
- imgs_ok:          # 四图缩略图截图路径

## 2b 音频（未填不准派 round=3）
- audio_scroll_checked: # 必须先填：已点参考条向右箭头（或拖轴）后的截图路径；未填不准写 audio_slot=空/STOP，不准改走本地/素材重挂
- audio_slot:       # 如 0:05 + 截图路径；判「未挂」只能在 audio_scroll_checked 已填且右滑后仍无波形
- audio_via:        # 素材|本地|unknown-already-present

## 3 芯片（未填不准派 round=4）
- chips_ok:         # 环境+三视图脸+音频均为真芯片；须能辨认正面、斜面、侧面；缺正面/斜面/侧面任一或有纯文字残留则停；五枚同屏放不下须滚动核完再写

## 4 发送前三确认（三项都有证据才准派「点发送」）
- confirm_spec:     # 再读设置条原文（须仍是参考图/视频…）
- confirm_chips:    # 指向 chips_ok 或新截图
- confirm_balance:  # 余额数字 + 预估数字（余额≥时长秒×4+2 且预估<余额；特殊号另注用户放行；无日配额）
- send_clicked_at:  # 只点一次后填写；生成中禁止再点

## 5 下载与 Mac（与 lovart-seedance 同规程）
- download_path:    # box 04-生成/ 下 mp4
- mac_path:         # 外接硬盘 …/母片/
- mac_md5:          # 与 box 源一致
- project_card:     # 已写「母片已出…等用户说剪」
