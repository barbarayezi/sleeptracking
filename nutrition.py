"""
AI-powered nutrition estimation for meal records.

Talks to an Anthropic-compatible Messages endpoint. Defaults to the local
Claude Code gateway config so it works out of the box during development,
but honours LLM_API_KEY / LLM_BASE_URL / LLM_MODEL env vars first so a
deployment can point at its own application-level key.

Nothing here raises: every failure comes back as {"ok": False, "error": ...}
so the Flask route can render a friendly message instead of a 500.
"""

import json
import base64
import os
import re
import ssl
import urllib.error
import urllib.request
from pathlib import Path

# Hard ceiling on how long we let the model think. The global socket timeout
# in app.py is 15s; nutrition calls need their own, longer budget.
REQUEST_TIMEOUT = 60

# ── Value ranges (clamp anything the model hallucinates outside these) ──
_RANGE = {
    "kcal": (0, 5000),
    "protein_g": (0, 500),
    "fat_g": (0, 500),
    "carbs_g": (0, 500),
    "weight_g": (0, 3000),
    "score": (0, 10),
}

_QUANTITY_HINT = {
    "light": "食量偏少（约为常规分量的 2/3）",
    "normal": "食量正常",
    "heavy": "食量偏多（约为常规分量的 1.3 倍）",
}

_TYPE_HINT = {
    "breakfast": "早餐",
    "lunch": "午餐",
    "dinner": "晚餐",
    "snack": "加餐/零食",
}

_PROMPT_TEMPLATE = """你是资深营养分析师。根据下面这餐的描述，估算它的营养构成与健康程度。

餐次：{meal_type}
餐食名称：{meal_name}
详细内容：{meal_content}
食量：{quantity_hint}

要求：
1. 先按菜品拆分，逐个估算重量与热量，再汇总。
2. 若无明确重量，按食堂/家常一荤一素的常规分量推断。
3. 健康评分 score 取 0-10 整数，综合考量：蔬菜占比（推荐占餐盘一半）、荤素搭配、烹饪油盐、精制碳水比例。
4. pros 写这餐做得好的地方，cons 写明确的改进点（要具体、带分量或占比数字），suggestion 给下次打菜的可执行建议。
5. 只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块，不要用 // 注释。

输出格式（严格遵循，数值用数字不用字符串）：
{{"items":[{{"name":"白米饭","weight_g":130,"kcal":200,"protein_g":4.3,"fat_g":0.4,"carbs_g":45}}],"kcal":620,"protein_g":19.4,"fat_g":30.3,"carbs_g":58.6,"score":8,"pros":"","cons":"","suggestion":""}}"""


def _load_config():
    """Resolve (base_url, api_key, model).

    Env vars win, so a deployment can use its own key. Falls back to the
    local Claude Code gateway settings for zero-config development.
    """
    base = os.environ.get("LLM_BASE_URL", "").strip()
    key = os.environ.get("LLM_API_KEY", "").strip()
    model = os.environ.get("LLM_MODEL", "").strip()

    if not (base and key):
        try:
            cfg_path = Path.home() / ".claude" / "settings.json"
            env = json.loads(cfg_path.read_text(encoding="utf-8")).get("env", {})
            key = key or env.get("ANTHROPIC_AUTH_TOKEN", "")
            base = base or env.get("ANTHROPIC_BASE_URL", "")
            model = model or env.get("ANTHROPIC_MODEL", "")
        except Exception:
            # Missing/invalid file is fine — the caller reports "not configured".
            pass

    return base, key, model


def is_configured():
    """True when we have enough to attempt a call."""
    base, key, _ = _load_config()
    return bool(base and key)


def _num(value, field, default=None):
    """Coerce to float and clamp into the field's allowed range."""
    lo, hi = _RANGE[field]
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if f != f:  # NaN
        return default
    return round(max(lo, min(hi, f)), 1)


def _clean_items(raw_items):
    """Keep only well-formed item dicts; cap the list to avoid junk floods."""
    cleaned = []
    if not isinstance(raw_items, list):
        return cleaned
    for it in raw_items[:20]:
        if not isinstance(it, dict):
            continue
        name = str(it.get("name", "")).strip()
        if not name:
            continue
        cleaned.append({
            "name": name[:40],
            "weight_g": _num(it.get("weight_g"), "weight_g", 0),
            "kcal": _num(it.get("kcal"), "kcal", 0),
            "protein_g": _num(it.get("protein_g"), "protein_g", 0),
            "fat_g": _num(it.get("fat_g"), "fat_g", 0),
            "carbs_g": _num(it.get("carbs_g"), "carbs_g", 0),
        })
    return cleaned


def _extract_json(text):
    """Pull the first balanced {...} object out of a model response."""
    if not text:
        return None
    # Strip markdown fences if the model ignored the instruction.
    text = re.sub(r"```(?:json)?", "", text)
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _call_model(content, model_override=None, base_override=None, key_override=None, max_tokens=None):
    """POST to the Anthropic-compatible endpoint.

    `content` is either a prompt string (text estimation) or a list of content
    blocks (vision: image + text). Optional overrides let the vision path target
    a different model / base / key — commonly the same gateway, a vision model.
    """
    if base_override and key_override:
        base, key, model = base_override, key_override, model_override
    else:
        base, key, model = _load_config()
        model = model_override or model

    if not (base and key):
        raise RuntimeError(
            "未配置 LLM。请设置 LLM_BASE_URL / LLM_API_KEY 环境变量，"
            "或确保 ~/.claude/settings.json 内含网关凭据。"
        )

    url = base.rstrip("/") + "/v1/messages"
    payload = {
        "model": model or "deepseek-v4-pro",
        "max_tokens": max_tokens or 2000,
        # CRITICAL: this endpoint serves a reasoning model. Without disabling
        # thinking it spends the entire token budget on an internal chain of
        # thought — measured: 2579 output tokens with thinking vs 40 without,
        # and at max_tokens=2000 the answer text never gets emitted at all.
        "thinking": {"type": "disabled"},
        "messages": [{"role": "user", "content": content}],
    }

    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("x-api-key", key)
    req.add_header("anthropic-version", "2023-06-01")

    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT,
                                    context=ssl.create_default_context()) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise RuntimeError(f"LLM 返回 HTTP {e.code}：{body}")


def _collect_text(response):
    """Reasoning models return content as a list of blocks — take the text ones."""
    parts = []
    for block in response.get("content", []) or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "\n".join(parts).strip()


def analyze_meal(meal_name="", meal_content="", meal_quantity="normal", meal_type=""):
    """Estimate nutrition for one meal.

    Returns {"ok": True, "data": {...}} or {"ok": False, "error": "..."}.
    The returned data mirrors the meal_records nutrition columns so the route
    can hand it straight to the frontend for review before saving.
    """
    description = f"{meal_name or ''} {meal_content or ''}".strip()
    if not description:
        return {"ok": False, "error": "请先填写餐食名称或详细内容，AI 需要知道吃了什么。"}

    prompt = _PROMPT_TEMPLATE.format(
        meal_type=_TYPE_HINT.get(meal_type, "未指定"),
        meal_name=meal_name or "（未填写）",
        meal_content=meal_content or "（未填写）",
        quantity_hint=_QUANTITY_HINT.get(meal_quantity, "食量正常"),
    )

    try:
        raw = _call_model(prompt)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    text = _collect_text(raw)
    if not text:
        return {"ok": False, "error": "模型没有返回文本内容，请重试。"}

    data = _extract_json(text)
    if not isinstance(data, dict):
        return {"ok": False, "error": f"模型返回内容不是合法 JSON：{text[:200]}"}

    items = _clean_items(data.get("items"))
    # If the model skipped the item breakdown, we still accept the totals.
    return {
        "ok": True,
        "data": {
            "kcal": _num(data.get("kcal"), "kcal", 0),
            "protein_g": _num(data.get("protein_g"), "protein_g", 0),
            "fat_g": _num(data.get("fat_g"), "fat_g", 0),
            "carbs_g": _num(data.get("carbs_g"), "carbs_g", 0),
            "score": int(_num(data.get("score"), "score", 5) or 5),
            "items": items,
            "pros": str(data.get("pros", "") or "").strip()[:500],
            "cons": str(data.get("cons", "") or "").strip()[:500],
            "suggestion": str(data.get("suggestion", "") or "").strip()[:500],
        },
    }


def summarize(meals):
    """Aggregate nutrition over a list of meal dicts.

    Returns None when there is no numeric data at all, so callers can render
    an empty state instead of a card full of zeros.
    """
    totals = {"kcal": 0.0, "protein_g": 0.0, "fat_g": 0.0, "carbs_g": 0.0}
    counted = 0
    scored = []

    for m in meals:
        kcal = m.get("calorie_kcal")
        if kcal is None:
            continue
        try:
            kcal = float(kcal)
        except (TypeError, ValueError):
            continue
        counted += 1
        totals["kcal"] += kcal
        for field, key in (("protein_g", "protein_g"), ("fat_g", "fat_g"), ("carbs_g", "carbs_g")):
            try:
                totals[field] += float(m.get(key) or 0)
            except (TypeError, ValueError):
                pass
        if m.get("health_score") is not None:
            try:
                scored.append(float(m["health_score"]))
            except (TypeError, ValueError):
                pass

    if counted == 0:
        return None

    # Macro energy split (4/4/9 kcal per gram) — shows balance at a glance.
    pk = totals["protein_g"] * 4
    fk = totals["fat_g"] * 9
    ck = totals["carbs_g"] * 4
    macro_kcal = pk + fk + ck
    if macro_kcal > 0:
        split = {
            "protein_pct": round(pk / macro_kcal * 100, 1),
            "fat_pct": round(fk / macro_kcal * 100, 1),
            "carbs_pct": round(ck / macro_kcal * 100, 1),
        }
    else:
        split = {"protein_pct": 0, "fat_pct": 0, "carbs_pct": 0}

    return {
        "meal_count": counted,
        "kcal": round(totals["kcal"], 1),
        "protein_g": round(totals["protein_g"], 1),
        "fat_g": round(totals["fat_g"], 1),
        "carbs_g": round(totals["carbs_g"], 1),
        "avg_score": round(sum(scored) / len(scored), 1) if scored else None,
        **split,
    }


# ── Vision (image) estimation ──────────────────────────────────────────────
# Reuses the SAME gateway token as text estimation — only the model differs
# (a vision-capable model such as qwen-vl-max). Honour LLM_VISION_* env vars
# so a deployment can point vision at its own endpoint/key if needed.

_VISION_MODEL_DEFAULT = "qwen-vl-max"

_IMAGE_PROMPT_TEMPLATE = """你是资深营养分析师。请仔细识别这张餐食图片里的所有菜品，估算每道菜的重量与营养，并给出整体健康评估。

餐次：{meal_type}
用户备注名称：{meal_name}（可辅助判断，但必须以图片实际内容为准）
食量提示：{quantity_hint}

要求：
1. 逐个识别菜品：名称、估算重量(克)、热量(kcal)、蛋白质(g)、脂肪(g)、碳水(g)。无法精确判断的按食堂/家常常规分量合理估算。
2. 额外生成一段自然语言描述，写入 meal_content，包含：菜品名称、大致分量、烹饪方式。这段文字会直接展示给用户，作为「吃了什么」的总结。
3. 健康评分 score 取 0-10 整数：重点看蔬菜占比(推荐占餐盘约一半)、荤素搭配、烹饪油盐、精制碳水比例。
4. pros 写这餐做得好的地方；cons 写明确改进点(要具体、带分量或占比数字)；suggestion 给下次打菜的可执行建议。
5. 只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块，不要用 // 注释。

输出格式（严格遵循，数值用数字不用字符串）：
{{"meal_content":"白米饭约130g、番茄炒蛋约120g、清炒西兰花约100g、红烧鸡腿约90g","items":[{{"name":"白米饭","weight_g":130,"kcal":200,"protein_g":4.3,"fat_g":0.4,"carbs_g":45}}],"kcal":620,"protein_g":19.4,"fat_g":30.3,"carbs_g":58.6,"score":8,"pros":"","cons":"","suggestion":""}}"""


def _load_vision_config():
    """(base_url, api_key, model) for vision calls.

    Defaults to the same gateway/token as text estimation; override with
    LLM_VISION_BASE_URL / LLM_VISION_API_KEY / LLM_VISION_MODEL if a deployment
    needs a separate vision endpoint.
    """
    base, key, _ = _load_config()
    base = os.environ.get("LLM_VISION_BASE_URL", "").strip() or base
    key = os.environ.get("LLM_VISION_API_KEY", "").strip() or key
    model = os.environ.get("LLM_VISION_MODEL", _VISION_MODEL_DEFAULT).strip()
    return base, key, model


def _guess_media_type(raw):
    """Best-effort sniff of image format from the first bytes."""
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"  # safe fallback


def analyze_meal_image(image_bytes, meal_name="", meal_quantity="normal", meal_type=""):
    """Estimate nutrition from a meal photo.

    Returns the SAME shape as analyze_meal so the route / frontend can treat
    both paths identically. The image is used for recognition only and is not
    persisted here.
    """
    if not image_bytes:
        return {"ok": False, "error": "未收到图片数据。"}

    try:
        b64 = base64.b64encode(image_bytes).decode("ascii")
    except Exception:
        return {"ok": False, "error": "图片编码失败，请换一张图重试。"}

    base, key, model = _load_vision_config()
    if not (base and key):
        return {"ok": False, "error": "未配置 LLM 视觉模型（需要网关凭据）。"}

    prompt = _IMAGE_PROMPT_TEMPLATE.format(
        meal_type=_TYPE_HINT.get(meal_type, "未指定"),
        meal_name=meal_name or "（未填写）",
        quantity_hint=_QUANTITY_HINT.get(meal_quantity, "食量正常"),
    )

    content = [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": _guess_media_type(image_bytes),
                "data": b64,
            },
        },
        {"type": "text", "text": prompt},
    ]

    try:
        raw = _call_model(content, model_override=model, base_override=base,
                          key_override=key, max_tokens=2500)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    text = _collect_text(raw)
    if not text:
        return {"ok": False, "error": "模型没有返回文本内容，请重试。"}

    data = _extract_json(text)
    if not isinstance(data, dict):
        return {"ok": False, "error": f"模型返回内容不是合法 JSON：{text[:200]}"}

    items = _clean_items(data.get("items"))
    meal_content = str(data.get("meal_content", "") or "").strip()[:1000]
    if not meal_content and items:
        # Fallback: build a short description from item names/weights if the
        # model did not provide the natural-language meal_content field.
        meal_content = "、".join(
            f"{it['name']}约{it['weight_g']}g" for it in items if it.get('name')
        )
    return {
        "ok": True,
        "data": {
            "meal_content": meal_content,
            "kcal": _num(data.get("kcal"), "kcal", 0),
            "protein_g": _num(data.get("protein_g"), "protein_g", 0),
            "fat_g": _num(data.get("fat_g"), "fat_g", 0),
            "carbs_g": _num(data.get("carbs_g"), "carbs_g", 0),
            "score": int(_num(data.get("score"), "score", 5) or 5),
            "items": items,
            "pros": str(data.get("pros", "") or "").strip()[:500],
            "cons": str(data.get("cons", "") or "").strip()[:500],
            "suggestion": str(data.get("suggestion", "") or "").strip()[:500],
        },
    }


# ── Cross-day daily brief ─────────────────────────────────────────────────
# Pairs yesterday's diet with this morning's body metrics (weight / water /
# steps / sleep) and asks the model for a short, causal interpretation.

# ── Multi-image before/after estimation ───────────────────────────────────
# Supports N "before" photos + M "after" photos, where the after set is
# optional. The model sees every photo and estimates ACTUAL intake by
# subtracting the leftover (after) from the full plate (before).

def _image_block(raw):
    """Wrap raw image bytes into an Anthropic vision content block."""
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": _guess_media_type(raw),
            "data": base64.b64encode(raw).decode("ascii"),
        },
    }


_MULTI_IMAGE_PROMPT_TEMPLATE = """你是资深营养分析师。下面是同一餐的餐食照片，用于估算「实际摄入量」。

餐次：{meal_type}
用户备注名称：{meal_name}（可辅助判断，但必须以图片实际内容为准）
食量提示：{quantity_hint}

图片编号说明：
- 餐前照片：{before_range}（用餐开始前的完整餐食，全部菜品都在）
- 餐后照片：{after_range}（用餐结束后的剩余状态；若标注为「无」表示未提供）

要求：
1. 先从餐前照片识别全部菜品：名称、估算餐前重量(克)、餐前热量(kcal)、蛋白质(g)、脂肪(g)、碳水(g)。无法精确判断的按食堂/家常常规分量合理估算。
2. 若提供了餐后照片：从餐后照片识别每道菜的剩余重量，计算「实际摄入重量 = 餐前重量 - 剩余重量」，营养按实际摄入比例折算。在 meal_content 中明确写出「餐前约 X kcal，餐后剩余约 Y kcal，实际摄入约 Z kcal」。
3. 若未提供餐后照片：按整餐（全部吃完）估算，并在 meal_content 开头注明「仅提供餐前照片，按整餐估算，实际摄入可能偏高」。
4. 额外生成一段自然语言描述写入 meal_content：包含菜品名称、大致分量、烹饪方式；有餐后图时给出前后对比结论。
5. items 中 weight_g / kcal / protein_g / fat_g / carbs_g 一律表示「实际摄入」（有餐后图时 = 餐前-剩余；仅餐前时 = 餐前重量）；remaining_g 表示餐后剩余重量（仅餐后图存在时填）。
6. 健康评分 score 取 0-10 整数：重点看蔬菜占比(推荐占餐盘约一半)、荤素搭配、烹饪油盐、精制碳水比例。
7. pros 写这餐做得好的地方；cons 写明确改进点(要具体、带分量或占比数字)；suggestion 给下次打菜的可执行建议。
8. 只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块，不要用 // 注释。

输出格式（严格遵循，数值用数字不用字符串）：
{{"meal_content":"白米饭餐前约130g、餐后剩约30g，实际摄入约100g；番茄炒蛋约120g","items":[{{"name":"白米饭","weight_g":100,"kcal":154,"protein_g":3.3,"fat_g":0.3,"carbs_g":34,"remaining_g":30}}],"kcal":620,"protein_g":19.4,"fat_g":30.3,"carbs_g":58.6,"score":8,"pros":"","cons":"","suggestion":""}}"""


def analyze_meal_images(before_images, after_images=None, meal_name="", meal_quantity="normal", meal_type=""):
    """Estimate nutrition from before/after meal photos (multi-image).

    before_images: list[bytes] (required, >=1)
    after_images:  list[bytes] (optional — may be empty/None)
    Returns the SAME shape as analyze_meal_image so the route / frontend can
    treat both paths identically.
    """
    before_images = [b for b in (before_images or []) if b]
    after_images = [b for b in (after_images or []) if b]
    if not before_images and not after_images:
        return {"ok": False, "error": "未收到任何图片数据。"}

    blocks = []
    try:
        for b in before_images:
            blocks.append(_image_block(b))
        for b in after_images:
            blocks.append(_image_block(b))
    except Exception:
        return {"ok": False, "error": "图片编码失败，请换一张图重试。"}

    base, key, model = _load_vision_config()
    if not (base and key):
        return {"ok": False, "error": "未配置 LLM 视觉模型（需要网关凭据）。"}

    nb, na = len(before_images), len(after_images)
    prompt = _MULTI_IMAGE_PROMPT_TEMPLATE.format(
        meal_type=_TYPE_HINT.get(meal_type, "未指定"),
        meal_name=meal_name or "（未填写）",
        quantity_hint=_QUANTITY_HINT.get(meal_quantity, "食量正常"),
        before_range=f"第 1~{nb} 张" if nb else "（无）",
        after_range=(f"第 {nb+1}~{nb+na} 张" if (nb and na) else ("（无）" if not na else "全部图片")),
    )

    content = blocks + [{"type": "text", "text": prompt}]
    try:
        raw = _call_model(content, model_override=model, base_override=base,
                          key_override=key, max_tokens=3000)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    text = _collect_text(raw)
    if not text:
        return {"ok": False, "error": "模型没有返回文本内容，请重试。"}

    data = _extract_json(text)
    if not isinstance(data, dict):
        return {"ok": False, "error": f"模型返回内容不是合法 JSON：{text[:200]}"}

    items = _clean_items(data.get("items"))
    meal_content = str(data.get("meal_content", "") or "").strip()[:1000]
    if not meal_content and items:
        meal_content = "、".join(
            f"{it['name']}约{it['weight_g']}g" for it in items if it.get('name')
        )
    return {
        "ok": True,
        "data": {
            "meal_content": meal_content,
            "kcal": _num(data.get("kcal"), "kcal", 0),
            "protein_g": _num(data.get("protein_g"), "protein_g", 0),
            "fat_g": _num(data.get("fat_g"), "fat_g", 0),
            "carbs_g": _num(data.get("carbs_g"), "carbs_g", 0),
            "score": int(_num(data.get("score"), "score", 5) or 5),
            "items": items,
            "pros": str(data.get("pros", "") or "").strip()[:500],
            "cons": str(data.get("cons", "") or "").strip()[:500],
            "suggestion": str(data.get("suggestion", "") or "").strip()[:500],
        },
    }


_DAILY_BRIEF_PROMPT = """你是用户的健康教练，口语化、简短（中文 3-5 句，不要列点堆砌）。
请把下面两组数据关联起来做一段解读，重点讲「饮食 → 身体反馈」的因果，而不是各说各话。

【昨日饮食（{yesterday}）】
{diet_block}

【今晨身体指标（{today}）】
{morning_block}

解读要点：
1. 体重变化的可能归因（水分/钠/饮食/活动量），不要只笼统说"吃多了"。
2. 饮水量（目标 7 杯≈1.75L）与活动量是否达标，给一个今天可执行的具体小建议。
3. 睡眠对食欲/代谢的影响如能关联更好。
4. 若某组数据缺失，明确说明缺哪一项，不要编造数字。
"""


def daily_brief(yesterday, today, meal_summary, morning):
    """Generate a cross-day health brief.

    Returns the SAME ok-shape as analyze_meal:
        {"ok": True, "data": {"brief": str}} or {"ok": False, "error": str}

    Args:
        yesterday: diet day (YYYY-MM-DD)
        today: morning-metrics day (YYYY-MM-DD)
        meal_summary: nutrition.summarize() result (dict) or None
        morning: dict with keys weight / water_cups / steps / sleep_minutes /
                 sleep_quality (each may be None when not recorded)
    """
    base, key, _ = _load_config()
    if not (base and key):
        return {"ok": False, "error": "未配置 LLM。请设置 LLM_BASE_URL / LLM_API_KEY 环境变量。"}

    prompt = _DAILY_BRIEF_PROMPT.format(
        yesterday=yesterday, today=today,
        diet_block=_build_diet_block(meal_summary),
        morning_block=_build_morning_block(morning),
    )

    try:
        raw = _call_model(prompt, max_tokens=1500)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    text = _collect_text(raw)
    if not text:
        return {"ok": False, "error": "模型没有返回文本内容，请重试。"}

    return {"ok": True, "data": {"brief": text}}



def _build_diet_block(meal_summary):
    """Textual summary of yesterday's diet for prompts."""
    if meal_summary and meal_summary.get("meal_count"):
        s = meal_summary
        return (
            f"共 {s['meal_count']} 餐：总热量约 {round(s['kcal'])} kcal，"
            f"蛋白 {s['protein_g']} g、脂肪 {s['fat_g']} g、碳水 {s['carbs_g']} g"
            + (f"，平均健康分 {s['avg_score']}/10" if s.get("avg_score") is not None else "")
            + (f"；三大营养素供能占比 蛋白 {s['protein_pct']}% / 脂肪 {s['fat_pct']}% / 碳水 {s['carbs_pct']}%"
               if s.get("protein_pct") else "")
        )
    return "（昨日未记录任何饮食）"


def _build_morning_block(morning):
    """Textual summary of this-morning metrics for prompts."""
    lines = []
    if morning.get("weight") is not None:
        lines.append(f"- 体重：{morning['weight']} kg")
    else:
        lines.append("- 体重：未记录")
    if morning.get("water_cups") is not None:
        lines.append(f"- 饮水量：{morning['water_cups']} 杯")
    else:
        lines.append("- 饮水量：未记录")
    if morning.get("steps") is not None:
        lines.append(f"- 步数：{morning['steps']} 步")
    else:
        lines.append("- 步数：未记录")
    if morning.get("sleep_minutes") is not None:
        sm = morning["sleep_minutes"]
        hrs, mins = divmod(sm, 60)
        sleep_txt = f"{hrs} 小时 {mins} 分"
        if morning.get("sleep_quality"):
            sleep_txt += f"，质量 {morning['sleep_quality']}"
        lines.append(f"- 睡眠：{sleep_txt}")
    else:
        lines.append("- 睡眠：未记录")
    return chr(10).join(lines)


def _build_history_block(history):
    """Render prior conversation turns for the chat prompt.

    Returns a readable transcript, or a short note when there is none yet.
    """
    if not history:
        return "（这是用户的第一句追问，之前没有来回对话）"
    lines = []
    for turn in history:
        speaker = "用户" if turn.get("role") == "user" else "教练"
        lines.append(f"{speaker}：{turn.get('content', '').strip()}")
    return chr(10).join(lines)


_CHAT_BRIEF_PROMPT = """你是用户的健康教练。此前你已经根据用户的昨日饮食和今晨身体指标给出了一段「昨日汇总」。现在用户对这段总结有话想说，请基于原始数据和用户的反馈，继续用中文口语化、简短地回复（3-6 句）。

【昨日饮食（{yesterday}）】
{diet_block}

【今晨身体指标（{today}）】
{morning_block}

【你之前的「昨日汇总」】
{previous_brief}

【你与用户此前的对话（按时间顺序，早的在前）】
{history_block}

【用户这一轮的原话】
{user_message}

回复要求：
1. 先理解用户想表达的意思（可能是质疑、补充、求建议、分享感受），不要机械重复之前的总结。
2. 回复必须基于上面的原始数据；如果用户提到某个数据，你可以引用，但不要编造未记录的数据。
3. 保持口语化、有温度；如果是追问建议，给一个今天就能做的小行动。
4. 若用户说"昨天其实没吃这个"或数据明显有误，友好地提示用户去修改对应餐食/指标记录，修改后再重新生成「昨日汇总」。
"""


def chat_brief(yesterday, today, meal_summary, morning, previous_brief, user_message, history=None):
    """Continue the cross-day brief as a conversation.

    Args:
        history: optional list of prior turns, each {"role": "user"/"assistant",
                 "content": str}. Lets the model keep multi-turn context instead
                 of only ever seeing the original summary + the latest message.

    Returns the SAME ok-shape as daily_brief:
        {"ok": True, "data": {"brief": str}} or {"ok": False, "error": str}
    """
    base, key, _ = _load_config()
    if not (base and key):
        return {"ok": False, "error": "未配置 LLM。请设置 LLM_BASE_URL / LLM_API_KEY 环境变量。"}

    history_block = _build_history_block(history)
    prompt = _CHAT_BRIEF_PROMPT.format(
        yesterday=yesterday, today=today,
        diet_block=_build_diet_block(meal_summary),
        morning_block=_build_morning_block(morning),
        previous_brief=(previous_brief or "").strip()[:1200],
        history_block=history_block,
        user_message=(user_message or "").strip()[:500],
    )

    try:
        raw = _call_model(prompt, max_tokens=1200)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    text = _collect_text(raw)
    if not text:
        return {"ok": False, "error": "模型没有返回文本内容，请重试。"}

    return {"ok": True, "data": {"brief": text}}
