# Nightscout for MentraOS — **Animated HUD** (G1)

Real‑time Nightscout **text HUD** for Even Realities G1 smart glasses with:
- **Animated TIR bar** (multiple styles, time‑based).
- **Head‑up gesture** (re‑animates the bar every time).
- **Daily TIR** (auto‑reset at local midnight).
- **Daily carbs/insulin** (compact).
- **Min/Max of today** on 3rd line when head‑up.
- **5‑line clamp** so the output never overflows the display.

> ## ⚠️ Important — Prediction is *indicative only*
> The **prediction** shown in the HUD is a **rough, informational hint**. It may be based on:
> - the official prediction from your Nightscout source **when available**, or
> - a simple projection fallback when we don’t have an official value.
> 
> **It is NOT medical‑grade and MUST NOT be used to make therapy decisions.** Always confirm with certified devices and follow your clinical guidance.

---

## What’s new (this build)

- Much **smoother TIR animation** (time‑based, sub‑steps per slot).
- **Render token** to avoid double frames and “flashes” between screens.
- **Head‑up cooldown configurable** and **re‑animates** even if TIR didn’t change.
- **mmol/L normalization**: if your console stores mmol in **×10** (e.g. 30 = 3.0),
  the app **auto‑normalizes** (>=30 → divide by 10). One decimal is shown (`7.7 mmol/L`).
- **Compact EN output**: 24h time, shorter separators, prediction like `7.7 @30m` to keep the Min/Max line visible.
- **Prediction alert style**: `solid` (no animation), `pulse` (default) or `blink`.
  When animations aren’t visible on your device, use **`solid`**.

---

## Environment

Create a `.env` file (see template below) next to `package.json`:

```bash
MENTRAOS_API_KEY=your_mentra_api_key_here
PACKAGE_NAME=com.tucompania.nightscout-glucose
PORT=3000
# Optional: self-ping URL for keep-alive on some PaaS
RENDER_URL=https://your-app.onrender.com/health
```

> The server runs on **Node 18+**. Healthcheck: `GET /health` returns `{ status, timestamp, version, activeSessions }`.

---

## Mentra Console — Settings keys

These keys are read from Mentra’s settings UI. If a key does not exist,
**the app uses a safe default**.

### Core
| key | type | default | notes |
|---|---|---|---|
| `nightscout_url` | string (URL) | — | Required (token optional). |
| `nightscout_token` | string | — | Only if your Nightscout requires auth. |
| `units` | select | `mg/dL` | `mg/dL` or `mmol/L` (shows 1 decimal in mmol). |
| `language` | select | `en` | `en` / `es`. |
| `timezone` | string | device locale | IANA TZ. |

### Alerts & ranges
| key | type | default | notes |
|---|---|---|---|
| `low_alert_mg` | number | 70 | When `units=mg/dL`. |
| `high_alert_mg` | number | 180 | When `units=mg/dL`. |
| `low_alert_mmol` | number | 39 | **Console may store ×10** (e.g. 30→3.0). App auto‑normalizes (≥30 ⇒ ÷10). |
| `high_alert_mmol` | number | 139 | Same rule as above. |
| `alerts_enabled` | toggle | `true` | Enables LOW/HIGH alerts. |
| `alert_cooldown_ms` | number | `600000` | 10 min. |
| `alert_duration_ms` | number | `15000` | Visible time of an alert. |

### Display / UX
| key | type | default | notes |
|---|---|---|---|
| `enable_head_up_display` | toggle | `true` | Show HUD on **head‑up**. |
| `enable_advanced_mode` | toggle | `true` | Shows TIR bar + CH/Ins + Min/Max. |
| `display_duration_ms` | number | `5000` | Time the HUD stays visible. |
| `enable_animations` | toggle | `true` | Master toggle for animations. |
| `animation_speed` | select | `normal` | `slow` / `normal` / `fast`. |
| `show_tir_bar` | toggle | `true` | Show TIR bar. |
| `tir_anim_ms` | number | `800` | Total duration for TIR bar animation. |
| `tir_anim_style` | select | `sweep` | `fill` / `sweep` / `spinner` / `flip`. |
| `tir_slots` | number | `16` | Slots in the TIR bar. |
| `tir_leadin_ms` | number | `220` | Pause before filling starts. |
| `tir_substeps` | number | `4` | Micro‑steps inside each slot. |
| `headup_cooldown_ms` | number | `1000` | Debounce for head‑up gesture. |

### Prediction
| key | type | default | notes |
|---|---|---|---|
| `prediction_horizon_min` | select | `30` | 15 / 30 / 60. |
| `official_prediction_only` | toggle | `false` | If `true`, no fallback projection. |
| `blink_on_prediction` | toggle | `true` | Add a warning line if out of range. |
| `prediction_alert_style` | select | `pulse` | `solid` / `pulse` / `blink`. |
| `blink_cycles` | number | `3` (pulse) / `4` (blink) | Warning repetitions. |
| `blink_interval_ms` | number | `260` (pulse) / `220` (blink) | Interval per on/off phase. |

> **Tip:** If your device does not show “blinks”, set `prediction_alert_style=solid` to always show a fixed warning line.

---

## How TIR is computed (quick)
- Uses **today’s** Nightscout entries; resets at local midnight.
- In‑range band comes from your **current LOW/HIGH** thresholds (normalized to mg/dL).
- The animated bar reflects today’s TIR % (0–100). The gesture **re‑animates** even if the % didn’t change.

---

## Troubleshooting
- **QUIC / HTTP3 issues (`ERR_QUIC_PROTOCOL_ERROR`)**: force HTTP/2 in your browser or use another network/VPN. Some ISPs block ranges during football events; switching IP/CDN or using DNS‑only on your subdomain may help.
- **mmol shows integers** (e.g. 30, 66): that’s **×10** storage in some SDKs. The app **auto‑normalizes** (≥30 ⇒ ÷10) and displays `3.0`, `6.6`, etc.
- **Blink not visible**: use `prediction_alert_style=solid` (no animation).

---

## Run locally

```bash
# 1) install
npm i
# 2) env
cp env.example .env   # and fill your values
# 3) start
npm start
```

---

## License & disclaimer

**MIT** • © You, contributors.  
This software is **not a medical device**. Predictions are **rough hints** only. Always double‑check with certified devices and follow medical advice.
