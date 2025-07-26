# 🚀 Nightscout for MentraOS – v2.4 Advanced Update

**Real-Time Glucose Monitoring for Even Realities G1 Smart Glasses**  
✨ *Now with full slicer support, mmol/L detection & enhanced internationalization*

---

## 🆕 What's New in v2.4

### 🔧 Critical Fixes & Enhancements

- ✅ Fixed SDK compatibility errors – No more `updateSettingsForTesting` issues
- ✅ **Full Slicer Support** – Settings now work perfectly with MentraOS sliders
- ✅ **mmol/L Auto-Detection** – Automatically detects units from Nightscout profile
- ✅ **Enhanced Language Support** – Complete Spanish / English / French localization
- ✅ **Timezone Fixes** – Proper handling of global timezones (Spain, USA, etc.)

---

## 📊 New Configuration Options

| Setting          | Type    | Range         | Default |
|------------------|---------|---------------|---------|
| `low_alert`      | slicer  | 40–90 mg/dL   | 70      |
| `high_alert`     | slicer  | 180–400 mg/dL | 180     |
| `update_interval`| slicer  | 30–600 sec    | 300     |

---

## 🌐 Internationalization

- 🌍 Auto-detects device language: `es`, `en`, `fr`
- 📦 Built-in multi-language support in `strings.ts`

---

## 🧪 Advanced Features

- 🔁 Real-time updates every `update_interval` seconds
- 📡 Uses Nightscout public API (no token required if CGM is shared)
- 📱 Clean text output optimized for G1 glasses readability

---

## ⚙️ How to Deploy

1. Clone this repo
2. Install dependencies: `npm install`
3. Start the app: `npm run start`
4. Set up your environment variables:

