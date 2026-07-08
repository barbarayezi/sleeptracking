# Sleep Tracker

个人睡眠追踪应用，记录每日睡眠数据并生成分析报告。

## 功能

- 📝 记录每日睡眠（入睡/起床时间、质量、分类、睡眠问题）
- 🌙 支持多种记录类型：夜间睡眠、午睡、分段睡眠
- 📊 自动生成周报/月报（睡眠时长、趋势、模式识别）
- 🎨 时间线可视化展示
- 💬 梦境日记记录

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
python -m sleep_traking.app
```

打开 http://localhost:5001

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/records` | 获取记录列表 |
| POST | `/api/records` | 创建新记录 |
| PUT | `/api/records/<id>` | 更新记录 |
| DELETE | `/api/records/<id>` | 删除记录 |
| GET | `/api/report` | 生成分析报告 |
| GET | `/api/stats` | 快速统计 |

## 项目结构

```
sleep_traking/
├── app.py              # Flask 应用入口
├── database.py         # 数据库连接管理
├── models.py           # 数据访问层
├── reports.py          # 报告生成模块
├── templates/          # 前端模板
├── static/             # 静态资源
└── reports/            # 分析报告存档
```