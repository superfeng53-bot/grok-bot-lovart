# 可原样转发模板

脚本只替换 `{{占位}}`。积分门闩仍是余额 ≥ 时长秒×4+2，且现场报价 < 当前余额。模板里不写另一套单价。

## item
【出片进度】账号 {{account}}｜Profile {{profile}}｜邮箱 {{email}}｜余额 {{balance_before}}→{{balance_after}}｜报价 {{price}}｜generator_task_id {{generator_task_id}}｜box {{box_path}}｜size {{size}}｜md5 {{md5}}｜片长 {{mp4_duration}}｜{{mac_status}}｜{{note}}

## batch
【出片进度·汇总】{{mode}}｜计划 {{item_count}} 条｜已跑 {{done_count}}｜{{stop_reason}}｜不自动换号｜不自动剪辑｜等用户说「剪」。
