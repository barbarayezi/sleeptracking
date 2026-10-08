---
name: sleeptracker-extend-enum-field
description: 给 Sleep Tracker 里被 CHECK 约束写死的下拉 / 枚举字段（药物类别、训练类型、经期流量、饮食地点等）增加新取值，或把它改造成用户可在页面上自助增删的系统。涉及 Turso 迁移、约束重建、前后端联动。触发词：加一个新的类别/类型/选项、下拉里没有我要的选项、想自己添加选项、CHECK constraint failed、枚举字段扩展。
agent_created: true
---

# 扩展 Sleep Tracker 的枚举 / 下拉字段

本项目多处字段被 SQLite `CHECK(...)` 写死（`medication_records.category`、`workout_checkins.workout_type`、`meal_records.dining_location` 等）。用户随时会要求加新取值。本 skill 是唯一正确路径。

## 何时激活

- 用户说"想加一个 XX 类别 / 类型 / 选项"（例：感冒药、新的舞蹈课类型）
- 写入报 `CHECK constraint failed` 或 Hrana `SQLITE_CONSTRAINT`
- 要把某个硬编码下拉改成用户可自助维护

---

## 铁律一：不要只改 Python 的集合常量

`app.py` 里形如 `_MED_CATEGORIES = {...}` 的白名单只是**校验层**；真正的拦路虎是数据库里的 `CHECK`。只改 Python 集合 → 校验通过 → INSERT 被 DB 拒绝 → 500。

必须三层一起改：**DB 约束 → 校验逻辑 → 前端下拉**。

---

## 铁律二：CHECK 约束只能靠重建表去掉

SQLite 不支持 `ALTER COLUMN ... DROP CHECK`。唯一办法：

```sql
DROP TABLE IF EXISTS xxx_new;               -- 先清残表，保证幂等
CREATE TABLE xxx_new ( ... 无该 CHECK ... );
INSERT INTO xxx_new SELECT <全部列> FROM xxx;
DROP TABLE xxx;
ALTER TABLE xxx_new RENAME TO xxx;
-- 索引重建
```

**重建前必做：** 先把该表导成 JSON 备份到 `/tmp`，重建后核对行数一致。

```python
import json, medication_models as mm   # 换成对应 models
json.dump(mm.get_all_...(), open('/tmp/backup.json','w'), ensure_ascii=False, default=str)
```

---

## 铁律三：不要相信 schema 版本号，必须查实际 schema

2026-10-08 v18 迁移曾**静默失败**：版本号被写成 18，但 `medication_records` 上 `CHECK(category ...)` 仍在（Turso 读 `sqlite_master` 偶尔返回空，检测逻辑误判为"无需重建"）。表象是写新值报 500，查 `_meta` 却显示已迁移。

检测一律写"保守派" —— **无法明确确认约束已消失就重建**：

```python
needs_rebuild = not ('CHECK(' + col + ')' not in sql.replace('\n',' ')
                     and 'CREATE TABLE' in sql)
```

重建后还要**后置校验**：重读 `sqlite_master`，约束还在就 `raise RuntimeError`，绝不静默通过。

---

## 标准改动清单（以"用药类别" v18 为模板）

1. **`database.py`**
   - 新版本号迁移 `_migrate_vN`（当前最新 v18，查 `SELECT value FROM _meta WHERE key='schema_version'`）
   - 在 `_migrate()` 尾部登记 `if version < N: _migrate_vN(conn)`
   - `init_db()` 里的 `CREATE TABLE` 同步改成最终形态（新装走这条路）
   - 若要用户自助维护：仿 `meal_options` / `medication_categories` 建选项表 + 种子常量 + `_seed_xxx()`（`INSERT OR IGNORE` 幂等）
2. **`xxx_models.py`**：CRUD 函数（列表 / 新增 / 删除）。删除要挡两类：内置（`is_system=1`）和**已被记录引用**的（COUNT > 0 就拒绝）
3. **`app.py`**：REST 路由 `GET|POST /api/xxx-options`、`DELETE /api/xxx-options/<id>`；校验函数改为查库（带 try/except 兜底成旧集合）；把新表加进 `/api/export`、`/api/import` 的 TABLES 清单
4. **前端**：下拉**由 JS 动态填充**（`/api/xxx-options`），不要在 HTML 里写死 `<option>`；列表标签 / 配色 / 汇总 chips 一律取这份数据，配一份 `FALLBACK_*` 常量防网络异常
5. **版本号**：动过 `*.js` / `style.css` 后必须同步递增 `templates/index.html` 的 `?v=N` **和** `static/sw.js` 的 `CACHE_NAME`（详见 `sleeptracker-ops` skill 铁律四）
6. **`.workbuddy/memory/`**：记一笔（新版本号 + 踩坑教训）

---

## 验证清单（缺一不可）

启动服务后按顺序打：

1. `GET /api/xxx-options` → 返回含新取值
2. `POST` 一条**新取值**的记录 → 期望 201（这一步最容易被遗留 CHECK 打脸）
3. `POST /api/xxx-options` 新增自定义项 → 用它再建一条记录 → 期望 201
4. `DELETE` 该自定义项 → 应被拒（有记录引用）；清掉记录后再删 → 204
5. 汇总接口返回的分桶包含新 key
6. 最后清掉所有测试记录，别把脏数据留给用户

调试脚本用 `urllib.request.build_opener(urllib.request.ProxyHandler({}))` 打 `127.0.0.1:61023`（**curl 会走代理 502**）。

重启服务时加 `-u`（`python3 -u app.py`）：管道下 stdout 块缓冲，启动 print 会被 Flask 的 stderr 报错"插队"，容易误判迁移没跑。

---

## 参考实现

- 用户自助选项：`database.py` 的 `_migrate_v15`（`meal_options`）、`_migrate_v18`（`medication_categories`）
- 重建表去 CHECK：`database.py` 的 `_migrate_v14`（`daily_reports`）、`_migrate_v18`
- 前端动态渲染：`static/medication.js` 的 `_ensureCategories()` / `_renderCategorySelect()`
