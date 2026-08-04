---
name: sleeptracker-ops
description: Sleep Tracker 项目的运维与发布流程。在本项目里跑任何 Python 脚本、重启服务、验证接口、改前端后让改动生效时使用。涵盖正确的 Python 解释器路径（自带 venv 已损坏）、launchd 常驻服务重载、沙箱内验证服务的正确姿势（curl 会 502）、Service Worker 缓存版本号同步递增、局域网与 Tailscale 访问地址。触发词：跑脚本、重启服务、改动不生效、刷新没变、服务挂了、验证接口、发布、部署。
agent_created: true
---

# Sleep Tracker 运维与发布

这个项目有若干**反直觉的环境陷阱**，凭常识操作几乎必踩。本文件是绕过它们的唯一正确路径。

## 何时激活

- 要在本项目跑任何 Python 脚本（同步、导入、测试、一次性查询）
- 改了后端代码，需要让改动生效
- 改了前端 JS/CSS/HTML，用户反馈"刷新了没变化"
- 需要验证服务是否在跑、接口是否正常
- 用户问怎么在手机/外网访问

---

## 铁律一：绝不使用项目自带的 venv

项目根目录的 `venv/` **已损坏**——它的 shebang 指向迁移前的旧路径 `/Users/barbara/Documents/vscode/sleeptracking/`，而项目实际在 `developing/` 子目录下。用它会报找不到解释器。

```bash
# ✗ 错误 —— 永远不要用
./venv/bin/python3 xxx.py

# ✓ 正确 —— 唯一可用的解释器
/Users/barbara/.workbuddy/binaries/python/envs/sleeptracking/bin/python3 xxx.py
```

该环境已装：`flask` / `requests` / `libsql-experimental` / `python-dotenv` / `waitress`。缺包时往这个 env 里装，不要装到系统或别处。

---

## 铁律二：让代码改动生效 = kickstart，不是 load

服务由 launchd 常驻管理：

| 项 | 值 |
|---|---|
| Label | `com.sleeptracking.server` |
| plist | `~/Library/LaunchAgents/com.sleeptracking.server.plist` |
| 端口 | `61023` |
| 环境 | `HEADLESS=1 PORT=61023`（走 waitress） |
| 日志 | `sleeptracker_launchd.log` |
| 策略 | `RunAtLoad` + `KeepAlive`，PID 动态分配 |

**重载服务（首选）：**

```bash
launchctl kickstart -k "gui/$(id -u)/com.sleeptracking.server"
```

实测从工具 shell 执行 exit=0，会先杀旧实例、再用新代码 + 新 `.env` 拉起。干净、一步到位。

**后备方案：** `kill -9 <主PID>`，KeepAlive 会自动用新 PID 重新拉起并 import 新代码。但旧进程有时在沙箱里 `kill` 报 `illegal pid`（进程属于用户 GUI 会话），此时仍应回到 kickstart。

**永远不要尝试：**

```bash
# ✗ 从工具 shell 执行必然失败：Load failed: 5: Input/output error
launchctl load ~/Library/LaunchAgents/com.sleeptracking.server.plist
```

原因：工具进程不在用户 GUI 登录会话中，launchd 的 `gui` 域锚定不了（plist 本身 `plutil -lint` 是合法的，不要浪费时间去查 plist 语法）。**首次启用或彻底重新 load 必须由用户在自己的 Terminal 里执行**：

```bash
lsof -ti :61023 | xargs -r kill 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.sleeptracking.server.plist
```

停止常驻：`launchctl unload ~/Library/LaunchAgents/com.sleeptracking.server.plist`（plist 保留，可重复 load）。

**前台手动启动**（调试用，不影响 launchd）：

```bash
HEADLESS=1 PORT=61023 /Users/barbara/.workbuddy/binaries/python/envs/sleeptracking/bin/python3 app.py
```

---

## 铁律三：验证服务不能用 curl

沙箱里 `curl localhost` 会走代理并返回 **502**，这是代理的锅，不代表服务挂了。

```bash
# ✗ 假阴性，看到 502 会误判服务已死
curl http://127.0.0.1:61023/api/stats
```

**正确姿势 —— Python 原生 socket 直连：**

```python
import socket
s = socket.create_connection(('127.0.0.1', 61023), timeout=15)
s.sendall(b'GET /api/stats HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
buf = b''
while True:
    chunk = s.recv(65536)
    if not chunk:
        break
    buf += chunk
print(buf.decode('utf-8', 'replace')[:2000])
```

**注意：** 某些沙箱状态下，到宿主机 61023 的 TCP 本身会被网络隔离，socket 也连不上。此时用 `lsof -i :61023` 确认进程处于 LISTEN 即可判定服务正常，用户侧 PWA / Tailscale 访问的就是新版本。

**不依赖网络的验证方式** —— 用 Flask test_client 直接在进程内打接口，绕开所有网络层：

```python
from app import app
with app.test_client() as c:
    r = c.get('/api/stats')
    print(r.status_code, r.get_json())
```

---

## 铁律四：改前端后"刷新没变"，第一嫌疑永远是 Service Worker

这是 PWA，用户把它**当桌面 App 装着用**。绝不能为了修缓存去掉 PWA / Service Worker。

缓存链路有三层：
1. `static/sw.js` —— Service Worker，**network-first** 策略（网络可用取最新，离线回退缓存）
2. `templates/index.html` —— 所有 `<script>` 带 `?v=N` 版本号
3. `app.py` —— `SEND_FILE_MAX_AGE_DEFAULT=0` + `TEMPLATES_AUTO_RELOAD=True`

**改了前端资源后的必做动作（两处版本号必须同步递增）：**

```
static/sw.js        →  const CACHE_NAME = 'sleep-tracker-vN'   （N+1）
templates/index.html →  所有 8 个 <script src="/static/xxx.js?v=N">  （N+1，一起改）
```

当前版本：`sleep-tracker-v3` / `?v=3`。八个脚本是 form / meal / period / calendar / timeline / reports / healthOverview / app。**漏改任何一个，那个文件就会继续吃旧缓存。**

自动更新机制已经做好，用户无需手动清缓存：
- `sw.js` 的 `install` 里 `skipWaiting()`，`activate` 里 `clients.claim()` + 对所有打开的 window 调 `client.navigate(url)` 强制重载
- `app.js` 的 `_registerServiceWorker()` 注册后 `reg.update()`（立即一次 + 每分钟一次），监听 `controllerchange` → `location.reload()`（带 flag 防爆栈）

**告诉用户的操作：** 关掉 PWA 再点桌面图标重开，即自动更新。**不需要** DevTools 清缓存，**不需要** 重启 launchd。

---

## 访问地址

| 场景 | 地址 |
|---|---|
| 本机 | `http://127.0.0.1:61023` |
| 家里（同一 Wi-Fi） | `http://BarbaradeMac-mini.local:61023` |
| 外出 / 手机流量 / 外网设备 | `http://barbaramac-mini:61023` |

服务监听 `0.0.0.0:61023`。Tailscale magic DNS 主机名 `barbaramac-mini`，IPv4 `100.78.39.83`。

**优先用 magic DNS 名而非 IP**（IP 极少变但理论上会变）。前端全用相对路径、`static/` 无硬编码 host/端口，换地址零改动。

前提：Mac mini 开机且不睡眠；手机需保持 Tailscale App 已连接。

---

## 数据库要点

- 主力是 **Turso 云**（`database.py` 读 `TURSO_URL` / `TURSO_AUTH_TOKEN`），本地 `sleep_tracker.db` 只是回退，**不是主力，里面可能是空的**
- 连接策略：线程本地缓存 + 空闲 `SELECT 1` 健康检查 + 断线自动重建。各调用点的 `conn.close()` 在复用模式下是 no-op
- Turso 偶有 **502 瞬时错误**（`upstream forward failed`），同步线程会自动恢复，属正常抖动，不是代码问题
- libsql 的 `execute()` 参数必须是 `tuple`——`_TursoConnectionWrapper` 已统一把 `list`/`dict` 转 tuple，写新代码时留意
- `_TursoCursorWrapper` 能力不全：**无 `.description`**（取列名用 `row.keys()`）、**无 `rollback`**（用 `INSERT OR REPLACE` 规避）

---

## 三层同步机制

页面开着、服务在跑、服务全关，三种情况分别由不同层兜底：

1. 前端 `static/app.js` 每 **5 分钟**轮询 `/api/whoop/sync?days=2`（页面开着时）
2. `app.py` 守护线程 `_background_sync_loop(30)` 每 **30 分钟**同步（服务运行、页面关着）
3. 每日自动化任务 `sync_whoop.py 30`（服务完全关闭时兜底）

`/api/whoop/sync` 调 `sync_all_whoop` = 睡眠 + 每日指标（恢复 / Strain / HR）+ 训练，三者全同步。

⚠️ Whoop **不含步数和 GPS**，步数只能来自苹果健康。

---

## 常见故障速查

| 症状 | 真因 | 处置 |
|---|---|---|
| 脚本报找不到解释器 | 用了坏掉的 `venv/` | 换成 workbuddy 的 sleeptracking env |
| `curl` 返回 502 | 沙箱代理 | 用 socket 直连或 test_client |
| `launchctl load` 报 I/O error | 工具 shell 不在 GUI 域 | 改用 `kickstart -k` |
| 改了 JS 页面没变 | SW 缓存 + 版本号没递增 | 两处版本号 +1，让用户重开 PWA |
| 改了后端没生效 | 进程还跑着旧代码 | `kickstart -k` |
| 接口慢到 10s+ | Turso 云偏慢，waitress 队列堆积 | 等待或重试，数据本身能返回 |
| `/api/healthkit/ingest` 401 | 缺 `HEALTHKIT_API_KEY` | URL 加 `?key=` 或 header `X-Api-Key` |

---

## 安全提醒

所有 REST API **零认证** + 监听 `0.0.0.0`，Tailscale / 局域网内任意设备可读写删全部健康数据。仅 `/api/healthkit/ingest` 有共享密钥保护。改动网络暴露面时要意识到这一点。

## 备份

`sleep_records` 曾被整表清空过一次（约 7 月底），从 Whoop 只回填到 17 条。`/api/export` 可导出全部 7 张表为 JSON，`/api/import` 幂等回灌。**做有风险的数据操作前先导出。**
