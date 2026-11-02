# Wan 连发双扣复盘（2026-10-31）

## 现象
L24 余额 100→3。询价单条 12s=48，实际扣了约两单。

## 根因
`/tmp/yz20-03-l24-sign-and-create.cjs`：
1. 第一次 `POST /v1/generator/tasks` **已成功**，响应 `data.generator_task_id`。
2. 脚本只读 `task_id` / `taskId` / `id`，得到 `null`，误判失败。
3. 立刻走「media-only」**CREATE2** 再 POST → 第二条 `98e4896b…` 再扣约 49。
4. cancel 参数错误（422），没停住。

## 脚本硬闸（`lovart-wan-create-once.cjs`）
| 闸 | 行为 | exit |
|----|------|------|
| 解析 | 优先 `generator_task_id`；有 id 即成功，禁止二发 | — |
| 进程内 | `postedOnce`：同进程第二次 POST `/tasks` 直接拒 | 11 |
| flock | 同 `project_id` 文件锁 `wx` | 5 |
| ledger intent | 2h 内同 project+intent 已成功 → 拒 | 6 |
| ledger cid | 同 cid 已成功 → 拒 | 8 |
| ledger fingerprint | 同 body 指纹（规格+prompt+refs）→ 拒 CREATE2 变体 | 9 |
| project busy | 同 project 有未 closed 成功单 → 拒 | 7 |
| ALERT 文件 | `/tmp/lovart-wan-double-charge-ALERT.json` 未清 → 拒一切 create | 10 |
| 余额骤降 | create 后余额掉 > max_price+2 → 写 ALERT，exit 12 | 12 |
| 真失败 | 无 id → 写 ledger、**不重试** | 4 |

配套：`lovart-wan-parse-task-id.cjs`、`lovart-wan-ledger-close.cjs`。旧 `sign-and-create` 入口 `exit 99`。

## 出片策略
裸 API `reference_image` **不能**代替画布 `@芯片` 锁脸；锁脸须 **三视图全套**（正面+斜面+侧面）都转成真芯片，只锁正面不算。正式母片走 CDP 挂图+转芯片；API 直发仅试验且必须走 create-once。
