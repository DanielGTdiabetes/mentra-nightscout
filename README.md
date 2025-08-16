# 🚀 Nightscout for MentraOS – v2.9.6 (Text HUD + Daily TIR Bar + Daily CH/Ins)

**Real-time glucose HUD for Even Realities G1 Smart Glasses**  
Now with **Time-in-Range (TIR)** computed from *today’s readings*, a compact **vertical bar** (`│`) rendered inline next to the TIR %, **daily carbs & insulin** summary, **auto midnight reset**, and **line-clamped output** so it never overflows the glasses.

---

## ✨ What’s new in v2.9.6

- **Two display modes**
  - **Simple mode** – Shows *only*: glucose value + trend arrow + time (1 line).
  - **Advanced mode** – Adds a second line with:  
    **`TIR today: NN% │││... · CH/Ins today: Xg / YU`**
- **TIR (Time in Range) for the current day**
  - Computed from Nightscout readings (typically every 5 minutes).
  - Uses your current alert range (low/high) as the in-range band by default.
  - **Auto-reset at local midnight** and **seeded** from today’s entries on app start.
- **TIR bar, always inline**
  - A simple visual bar made of `│` characters (one per 5%). Max 20.
  - Example: `85% → ││││││││││ │││││││││` (17 bars ≈ 85%).
- **Daily carbs & insulin**
  - Summed over **today (local day)** and displayed inline next to the TIR.
  - Example: `· CH/Ins today: 120g / 6.5U` (last event time is appended when present).
- **Min/Max (today) only on head-up gesture (Advanced mode)**
  - Looking up (head position `up`) in **Advanced** mode adds a 3rd line:
    `Min/Max today: <min> / <max> <units>`
- **Line clamp (max 5 lines)**
  - All HUD output is clamped to **≤ 5 lines** to match glasses constraints.
- **Units & language**
  - mg/dL ↔ mmol/L, with alert thresholds kept in sync across units.
  - English/Spanish text output (driven by `language` + optional `timezone`).
- **Resilient & tidy**
  - Robust Nightscout parsing for entries & treatments.
  - Cooldowns for alerts. Safe fallbacks. Consistent logs & user-agent.

---

## 🧭 How it looks

**Simple mode (Advanced OFF) — 1 line**
```
112 mg/dL → 
12:04 (now)
```

**Advanced mode (normal view) — 2 lines**
```
112 mg/dL → 
12:04 (now)
TIR today: 78% │││││││││ · CH/Ins today: 95g / 5.0U · Last: 20g, 1U 11:35
```

**Advanced mode (head-up gesture) — up to 3 lines**
```
112 mg/dL → 
12:04 (now)
TIR today: 78% │││││││││ · CH/Ins today: 95g / 5.0U
Min/Max today: 74 / 189 mg/dL
```

> The output is **auto-clamped to 5 lines** so it never gets cut off on the glasses.

---

## ⚙️ Settings (Mentra Console)

| Key                          | Type    | Range / Options         | Default  | Notes |
|-----------------------------|---------|--------------------------|----------|------|
| `nightscout_url`            | string  | URL or host              | —        | Required. e.g. `https://my-nightscout.herokuapp.com` |
| `nightscout_token`          | string  | token                    | —        | Required if your Nightscout needs auth |
| `update_interval`           | select  | minutes: 1 / 5 / 15      | `5`      | Poll period for background checks |
| `units`                     | select  | `mg/dL` · `mmol/L`       | `mg/dL`  | Display units |
| `language`                  | select  | `en` · `es`              | `en`     | Text language |
| `timezone`                  | string  | IANA TZ (optional)       | locale-based | If omitted, derived from `language` |
| `low_alert_mg`              | slider  | 40–90                    | 70       | Only used when units = mg/dL |
| `high_alert_mg`             | slider  | 180–400                  | 250      | Only used when units = mg/dL |
| `low_alert_mmol`            | slider  | 2.0–5.0                  | 3.9      | Stored x10 in some SDKs; app normalizes |
| `high_alert_mmol`           | slider  | 8.0–30.0                 | 13.9     | Stored x10 in some SDKs; app normalizes |
| `alerts_enabled`            | toggle  | true/false               | true     | Low/high alerts with cooldown |
| `alert_cooldown_ms`         | number  | 60,000–3,600,000         | 600,000  | Default 10 minutes |
| `alert_duration_ms`         | number  | 2,000–60,000             | 15,000   | How long the alert stays visible |
| `display_duration_ms`       | number  | 1,000–15,000             | 5,000    | HUD visibility after a manual trigger |
| `enable_head_up_display`    | toggle  | true/false               | false    | Show HUD when head position = `up` |
| `enable_advanced_mode`      | toggle  | true/false               | false    | Enables TIR bar, daily CH/Ins, Min/Max on gesture |

---

## 🗣️ Voice / Gesture interactions

- **Voice (Mentra “MIRA” tools)**
  - EN: *“Hey Mira, get my glucose”*, *“show current glucose”*
  - ES: *“Hey Mira, obtener mi glucosa”*, *“mostrar glucosa actual”*
  - In Advanced mode, voice responses will append `Today TIR: NN%` when available.

- **Head-up gesture** (`enable_head_up_display = true`)
  - Simple mode: shows **only glucose/time** (1 line).
  - Advanced mode: adds **TIR bar + daily CH/Ins**, and **Min/Max today** on a 3rd line.
  - Gesture has an anti-spam cooldown (~10s).

---

## 🏁 Quick start

1. **Deploy** the Node app (Node 18+) — e.g. Render/Railway/Docker.
2. **Set env vars:** `MENTRAOS_API_KEY`, optionally `RENDER_URL` for keep-alive.
3. In Mentra console, set **Nightscout URL + Token**.
4. (Optional) Choose `units`, `language`, `timezone`.
5. Toggle **`enable_advanced_mode`** and **`enable_head_up_display`** to taste.

Health endpoint: `GET /health` returns `{ status, timestamp, version, activeSessions }`.

---

## 🔐 Environment variables

- `MENTRAOS_API_KEY` — **required** (Mentra API key)
- `PACKAGE_NAME` — optional (default: `com.tucompania.nightscout-glucose`)
- `PORT` — optional (default: `3000`)
- `RENDER_URL` — optional, used for periodic self-ping keep-alive

---

## 🧪 How TIR is calculated

- Uses **today’s** Nightscout entries (local day per `timezone` or language locale).
- In-range is `low_alert`–`high_alert` converted to mg/dL if necessary.
- Each new reading increments totals and proportionally updates `%`.
- On app start, today’s history is **seeded** for a correct TIR from minute 1.
- At local **midnight**, counters reset automatically.

---

## 🧰 Troubleshooting

- **No bar or chopped lines on glasses:**  
  We now clamp output to **≤ 5 lines** and render TIR **inline** to minimize height.
- **mmol/L comes as integer x10 in settings:**  
  The app normalizes (e.g., `39` → `3.9 mmol/L`) and keeps mg/dL in sync.
- **Treatments missing `created_at` / `timestamp` / `dateString`:**  
  Those entries are skipped safely.
- **Nightscout errors / timeouts:**  
  The app cycles multiple endpoints and shows a concise error if all fail.

---

## 📋 Example Mentra app JSON (minimal)

```json
{
  "name": "Nightscout Glucose",
  "description": "Real-time Nightscout HUD for Mentra (Simple/Advanced + Head-Up)",
  "publicUrl": "https://your-deploy-url.example.com",
  "appType": "background",
  "permissions": [{ "type": "ALL", "description": "" }],
  "settings": [
    { "id": "nightscout_url", "type": "text" },
    { "id": "nightscout_token", "type": "text" },
    { "id": "units", "type": "select", "options": ["mg/dL", "mmol/L"], "default": "mg/dL" },
    { "id": "language", "type": "select", "options": ["en", "es"], "default": "en" },
    { "id": "timezone", "type": "text" },
    { "id": "low_alert_mg", "type": "slider", "min": 40, "max": 90, "default": 70 },
    { "id": "high_alert_mg", "type": "slider", "min": 180, "max": 400, "default": 250 },
    { "id": "low_alert_mmol", "type": "slider", "min": 20, "max": 50, "default": 39 },
    { "id": "high_alert_mmol", "type": "slider", "min": 80, "max": 300, "default": 139 },
    { "id": "alerts_enabled", "type": "toggle", "default": true },
    { "id": "alert_cooldown_ms", "type": "number", "default": 600000 },
    { "id": "alert_duration_ms", "type": "number", "default": 15000 },
    { "id": "display_duration_ms", "type": "number", "default": 5000 },
    { "id": "enable_head_up_display", "type": "toggle", "default": false },
    { "id": "enable_advanced_mode", "type": "toggle", "default": false }
  ]
}
```

---

## 📜 License

**MIT License**  
_Disclaimer: Informational use only. Always verify with medical-grade devices._

**Version:** 2.9.6  
**Date:** August 2025  
**Compatibility:** MentraOS SDK (latest)
