# Nightscout for MentraOS — Animated HUD (G1)

Real-time Nightscout text HUD for Even Realities G1 smart glasses with:

- Animated TIR bar (multiple styles, time-based)
- Head-up gesture (re-animates the bar every time)
- Daily TIR (auto-reset at local midnight)
- Daily carbs/insulin (compact)
- Min/Max of today on 3rd line when head-up
- Low/High glucose alerts with blinking animation

> **Medical disclaimer:** This app is NOT medical-grade and MUST NOT be used to make
> therapy decisions. Always confirm with certified devices and follow your clinical guidance.

---

## Changelog

### v3.0.0 — SDK compatibility update

- **Settings events updated** to current `@mentra/sdk`:
  - Removed `onAppSettingsUpdate` and `onSettingsChange` (do not exist in current SDK).
  - Using only `session.events.onSettingsUpdate()` as documented.
- **Boot bitmap removed**: no image methods are documented in the current SDK.
  Replaced with welcome text (`Loading glucose...` / `Cargando glucosa...`).
- **Settings reading simplified**: synchronous `session.settings.get(key)` instead of `Promise.all`.
- **`node-fetch` dependency removed** (unused).
- Version bump to `3.0.0`.

### v2 — stable-v2 (original)

- TIR animation, range bar, head-up gesture, daily carbs/insulin, mmol/L normalization.

---

## Environment

Create a `.env` file next to `package.json`:

```bash
MENTRAOS_API_KEY=your_mentra_api_key_here
PACKAGE_NAME=com.tucompania.nightscout-glucose
PORT=3000
```

Healthcheck: `GET /health` returns `{ status, timestamp, version, activeSessions, uptime }`.

---

## Mentra Console — Settings keys

### Core
| key | type | default | notes |
|---|---|---|---|
| `nightscout_url` | string | — | Required. |
| `nightscout_token` | string | — | Only if Nightscout requires auth. |
| `units` | select | `mg/dL` | `mg/dL` or `mmol/L`. |
| `language` | select | `en` | `en` or `es`. |
| `timezone` | string | device locale | IANA TZ string. |

### Alerts
| key | type | default | notes |
|---|---|---|---|
| `low_alert_mg` | number | 70 | Low threshold (mg/dL). |
| `high_alert_mg` | number | 250 | High threshold (mg/dL). |
| `low_alert_mmol` | number | 3.9 | Console may store x10 (auto-normalized). |
| `high_alert_mmol` | number | 13.9 | Same. |
| `alerts_enabled` | toggle | true | Enable LOW/HIGH alerts. |
| `alert_cooldown_min` | number | 10 | Minutes between alerts. |
| `alert_duration_s` | number | 15 | Seconds the alert is visible. |

### Display
| key | type | default | notes |
|---|---|---|---|
| `enable_head_up_display` | toggle | true | Show HUD on head-up gesture. |
| `enable_advanced_mode` | toggle | true | TIR bar + carbs/insulin + min/max. |
| `display_duration_s` | number | 5 | Seconds the HUD stays visible. |
| `enable_animations` | toggle | true | Master toggle for animations. |
| `animation_type` | select | `cubic` | `cubic` / `smooth` / `linear`. |
| `show_tir_bar` | toggle | true | Show TIR bar. |
| `show_range_bar` | toggle | false | Show position-in-range bar (overrides TIR). |
| `update_interval` | number | 5 | Minutes between background updates. |
| `prediction_horizon_min` | select | 30 | 15 / 30 / 60. |

---

## Run locally

```bash
npm install
cp .env.example .env  # fill in your values
npm start
```

---

## License

MIT — This software is not a medical device.
