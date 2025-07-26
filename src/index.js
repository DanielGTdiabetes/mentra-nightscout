// src/index.js – Nightscout MentraOS v2.5.0 (DUAL-SLIDER UNITS)
require('dotenv').config();
const { AppServer } = require('@mentra/sdk');
const axios = require('axios');

const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.tucompania.nightscout-glucose';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

if (!MENTRAOS_API_KEY) {
  console.error('❌ MENTRAOS_API_KEY environment variable is required');
  process.exit(1);
}

const UNITS = { MGDL: 'mg/dL', MMOL: 'mmol/L' };

class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.activeSessions = new Map();
    this.alertHistory = new Map();
    this.displayTimers = new Map();
    this.userUnitsCache = new Map();
  }

  /* ---------- helpers ---------- */
  parseSlicerValue(val, fallback) {
    if (typeof val === 'object' && val !== null) return parseFloat(val.value) || fallback;
    return parseFloat(val) || fallback;
  }
  validateSlicerValue(val, min, max, fallback) {
    const v = this.parseSlicerValue(val, fallback);
    return Math.max(min, Math.min(max, v));
  }

  /* ---------- util para alarmas ---------- */
  getAlertLimits(settings) {
    if (settings.units === 'mmol/L') {
      return {
        low: Math.round(settings.low_alert_mmol * 18),
        high: Math.round(settings.high_alert_mmol * 18),
      };
    }
    return {
      low: Math.round(settings.low_alert_mg),
      high: Math.round(settings.high_alert_mg),
    };
  }

  /* ---------- settings ---------- */
  async getUserSettings(session) {
    try {
      const [
        url, token, updateInterval,
        lowMg, highMg, lowMmol, highMmol,
        alertsEnabled, language, timezone, units
      ] = await Promise.all([
        session.settings.get('nightscout_url'),
        session.settings.get('nightscout_token'),
        session.settings.get('update_interval'),
        session.settings.get('low_alert_mg'),
        session.settings.get('high_alert_mg'),
        session.settings.get('low_alert_mmol'),
        session.settings.get('high_alert_mmol'),
        session.settings.get('alerts_enabled'),
        session.settings.get('language'),
        session.settings.get('timezone'),
        session.settings.get('units')
      ]);

      const finalUrl   = String(url   || '').trim() || '';
      const finalToken = String(token || '').trim() || '';
      console.log(`🔍 Settings - URL:${finalUrl?'[SET]':'[EMPTY]'}  Token:${finalToken?'[SET]':'[EMPTY]'}  Units:${units||'mg/dL'}`);

      return {
        nightscoutUrl: finalUrl,
        nightscoutToken: finalToken,
        updateInterval: this.parseSlicerValue(updateInterval, 5),
        low_alert_mg:  this.parseSlicerValue(lowMg,   40, 600, 70),
        high_alert_mg: this.parseSlicerValue(highMg, 180, 600, 180),
        low_alert_mmol: this.validateSlicerValue(lowMmol, 2, 5, 4),
        high_alert_mmol: this.validateSlicerValue(highMmol, 8, 30, 10),
        alertsEnabled: alertsEnabled === true || alertsEnabled === 'true' || alertsEnabled === 1,
        language: language || 'en',
        timezone: timezone || null,
        units: units || 'mg/dL'
      };
    } catch (e) {
      console.error('Error leyendo settings:', e);
      return {
        nightscoutUrl: '', nightscoutToken: '',
        updateInterval: 5,
        low_alert_mg: 70, high_alert_mg: 180,
        low_alert_mmol: 4, high_alert_mmol: 10,
        alertsEnabled: true, language: 'en', timezone: null, units: 'mg/dL'
      };
    }
  }

  parseSettingsFromArray(arr) {
    const o = {};
    arr.forEach(s => (o[s.key] = s.value));
    const units = o.units || 'mg/dL';
    console.log(`🔍 Settings parseados - Units:${units}`);
    return {
      nightscoutUrl: String(o.nightscout_url || '').trim() || '',
      nightscoutToken: String(o.nightscout_token || '').trim() || '',
      updateInterval: this.parseSlicerValue(o.update_interval, 5),
      low_alert_mg:  this.parseSlicerValue(o.low_alert_mg,   40, 600, 70),
      high_alert_mg: this.parseSlicerValue(o.high_alert_mg, 180, 600, 180),
      low_alert_mmol: this.validateSlicerValue(o.low_alert_mmol, 2, 5, 4),
      high_alert_mmol: this.validateSlicerValue(o.high_alert_mmol, 8, 30, 10),
      alertsEnabled: o.alerts_enabled === true || o.alerts_enabled === 'true',
      language: o.language || 'en',
      timezone: o.timezone || null,
      units: units
    };
  }

  /* ---------- resto igual ---------- */
  async getGlucoseUnit(settings) { /* ... */ }
  convertToDisplay(v, unit) { return unit === UNITS.MMOL ? (v / 18).toFixed(1) : Math.round(v); }
  /* ... */

  async checkAlerts(session, sessionId, data, settings) {
    const limits = this.getAlertLimits(settings);
    const mgdl = data.sgv; // Nightscout siempre mg/dL
    const display = this.convertToDisplay(mgdl, settings.units);
    const last = this.alertHistory.get(sessionId);
    if (last && Date.now() - last < 600000) return;

    const msgs = {
      en: { low: `🚨 LOW!\n${display} ${settings.units}`, high: `🚨 HIGH!\n${display} ${settings.units}` },
      es: { low: `🚨 ¡BAJA!\n${display} ${settings.units}`, high: `🚨 ¡ALTA!\n${display} ${settings.units}` }
    };
    const lang = settings.language || 'en';
    let msg = null;
    if (mgdl <= limits.low) {
      msg = msgs[lang]?.low || msgs.en.low;
      this.alertHistory.set(sessionId, Date.now());
    } else if (mgdl >= limits.high) {
      msg = msgs[lang]?.high || msgs.en.high;
      this.alertHistory.set(sessionId, Date.now());
    }
    if (msg) {
      session.layouts.showTextWall(msg);
      setTimeout(() => this.hideDisplay(session, sessionId), 15000);
      this.displayTimers.set(sessionId, timer);
    }
  }

  /* ... resto sin cambios ... */
}

const server = new NightscoutMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT,
});

server.start().catch(err => {
  console.error('❌ Error iniciando servidor:', err);
  process.exit(1);
});

console.log('🚀 Nightscout MentraOS v2.5.0 – DUAL-SLIDER UNITS');
const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({ status: 'alive', timestamp: new Date().toISOString(), version: '2.5.0' }));
setInterval(() => axios.get(KEEP_ALIVE_URL).catch(() => {}), 3 * 60 * 1000);
