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
import io
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

    Model resolution order (highest priority first):
      1. env LLM_MODEL (if set) — operator's explicit pick
      2. env LLM_MODEL_PRIMARY / LLM_MODEL_FALLBACK (comma-list, tried in order)
      3. Claude Code gateway ANTHROPIC_MODEL
      4. Hard-coded _DEFAULT_MODEL_LIST (best-effort fallback to stronger models)

    Returns (base_url, api_key, model).
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

    # Multi-model fallback list — first non-empty wins.
    if not model:
        env_primary = os.environ.get("LLM_MODEL_PRIMARY", "").strip()
        env_fallback = os.environ.get("LLM_MODEL_FALLBACK", "").strip()
        for cand in [env_primary, env_fallback, *_DEFAULT_MODEL_LIST]:
            if cand:
                model = cand
                break

    return base, key, model


_DEFAULT_MODEL_LIST = [
    # Stronger tier (try in order if LLM_MODEL env is empty)
    "deepseek-v3.2-chat",       # 性价比强
    "deepseek-v4-pro",
    "gpt-4o-mini",
    "qwen-max",
    "claude-3-5-sonnet",
]


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


_JPEG_MAX_SIDE = 1600  # qwen-vl 侧尺寸上限以内留余量；也控制请求体大小


def _is_heic(raw):
    """Sniff HEIC/HEIF file magic from the first bytes.

    ISO Base Media File Format: [4-byte size] 'ftyp' [brand].
    Common HEIF brands: heic, heix, mif1, msf1.
    """
    if not raw or len(raw) < 16:
        return False
    head = raw[:16]
    if b'ftyp' not in head:
        return False
    # brand starts 8 bytes in (size + 'ftyp')
    brand = head[8:12].lower()
    return brand in (b'heic', b'heix', b'mif1', b'msf1')


def _to_jpeg_bytes(raw, max_side=_JPEG_MAX_SIDE):
    """Convert any decodeable image (PNG/WebP/JPEG/GIF/HEIC...) to a JPEG blob.

    Measured (2026-09-03): the Aliyun MaaS vision gateway REJECTS PNG outright
    ("The image format is illegal and cannot be opened") while JPEG goes through
    — it sniffs the real bytes, so lying about media_type does not help. So every
    upload is normalised to JPEG before being sent.

    HEIC/HEIF photos from iPhone are registered via pillow-heif (declared in
    requirements.txt). If the dependency is missing, we return a clear error
    asking the user to convert to JPEG instead of the cryptic Pillow message.

    Returns (jpeg_bytes, None) on success, or (None, user_friendly_error).
    """
    try:
        from PIL import Image, ImageOps
    except Exception:
        return None, "服务器缺少 Pillow 图片处理依赖，无法分析图片。"

    # Register HEIF/HEIC opener for Pillow if pillow-heif is installed.
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
    except Exception:
        pass

    is_heic = _is_heic(raw)

    try:
        im = Image.open(io.BytesIO(raw))
        im = ImageOps.exif_transpose(im)
        if im.mode == "RGBA":
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[3])
            im = bg
        elif im.mode != "RGB":
            im = im.convert("RGB")
        if max(im.size) > max_side:
            im.thumbnail((max_side, max_side), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=88)
        return buf.getvalue(), None
    except Exception as e:
        if is_heic:
            try:
                import pillow_heif  # noqa: F401
            except ImportError:
                return None, "图片为 HEIC/HEIF 格式，服务器尚未安装解码依赖（pillow-heif）。请转换为 JPEG 后重试，或等待下次部署后使用。"
        return None, f"图片无法解析：{e}"


def analyze_meal_image(image_bytes, meal_name="", meal_quantity="normal", meal_type=""):
    """Estimate nutrition from a meal photo.

    Returns the SAME shape as analyze_meal so the route / frontend can treat
    both paths identically. The image is used for recognition only and is not
    persisted here.
    """
    if not image_bytes:
        return {"ok": False, "error": "未收到图片数据。"}

    jpeg_bytes, err = _to_jpeg_bytes(image_bytes)
    if err:
        return {"ok": False, "error": err}
    try:
        b64 = base64.b64encode(jpeg_bytes).decode("ascii")
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
                "media_type": "image/jpeg",
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
    """Normalise image bytes to JPEG and wrap into an Anthropic vision block.

    Raises ValueError with a friendly reason when the bytes are not decodable.
    """
    jpeg_bytes, err = _to_jpeg_bytes(raw)
    if err:
        raise ValueError(err)
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": base64.b64encode(jpeg_bytes).decode("ascii"),
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
    except Exception as e:
        return {"ok": False, "error": f"图片转换失败：{e}"}

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


_DAILY_BRIEF_PROMPT = """你是用户长期跟踪的私人健康教练 + 营养师 + 体能顾问。中文、口语化、有温度、有专业度。

请用「5–8 句」自然段（不要 bullet 堆砌）回应，引述数据时用具体数字（不要写"较高/较低"这种笼统词）。重点讲「昨日饮食 → 今晨身体反馈 → 7 天趋势」的因果链，结尾给一个今天就能做的具体小行动。

【昨日饮食（{yesterday}）】
{diet_block}

【今晨身体指标（{today}）】
{morning_block}

【夜间睡眠主观反馈（{today}）】
{sleep_block}

【用药情况（{today}）】
{medication_block}

【过去 7 天趋势（饮食 + 身体）】
{trends_block}

【用户基础信息（可能为空，未填则跳过）】
{profile_block}

解读要求：
1. 体重变化 → 关联昨日钠 / 碳水 / 饮水量 / 步数，给出可能归因（不要只说"吃多了"）。
2. 营养三大素比例（蛋白/脂肪/碳水）是否合理（健康成年人大致 15-25% / 20-35% / 45-60%）。
3. 饮水量与活动量是否达标，结合步数判断；目标 7 杯≈1.75L。
4. 睡眠时长/质量对今日状态的可能影响。
5. 若数据缺失，明确说明缺哪一项，不要编造。
6. 7 天趋势若显示体重上升/下降/营养不均衡，要点名指出趋势方向。
7. 结尾给 1 个今天可执行的具体行动（具体到几杯水/多少步/哪种食物）。
8. 若提供了用药情况：把「连续规律服用抗抑郁/中成药」作为近期恢复趋势的可能相关因素之一来提（注意抗抑郁药通常需 2–4 周起效）；只做相关性观察，绝不建议停药、减量或自行调整；未记录的药不要编造。
9. 【夜间睡眠主观反馈】必须纳入解读：睡眠问题（失眠 / 多梦 / 多汗 / 频醒 / 早醒）与梦境/身体感受记录，对今晨情绪、精力、身体感受的可能影响；若记录了多梦 / 早醒 / 频醒等，结合睡眠时长与质量，给出今晚可调整的具体建议（如睡前 30 分钟远离屏幕、固定起床时间、睡前温水浴）。不要对梦境做过度玄学解读，只做与睡眠结构、压力水平相关的合理关联。
"""


def daily_brief(yesterday, today, meal_summary, morning, trends=None, profile=None,
                medication=None, dream_journal=None, sleep_problems=None):
    """Generate a cross-day health brief.

    Returns the SAME ok-shape as analyze_meal:
        {"ok": True, "data": {"brief": str}} or {"ok": False, "error": str}

    Args:
        yesterday: diet day (YYYY-MM-DD)
        today: morning-metrics day (YYYY-MM-DD)
        meal_summary: nutrition.summarize() result (dict) or None
        morning: dict with keys weight / water_cups / steps / sleep_minutes /
                 sleep_quality / sleep_problems / dream_journal
                 (each may be None / empty when not recorded)
        trends: optional 7-day rolling summary dict (from app._compute_7d_trends)
        profile: optional user profile dict (age/sex/height/goal/activity)
        medication: optional dict describing the day's pill log, shaped by
                    app._medication_context(): {summary, streak_days, first_date}
        dream_journal: optional str, the night's dream / body-feeling journal
        sleep_problems: optional list of problem keys (insomnia/dreams/sweats/
                       waking/early_waking)
    """
    base, key, _ = _load_config()
    if not (base and key):
        return {"ok": False, "error": "未配置 LLM。请设置 LLM_BASE_URL / LLM_API_KEY 环境变量。"}

    prompt = _DAILY_BRIEF_PROMPT.format(
        yesterday=yesterday, today=today,
        diet_block=_build_diet_block(meal_summary),
        morning_block=_build_morning_block(morning),
        sleep_block=_build_sleep_block(dream_journal, sleep_problems),
        medication_block=_build_medication_block(medication),
        trends_block=_build_trends_block(trends or {}),
        profile_block=_build_profile_block(profile or {}),
    )

    try:
        raw = _call_model(prompt, max_tokens=2000)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    text = _collect_text(raw)
    if not text:
        return {"ok": False, "error": "模型没有返回文本内容，请重试。"}

    return {"ok": True, "data": {"brief": text}}


# ── Weekly / monthly summaries ───────────────────────


_WEEKLY_PROMPT = """你是用户长期跟踪的私人健康教练 + 营养师 + 体能顾问。中文、口语化、有专业度。

请用「6–10 句」自然段（不要 bullet 堆砌）回应一段【周总结】（周期 {period_label}，{from_date} 至 {to_date}）。
用户希望每周都能保留一份可回看的总结，所以语气可以稍正式一些，但仍然口语化、有温度。

【本周饮食概览（{from_date} – {to_date}）】
{weekly_diet_block}

【本周身体指标概览（{from_date} – {to_date}）】
{weekly_metrics_block}

【本周睡眠概览（{from_date} – {to_date}）】
{weekly_sleep_block}

【本周 7 日趋势 / 对比上周】
{trends_block}

【用户基础信息（可能为空，未填则跳过）】
{profile_block}

解读要求：
1. 给出本周的整体走向（向上/向下/平稳），用一句话点出最值得关注的趋势。
2. 饮食：本周平均热量、营养素是否均衡、有无亮点/隐忧。
3. 身体：体重、饮水量、步数的变化方向，与上周对比（百分比或绝对值均可）。
4. 睡眠：平均时长、平均质量、最差一天与原因（结合 sleep_summary 的结构化数据）。
5. 给 2 条「下周就能做」的具体行动（不要堆清单）。
6. 数据缺失项要明确说明「本周未记录…」，不要编造。
"""


_MONTHLY_PROMPT = """你是用户长期跟踪的私人健康教练 + 营养师 + 体能顾问。中文、口语化、有专业度。

请用「8–14 句」自然段（不要 bullet 堆砌）回应一段【月总结】（周期 {period_label}，{from_date} 至 {to_date}）。
用户希望每月都能保留一份可回看的长期总结，请重点放在「整体走向 + 与既往对比 + 长期趋势解读」。

【本月饮食概览（{from_date} – {to_date}）】
{weekly_diet_block}

【本月身体指标概览（{from_date} – {to_date}）】
{weekly_metrics_block}

【本月睡眠概览（{from_date} – {to_date}）】
{weekly_sleep_block}

【本月 30 日趋势 / 与上月对比（若有）】
{trends_block}

【用户基础信息（可能为空，未填则跳过）】
{profile_block}

解读要求：
1. 一句话总结本月主旋律。
2. 饮食：平均日热量、营养结构、最常出现的「问题餐」类型（例如高糖/过咸/极端低脂等模式）。
3. 身体：体重月度趋势（升/降/平稳）、饮水量是否稳定、步数活跃日占比。
4. 睡眠：整月平均时长/质量、变化趋势、最差的几天与可能原因。
5. 与上月（或月初）对比，给出关键指标的方向性结论。
6. 给 3 条「下月可尝试」的具体行动建议。
7. 数据缺失项要明确说明「本月未记录…」，不要编造。
"""


def weekly_brief(period_start, period_end, weekly_aggregates, trends=None, profile=None):
    """Generate a weekly or monthly summary over the period.

    Args:
        period_start, period_end: ISO dates (inclusive) of the period.
        weekly_aggregates: dict with keys weekly_diet / weekly_metrics /
                          weekly_sleep (each a human-readable summary string
                          produced by app.py helpers).
        trends: optional pre-formatted trend block string (already rendered).
        profile: optional user profile dict.

    Returns: ok-shape dict ({"ok": True, "data": {"brief": str}} or error).
    """
    base, key, _ = _load_config()
    if not (base and key):
        return {"ok": False, "error": "未配置 LLM。请设置 LLM_BASE_URL / LLM_API_KEY 环境变量。"}

    n_days = _days_between(period_start, period_end)
    period_label = '月' if n_days >= 28 else '周'

    prompt = (_MONTHLY_PROMPT if n_days >= 28 else _WEEKLY_PROMPT).format(
        period_label=period_label,
        from_date=period_start,
        to_date=period_end,
        weekly_diet_block=weekly_aggregates.get('diet', '（本周/本月无饮食记录）'),
        weekly_metrics_block=weekly_aggregates.get('metrics', '（本周/本月无身体指标）'),
        weekly_sleep_block=weekly_aggregates.get('sleep', '（本周/本月无睡眠记录）'),
        trends_block=trends or '（无 7 日趋势数据）',
        profile_block=_build_profile_block(profile or {}),
    )

    try:
        raw = _call_model(prompt, max_tokens=2400)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    text = _collect_text(raw)
    if not text:
        return {"ok": False, "error": "模型没有返回文本内容，请重试。"}

    return {"ok": True, "data": {"brief": text}}


def _days_between(a_iso, b_iso):
    """Inclusive day count between two ISO dates."""
    from datetime import date as _d
    try:
        return (_d.fromisoformat(b_iso) - _d.fromisoformat(a_iso)).days + 1
    except Exception:
        return 0



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


def _build_medication_block(medication):
    """Render today's medication log for the prompt.

    `medication` (optional, from app._medication_context) is a dict with:
        - summary:  medication_models.get_daily_medication_summary() output
        - streak_days: consecutive antidepressant days ending today
        - first_date: ISO date the fixed regimen began (may be None)
    Returns a compact human-readable block; never fabricates entries.
    """
    if not medication:
        return "（无用药记录信息）"
    summary = medication.get("summary")
    if not summary or not summary.get("taken_total"):
        return "（今天尚未记录任何用药）"
    lines = []
    s = summary
    parts = []
    if s.get("supplement_taken"):
        parts.append(f"保健类 {s['supplement_taken']} 项")
    if s.get("antidepressant_taken"):
        parts.append(f"抗抑郁类 {s['antidepressant_taken']} 项")
    if s.get("other_taken"):
        parts.append(f"其他 {s['other_taken']} 项")
    names = []
    for slot in ("morning", "noon", "evening", "night"):
        for n in (s.get("by_slot") or {}).get(slot, []) or []:
            if n and n not in names:
                names.append(n)
    head = "、".join(parts) if parts else f"{s['taken_total']} 项"
    lines.append(f"- 今日共 {s['taken_total']} 条服药记录：{head}（{'、'.join(names)}）")
    first = (medication.get("first_date") or "").strip()
    if first:
        lines.append(f"- 固定用药方案自 {first} 开始")
    streak = medication.get("streak_days") or 0
    if streak >= 1:
        lines.append(f"- 抗抑郁药已连续服用 {streak} 天（截至今日）")
    return chr(10).join(lines)


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


_PROBLEM_NAMES = {
    'insomnia': '失眠', 'dreams': '多梦', 'sweats': '多汗',
    'waking': '频醒', 'early_waking': '早醒',
}


def _build_sleep_block(dream_journal, sleep_problems):
    """Render the night's subjective sleep feedback for the prompt.

    `sleep_problems` is an optional list of problem keys; `dream_journal` is an
    optional free-text journal. Both may be empty. Never fabricates content.
    """
    problems = sleep_problems or []
    if isinstance(problems, str):
        try:
            problems = json.loads(problems)
        except Exception:
            problems = []
    lines = []
    if problems:
        names = [_PROBLEM_NAMES.get(p, p) for p in problems if p]
        lines.append(f"- 睡眠问题：{'、'.join(names)}")
    else:
        lines.append("- 睡眠问题：无记录")
    dj = (dream_journal or '').strip()
    if dj:
        lines.append(f"- 梦境/身体感受记录：{dj[:800]}")
    else:
        lines.append("- 梦境/身体感受记录：未填写")
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
        content = (turn.get("content") or "").strip()
        if content:
            lines.append(f"{speaker}：{content[:600]}")
    return chr(10).join(lines)


def _build_trends_block(trends):
    """Render the 7-day rolling-trend dict for the prompt.

    Empty dict → a short note. Each field: mean / min / max / n / delta / trend.
    """
    if not trends:
        return "（近 7 天数据不足，未提供趋势）"
    label_map = {
        'weight': '体重 (kg)',
        'water_cups': '饮水量 (杯)',
        'steps': '步数',
        'sleep_minutes': '睡眠 (分钟)',
    }
    arrow = {'up': '↑', 'down': '↓', 'flat': '→'}
    lines = []
    for k, v in trends.items():
        label = label_map.get(k, k)
        lines.append(
            f"- {label}: 7d 均值 {v['mean']}，区间 [{v['min']}, {v['max']}]，"
            f"较 7d 前{'升' if v['delta'] > 0 else '降' if v['delta'] < 0 else '平'}{abs(v['delta'])} "
            f"（n={v['n']}，方向 {arrow.get(v['trend'], v['trend'])}）"
        )
    return chr(10).join(lines)


def _build_profile_block(profile):
    """Render user profile for the prompt (only non-empty fields shown)."""
    if not profile:
        return "（未提供）"
    label_map = {
        'age': '年龄',
        'sex': '性别',
        'height_cm': '身高 (cm)',
        'goal': '目标',
        'activity_level': '活动量',
    }
    goal_zh = {
        'lose_fat': '减脂', 'maintain': '维持', 'gain_muscle': '增肌',
    }
    activity_zh = {
        'sedentary': '久坐', 'light': '轻度', 'moderate': '中度', 'active': '高强度',
    }
    lines = []
    for k, v in profile.items():
        if v in (None, '', 0):
            continue
        if k == 'goal' and v in goal_zh:
            v = goal_zh[v]
        elif k == 'activity_level' and v in activity_zh:
            v = activity_zh[v]
        lines.append(f"- {label_map.get(k, k)}：{v}")
    return chr(10).join(lines) if lines else "（未提供）"


_CHAT_BRIEF_PROMPT = """你是用户的私人健康教练 + 营养师。用户对之前给到的「昨日汇总」有反馈、追问或质疑，你需要继续回应。

要求：
- 用 5–10 句自然段回应（不要 bullet 堆砌、不要刻意短）
- 引述数据用具体数字（不要写"较高/较低"这种笼统词）
- 用户反馈可能是质疑 / 补充 / 求建议 / 分享感受，先读懂用户意图再回应
- 回复必须基于下面的原始数据，**不能编造未记录的数字**；若数据有矛盾或缺失，友好指出并建议用户去修改对应记录后再重新生成
- 关联 7 天趋势（体重、饮水量、步数、营养得分）做纵向洞察——这是关键差异化价值
- 若用户问"今天该怎么吃 / 怎么练 / 怎么调整"，给 1 个今天就能做的具体行动（具体到几杯水 / 多少步 / 哪种食物 / 几点睡）
- 若用户聊到睡眠问题（失眠/多梦/早醒/频醒）或梦境，结合【夜间睡眠主观反馈】做与睡眠结构、压力水平相关的合理关联，不要过度玄学解读
- 保持口语化、有温度

【昨日饮食（{yesterday}）】
{diet_block}

【今晨身体指标（{today}）】
{morning_block}

【夜间睡眠主观反馈（{today}）】
{sleep_block}

【用药情况（{today}）】
{medication_block}

【过去 7 天趋势】
{trends_block}

【用户基础信息（可能为空，未填则跳过）】
{profile_block}

【你此前的「昨日汇总」（语境上下文）】
{previous_brief}

【你与用户此前的对话（按时间顺序，早的在前）】
{history_block}

【用户这一轮的原话】
{user_message}
"""


def chat_brief(yesterday, today, meal_summary, morning, previous_brief, user_message,
               history=None, trends=None, profile=None, medication=None,
               dream_journal=None, sleep_problems=None):
    """Continue the cross-day brief as a conversation.

    Args:
        history: optional list of prior turns, each {"role": "user"/"assistant",
                 "content": str}. Lets the model keep multi-turn context instead
                 of only ever seeing the original summary + the latest message.
        trends: optional 7-day rolling summary dict (from app._compute_7d_trends)
        profile: optional user profile dict (age/sex/height/goal/activity)
        medication: optional medication-context dict (same shape as daily_brief)
        dream_journal / sleep_problems: optional night subjective feedback,
                 same semantics as daily_brief.

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
        sleep_block=_build_sleep_block(dream_journal, sleep_problems),
        medication_block=_build_medication_block(medication),
        trends_block=_build_trends_block(trends or {}),
        profile_block=_build_profile_block(profile or {}),
        previous_brief=(previous_brief or "").strip()[:1500],
        history_block=history_block,
        user_message=(user_message or "").strip()[:2000],
    )

    try:
        raw = _call_model(prompt, max_tokens=2000)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    text = _collect_text(raw)
    if not text:
        return {"ok": False, "error": "模型没有返回文本内容，请重试。"}

    return {"ok": True, "data": {"brief": text}}
