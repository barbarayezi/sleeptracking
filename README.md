# Sleep Tracker

个人睡眠追踪应用。将身体状况转化为结构化数据，通过量化分析打破"认知突破→应激循环→身体症状"的正反馈环路。

## 功能

- 📝 记录每日睡眠（入睡/起床时间、质量、分类、睡眠问题）— 日期由起床时间自动推导
- 🌙 支持多种记录类型：夜间睡眠、午睡、分段睡眠
- ⚖️ 记录健康指标：体重、喝水杯数、步数（选填）
- 🍽️ 记录饮食：餐次、内容、健康度、过敏反应（选填）
- 📓 日有所感：记录梦境、身体状态、心情等
- 📊 自动生成周报/月报（睡眠时长、趋势、模式识别）
- 🎨 时间线按起床日分组展示（夜间/午睡/分段 不同样式区分）

## 技术栈

- **后端：** Python Flask
- **数据库：** Turso（云端 SQLite）/ 本地 SQLite 回退
- **前端：** 原生 HTML + CSS + JS

## 快速开始

```bash
# 安装依赖
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 Turso 凭据（可选，不填则使用本地 SQLite）

# 启动
python app.py
```

打开 http://localhost:5001（端口冲突时尝试 5002）

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/records` | 获取记录列表 |
| POST | `/api/records` | 创建新记录 |
| PUT | `/api/records/<id>` | 更新记录 |
| DELETE | `/api/records/<id>` | 删除记录 |
| GET | `/api/meals` | 获取饮食记录列表 |
| POST | `/api/meals` | 创建饮食记录 |
| PUT | `/api/meals/<id>` | 更新饮食记录 |
| DELETE | `/api/meals/<id>` | 删除饮食记录 |
| GET | `/api/report` | 生成分析报告 |
| GET | `/api/stats` | 快速统计 |

## 项目结构

```
sleep_traking/
├── app.py              # Flask 应用入口
├── database.py         # 数据库连接管理（自动迁移到 v4）
├── models.py           # 睡眠记录数据访问层
├── meal_models.py      # 饮食记录数据访问层
├── reports.py          # 报告生成模块
├── requirements.txt    # Python 依赖
├── .env.example        # 环境变量模板
├── templates/
│   └── index.html      # 前端单页
├── static/
│   ├── app.js          # 主逻辑
│   ├── form.js         # 表单/多记录/日期推导
│   ├── timeline.js     # 时间线可视化
│   ├── reports.js      # 报告面板
│   ├── meal.js         # 饮食记录面板
│   └── style.css       # 样式
└── reports/            # 分析报告存档（Markdown，含深度对话补充）
```