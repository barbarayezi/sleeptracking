#!/bin/bash
# safe_pull.sh — 沙箱 / 嵌套仓库环境下安全拉取远程最新代码
#
# 解决的问题:
#   1. 上层父仓库的 .git 会"遮蔽"嵌套仓库, 导致 git 误用错误仓库
#   2. 沙箱中 bash 与 git 子进程文件系统视图不一致, refs 跨进程可能不可见
#   3. git stash 在本沙箱中会直接杀掉 shell, 不可用
#
# 策略:
#   - 所有 git 操作尽量在一致视图下完成
#   - 优先直接 `git merge --ff-only`: 若本地改动与远程不冲突, merge 成功并自动保留
#     本地改动, 完全不依赖"checkout 后文件可见性", 因此在沙箱里也可靠
#   - 仅当 merge 受阻(本地改动与远程改动冲突)时, 才用 补丁 方式暂存并重新应用
#     (该回退路径在普通机器上可靠; 个别沙箱中若视图抖动导致重应用失败, 补丁会保留
#      供手动 `git apply --reject`)
#   - 若 refs 缺失, 从 reflog / FETCH_HEAD 自动重建, 防止 git 回退到父仓库
#
# 用法:
#   ./safe_pull.sh                 # 在当前仓库(脚本所在目录)执行安全拉取
#   ./safe_pull.sh /path/to/repo  # 指定仓库路径
set -u

# 1. 确定仓库路径
if [ $# -ge 1 ]; then
  REPO="$1"
else
  REPO="$(cd "$(dirname "$0")" && pwd)"
fi
cd "$REPO" 2>/dev/null || { echo "错误: 无法进入仓库目录: $REPO" >&2; exit 1; }
if [ ! -d .git ]; then
  echo "错误: $REPO 不是 git 仓库 (.git 不存在)" >&2; exit 1
fi
echo "==> 仓库: $REPO"

# 2. 读取当前分支 / 上游
HEAD_REF="$(cat .git/HEAD 2>/dev/null)"
if [[ "$HEAD_REF" == ref:\ refs/heads/* ]]; then
  BRANCH="${HEAD_REF#ref: refs/heads/}"
else
  echo "错误: 无法从 .git/HEAD 识别分支 ($HEAD_REF)" >&2; exit 1
fi
REMOTE=origin
UPSTREAM="$REMOTE/$BRANCH"
echo "==> 分支: $BRANCH  上游: $UPSTREAM"

# 3. 确保 refs 结构存在, 避免 git 回退到父仓库
mkdir -p .git/refs/heads ".git/refs/remotes/$REMOTE"

if [ ! -f ".git/refs/heads/$BRANCH" ]; then
  SHA=""
  [ -f .git/logs/HEAD ] && SHA="$(tail -n1 .git/logs/HEAD | awk '{print $2}')"
  if [ -n "$SHA" ]; then
    echo "==> 重建 .git/refs/heads/$BRANCH -> $SHA"
    printf '%s\n' "$SHA" > ".git/refs/heads/$BRANCH"
  fi
fi

if [ ! -f ".git/refs/remotes/$UPSTREAM" ]; then
  CAND=""
  LOGF=".git/logs/refs/remotes/$UPSTREAM"
  [ -f "$LOGF" ] && CAND="$(tail -n1 "$LOGF" | awk '{print $2}')"
  [ -z "$CAND" ] && [ -f .git/FETCH_HEAD ] && CAND="$(head -n1 .git/FETCH_HEAD | awk '{print $1}')"
  if [ -n "$CAND" ]; then
    echo "==> 重建 .git/refs/remotes/$UPSTREAM -> $CAND"
    printf '%s\n' "$CAND" > ".git/refs/remotes/$UPSTREAM"
  fi
fi

# 4. 同进程内 fetch
echo "==> git fetch $REMOTE"
git fetch "$REMOTE" 2>&1
if ! git cat-file -t "$UPSTREAM" >/dev/null 2>&1; then
  echo "错误: fetch 后仍未看到上游对象 $UPSTREAM (疑似沙箱进程视图问题)" >&2
  exit 1
fi

# 5. 优先直接 fast-forward 合并
#    若本地改动与远程不冲突, merge 成功并自动保留本地改动 (沙箱里也可靠)
echo "==> git merge --ff-only $UPSTREAM"
if git merge --ff-only "$UPSTREAM" 2>&1; then
  echo "==> 合并完成 (无冲突的本地改动已自动保留)"
else
  # 6. 合并受阻: 本地改动与远程改动冲突, 用补丁方式暂存并重新应用
  echo "==> 合并受阻, 采用补丁方式保留本地改动"
  PATCH="$REPO/.git/safe_pull.local.patch"
  git diff HEAD > "$PATCH" 2>/dev/null
  if [ -s "$PATCH" ]; then
    git checkout HEAD -- . 2>&1
    git merge --ff-only "$UPSTREAM" 2>&1
    APPLIED=0
    for i in 1 2 3; do
      if git apply --3way "$PATCH" 2>/dev/null || git apply "$PATCH" 2>/dev/null; then
        APPLIED=1; break
      fi
    done
    if [ "$APPLIED" = "0" ] && command -v python >/dev/null 2>&1; then
      if python - "$PATCH" <<'PYEOF' 2>/dev/null
import sys, re
def main():
    BS = chr(92)
    patch = sys.argv[1]
    text = open(patch, encoding='utf-8').read()
    lines = text.split('\n')
    if lines and lines[-1] == '': lines.pop()
    i = 0; n = len(lines); cur = None; files = {}
    while i < n:
        l = lines[i]
        if l.startswith('diff --git'):
            m = re.match(r'diff --git a/(.*) b/(.*)$', l)
            if m: cur = m.group(2); files.setdefault(cur, [])
            i += 1; continue
        if l.startswith(('index ', '--- ', '+++ ')) or l.startswith(BS):
            i += 1; continue
        if l.startswith('@@'):
            mm = re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', l)
            os_ = int(mm.group(1)); ob = []; nb = []
            i += 1
            while i < n and (lines[i][:1] in ('+', '-', ' ') or lines[i].startswith(BS)):
                ll = lines[i]
                if ll.startswith(BS): i += 1; continue
                if ll.startswith('-'): ob.append(ll[1:])
                elif ll.startswith('+'): nb.append(ll[1:])
                else: ob.append(ll[1:]); nb.append(ll[1:])
                i += 1
            files.setdefault(cur, []).append((os_, ob, nb)); continue
        i += 1
    for fn, hk in files.items():
        if fn is None: continue
        fl = open(fn, encoding='utf-8').read().split('\n')
        if fl and fl[-1] == '': fl.pop()
        for os_, ob, nb in sorted(hk, key=lambda x: x[0], reverse=True):
            p = os_ - 1
            if fl[p:p+len(ob)] == ob:
                fl[p:p+len(ob)] = nb
            else:
                fnd = -1
                for s in range(max(0, p-3), min(len(fl), p+4)):
                    if fl[s:s+len(ob)] == ob: fnd = s; break
                if fnd >= 0: fl[fnd:fnd+len(ob)] = nb
                else:
                    sys.stderr.write('WARN: cannot apply hunk to ' + fn + '\n'); sys.exit(1)
        open(fn, 'w', encoding='utf-8').write('\n'.join(fl) + '\n')
    sys.exit(0)
main()
PYEOF
      then APPLIED=1; fi
    fi
    if [ "$APPLIED" = "1" ]; then
      echo "==> 本地改动已重新应用"; rm -f "$PATCH"
    else
      echo "⚠️ 自动应用补丁失败 (远程可能也改了同一处). 补丁保留在: $PATCH"
      echo "   可手动: git apply --reject \"$PATCH\"  然后解决冲突"
    fi
  else
    # 没有本地改动, 直接再合并一次
    git merge --ff-only "$UPSTREAM" 2>&1
  fi
fi

echo "==> 完成. 当前 HEAD: $(git rev-parse HEAD 2>/dev/null)"
git status 2>&1
