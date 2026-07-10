# CLAUDE.md

Sleep Tracker — Flask + Turso (cloud SQLite) 睡眠追踪应用。

## 架构

```
sleep_traking/
├── app.py              # Flask 入口，REST API 路由
├── database.py         # 数据库连接管理（Turso 优先，本地 SQLite 回退）
├── models.py           # CRUD 数据访问层
├── reports.py          # 报告生成（结构化数据 + CLI 接口）
├── templates/index.html # 前端单页
├── static/
│   ├── app.js          # 主前端逻辑
│   ├── form.js         # 表单/多记录展示
│   ├── timeline.js     # 时间线视图
│   ├── reports.js      # 报告页面
│   └── style.css       # 样式
├── reports/            # 分析报告存档（Markdown）
└── sleep_tracker.db    # 本地回退数据库（已 gitignore）
```

## 数据库

- **生产环境：Turso**（`libsql://sleep-tracker-barbarayezi.aws-ap-northeast-1.turso.io`），凭据在 `.env`
- **本地回退：** `sleep_tracker.db`（SQLite），`.env` 中无 Turso 配置时自动使用
- Schema v4：`sleep_records` 表，支持 `record_type`（night/nap/segment）+ 健康指标（weight / water_cups / steps）
- 查询 Turso 用 `libsql` 库直接连接

## 运行方式

```bash
pip install -r requirements.txt
python app.py    # 启动在 localhost:5001（或 5002，端口冲突时自动切换）
```

## API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 前端页面 |
| GET | `/api/records` | 列表（支持 `?date=`, `?from=`, `?to=`） |
| GET | `/api/records/<id>` | 单条详情 |
| POST | `/api/records` | 创建记录 |
| PUT | `/api/records/<id>` | 更新记录 |
| DELETE | `/api/records/<id>` | 删除记录 |
| GET | `/api/report` | 生成报告（`?period=weekly`） |
| GET | `/api/stats` | 快速统计 |

## 记录字段

- `record_date` — 日期，前端由 `wake_time` 自动推导（一个日期可有多个记录）
- `record_type` — night / nap / segment
- `sleep_time` / `wake_time` — ISO 格式（`YYYY-MM-DDTHH:MM`）
- `classification` — early / late
- `sleep_quality` — good / average / poor
- `sleep_problems` — JSON 数组（insomnia, dreams, sweats, waking, early_waking）
- `dream_journal` — 纯文本（日有所感：记录梦境、身体状况、心情等）
- `weight` — 体重（kg，选填，仅夜间睡眠）
- `water_cups` — 喝水杯数（选填，仅夜间睡眠，1 杯 ≈ 250ml）
- `steps` — 步数（选填，仅夜间睡眠）

## 前端设计约定

- **日期归组逻辑：** 睡眠记录按"醒来日期"归组。例如 7月8日 23:00 → 7月9日 07:00 的睡眠，显示在 7月9日 下。
- **表单日期推导：** 表单不再显示日期选择器，`record_date` 由 `wake_time` 的日期部分自动提取。默认入睡时间为所选日期前一天 23:00，醒来时间为所选日期 07:00。
- **时间线：** `timeline.js` 按 `wake_time` 提取日期进行分组，而非 `record_date`。

## 分析报告存档

每次分析产出的报告保存到 `reports/YYYY-MM-DD-analysis.md`。

报告格式：数据概览 + 趋势分析 + 身体/心理关联 + 建议。支持深度对话后追加补充章节（如 2026-07-08 报告包含习得性无助、阿斯伯格神经类型、应激循环等深度分析）。

## 项目目的

这个应用不仅是睡眠记录工具。其根本动机是：

**突破性认知推导 → 推无可推 → 抑郁焦虑 → 免疫系统过度激活（"过敏"）→ 睡眠结构破坏、早醒、体重上升 → 将身体症状转化为结构化数据 → 量化分析 → 打破应激循环。**

把身体从"正在发生在我身上的事"变成"一个我可以分析的对象"——这是主体性的重新拿回。