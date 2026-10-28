---
name: sleeptracker-ui-redesign
agent_created: true
description: Produce an Ardot canvas redesign mockup when the user asks to optimize or redesign the UI of the Sleep Tracker web app. Use this skill for visual-direction proposals, layout restructuring, and before/after design explorations, not for direct code implementation.
---

# Sleep Tracker UI Redesign

## When to Use

Use this skill when the user asks anything like:

- "优化一下 Sleep Tracker 的 UI"
- "这个界面该怎么改"
- "重新设计一下首页"
- "当前 UI 怎么提升"

The output is an Ardot design file with a redesigned mockup, plus a written critique and next-step recommendations. Do not rewrite production code unless the user explicitly asks to implement the mockup.

## Design Direction (Locked)

The Sleep Tracker is a personal, daily-use PWA for logging sleep, meals, and period data. It is used at night and in the morning, often on a phone. Therefore the UI must feel calm, fast, and intentional — not like a generic analytics dashboard.

Core principles for every redesign:

1. **One dominant region per screen.** The previous design buried everything in equal-weight cards. The new home must open with one clear focal point: last night's sleep.
2. **Primary action always reachable.** "记录睡眠" must live in the sticky top bar, not at the bottom of a long form scroll.
3. **Progressive disclosure.** Long manual forms (sleep / meal / period) should be hidden behind a sheet or a dedicated "记录" tab. The home only shows recent records and entry points.
4. **Restrained iconography.** Replace emoji in headings with clean SVG icons or none at all. Keep only the moon logo and functional glyphs.
5. **Calm dark palette.** Deep night navy (`#0E1426`) canvas, translucent cards (`#161E33`), periwinkle accent (`#8E9BFF`), mint for recovery/good signals (`#5BCFC5`), gold for caution/average (`#D4A574`), red for poor (`#FB7185`).
6. **Biometric typography.** `Sarasa Gothic SC` for Chinese copy, `Inter` for display/latin, `JetBrains Mono` for numbers (duration, HRV, SpO2, steps). Use tabular figures where applicable.

## Workflow

### 1. Audit the Existing UI

Read the current frontend to understand what exists and what hurts:

- `templates/index.html` — structure and content order
- `static/style.css` — color tokens, spacing, card system
- Relevant `static/*.js` — interaction model (optional)

Look for:

- No dominant hero / everything stacked at equal weight
- Primary action buried in the "手动记录" category
- Emoji-heavy headings and navigation
- Generic slate/indigo dashboard look
- Very long forms visible by default
- Multiple competing dashboards

### 2. Load Ardot Design Skills

Always invoke both skills before drawing:

- `ardot-design-core`
- `ardot-ui-design`

Follow the standard Ardot workflow:

- Step 0: create a new design file (`create_design`)
- Step 1-3: read guidelines (`guidelines-web-app.md`) and schema
- Step 4: `search_style_guide` with keywords like `calm sleep tracker dark dashboard wellness`
- Step 5: `build_style_guide` and then override tokens to the locked palette above
- Step 6: build the mockup in sections with `batch_edit`
- Step 8: verify with `capture_screenshot`

### 3. Build the Redesigned Home

Construct the mockup as a desktop-width web app frame (~1180 px). Recommended sections, in order:

1. **Sticky top bar**
   - Left: moon logo + app name "睡眠追踪"
   - Right: date pill, primary CTA "+ 记录睡眠" (periwinkle fill), ghost sync icon

2. **Hero card (dominant region)**
   - Label: "昨晚睡眠"
   - Big duration: e.g. "7h 42m" (`Inter Bold`, 56 px)
   - Sub-line: bed → wake time + record type
   - Recovery pill: "恢复 88 · 良好" (mint, low-opacity background)
   - Right side: circular sleep-score ring (SVG)
   - Background: subtle radial periwinkle glow over navy

3. **Metric chips row**
   - Four chips: 睡眠评分 / 深睡占比 / 恢复 · Whoop / 步数
   - Each chip: label (muted), value (mono), mini sparkline (SVG)
   - Use signal colors for values (mint, periwinkle, cream)

4. **Two-column lower area**
   - Left (~60%): "最近记录" compact list
     - Row: type badge, time range, duration, quality dot
     - Link: "查看全部记录 →"
   - Right (~40%):
     - "本周睡眠" week strip with color-coded cells and today highlight
     - "健康总览 · Whoop" mini panel with recovery / strain / resting HR + deltas

### 4. Font and Fill Gotchas

- Chinese text: `Sarasa Gothic SC` style names are `"Semi Bold"` / `"Bold"` / `"Regular"` (with a space).
- Latin display: `Inter` style names are `"SemiBold"` / `"Bold"` / `"Regular"` (no space).
- Mono numbers: `JetBrains Mono` `"Medium"` / `"Regular"`.
- When using `fills` arrays, put opacity as a sibling of `color`, not as an `a` key inside `color`.
  - Correct: `{type:"SOLID", color:{r:0.357,g:0.812,b:0.773}, opacity:0.16, visible:true, blendMode:"NORMAL"}`
  - Wrong: `{type:"SOLID", color:{r:0.357,g:0.812,b:0.773,a:1}, opacity:0.16 ...}`
- Solid frame backgrounds can use the shorthand `fill:"#0E1426"`.
- SVG nodes inside frames: use `type:"frame"` with an `svg:"<svg>...</svg>"` property. Attribute quotes inside the SVG string must not conflict with the outer JS string delimiters.

### 5. Validate

Take a screenshot of the root frame with `capture_screenshot` and visually inspect:

- Background fills rendered correctly
- No missing-font substitutions
- Quality dots / sparklines / score ring visible
- Horizontal spacing not broken (no overflow > 1180 px)
- Hero remains the dominant region

Fix font/fill/alignment issues in the next `batch_edit` call.

## Output

- An Ardot design file URL to share with the user
- A short written critique of the old UI
- A list of the optimizations embodied in the mockup
- Offer to implement the changes in `templates/index.html` + `static/style.css` if the user approves the direction
