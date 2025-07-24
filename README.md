# 🚀 Nightscout for MentraOS – v2.4 Advanced Update

**Real-Time Glucose Monitoring for Even Realities G1 Smart Glasses**  
✨ Now with full slicer support, mmol/L detection & enhanced internationalization

---

## 🆕 What's New in v2.4

### 🔧 Critical Fixes & Enhancements

- ✅ **Fixed SDK compatibility errors** – No more `updateSettingsForTesting` issues  
- ✅ **Full Slicer Support** – Settings now work perfectly with MentraOS sliders  
- ✅ **mmol/L Auto-Detection** – Automatically detects units from Nightscout profile  
- ✅ **Enhanced Language Support** – Complete Spanish/English/French localization  
- ✅ **Timezone Fixes** – Proper handling of global timezones (Spain, USA, etc.)

---

## 📊 New Configuration Options

### Slider Settings (Fully Functional)

| Setting          | Type    | Range            | Default |
|------------------|---------|------------------|---------|
| `low_alert`      | slicer  | 40–90 mg/dL      | 70      |
| `high_alert`     | slicer  | 180–400 mg/dL    | 180     |
| `update_interval`| slicer  | 1–60 min         | 5       |

### Language & Timezone

- **Language**: Auto-detects from MentraOS settings  
- **Timezone**: Supports all major global zones  
- **Units**: `mg/dL` ↔ `mmol/L` automatic detection

---

## 🌍 International Support Enhanced

### 🇪🇸 Spanish Users

- **Comandos**: `Hey Mira, obtener mi glucosa`  
- **Alertas**: `🚨 ¡BAJA! 70 mg/dL`  
- **Timezone**: Europe/Madrid auto-detected  

### 🇺🇸 US Users

- **Commands**: `Hey Mira, get my glucose`  
- **Alerts**: `🚨 LOW! 70 mg/dL`  
- **Timezone**: America/Los_Angeles auto-detected  

### 🌎 Global Compatibility

- **mmol/L**: Automatic detection from Nightscout profile  
- **Timezone**: Full `Intl.DateTimeFormat` support  
- **Language**: Smart detection from user preferences  

---

## ⚙️ Updated MentraOS Configuration

### Required Settings (JSON)
```json
[
  {
    "key": "low_alert",
    "type": "slicer",
    "title": "Alerta Glucosa Baja",
    "min": 40,
    "max": 90,
    "default": 70
  },
  {
    "key": "high_alert",
    "type": "slicer",
    "title": "Alerta Glucosa Alta",
    "min": 180,
    "max": 400,
    "default": 180
  },
  {
    "key": "nightscout_url",
    "type": "string",
    "title": "Nightscout URL"
  },
  {
    "key": "nightscout_token",
    "type": "string",
    "title": "API Token"
  },
  {
    "key": "language",
    "type": "select",
    "title": "Language",
    "options": ["en", "es", "fr"],
    "default": "en"
  },
  {
    "key": "timezone",
    "type": "string",
    "title": "Timezone (auto-detected if empty)"
  }
]
