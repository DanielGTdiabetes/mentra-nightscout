// src/index.js – Nightscout MentraOS v2.4.3 (TOKEN-SAFE + SLIDER-SAFE)
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
    if (typeof val === 'object' && val !== null) return parseInt(val.value, 10) || fallback;
    return parseInt(val, 10) || fallback;
  }

  validateSlicerValue(val, min, max, fallback) {
    const v = this.parseSlicerValue(val, fallback);
    return Math.max(min, Math.min(max, v));
  }

  /* ---------- settings ---------- */
  async getUserSettings(session) {
    try {
      const [
        url,
        token,
        updateInterval,
        lowAlertSetting,
        highAlertSetting,
        alertsEnabled,
        language,
        timezone,
      ] = await Promise.all([
        session.settings.get('nightscout_url'),
        session.settings.get('nightscout_token'),
        session.settings.get('update_interval'),
        session.settings.get('low_alert'),
        session.settings.get('high_alert'),
        session.settings.get('alerts_enabled'),
        session.settings.get('language'),
        session.settings.get('timezone'),
      ]);

      return {
        nightscoutUrl: String(url || '').trim() || '',
        nightscoutToken: String(token || '').trim() || '',
        updateInterval: this.parseSlicerValue(updateInterval, 5),
        lowAlert: this.validateSlicerValue(lowAlertSetting, 40, 90, 70),
        highAlert: this.validateSlicerValue(highAlertSetting, 180, 400, 180),
        alertsEnabled: alertsEnabled === true || alertsEnabled === 'true' || alertsEnabled === 1,
        language: language || 'en',
        timezone: timezone || null,
      };
    } catch (e) {
      console.error('Error leyendo settings:', e);
      return {
        nightscoutUrl: '',
        nightscoutToken: '',
        updateInterval: 5,
        lowAlert: 70,
        highAlert: 180,
        alertsEnabled: true,
        language: 'en',
        timezone: null,
      };
    }
  }

  parseSettingsFromArray(arr) {
    const o = {};
    arr.forEach(s => (o[s.key] = s.value));
    return {
      nightscoutUrl: String(o.nightscout_url || '').trim() || '',
      nightscoutToken: String(o.nightscout_token || '').trim() || '',
      updateInterval: this.parseSlicerValue(o.update_interval, 5),
      lowAlert: this.validateSlicerValue(o.low_alert, 40, 90, 70),
      highAlert: this.validateSlicerValue(o.high_alert, 180, 400, 180),
      alertsEnabled: o.alerts_enabled === true || o.alerts_enabled === 'true',
      language: o.language || 'en',
      timezone: o.timezone || null,
    };
  }

  /* ---------- resto de lógica (sin cambios esenciales) ---------- */
  async getGlucoseUnit(settings) {
    const ck = `${settings.nightscoutUrl}_${settings.nightscoutToken}`;
    if (this.userUnitsCache.has(ck)) return this.userUnitsCache.get(ck);

    try {
      let u = settings.nightscoutUrl;
      if (!u) return UNITS.MGDL;
      if (!u.startsWith('http')) u = 'https://' + u;
      u = u.replace(/\/$/, '');
      const { data } = await axios.get(`${u}/api/v1/profile`, {
        params: { token: settings.nightscoutToken },
        timeout: 5000,
        headers: { 'User-Agent': 'MentraOS-Nightscout/1.0' },
      });
      let unit = UNITS.MGDL;
      if (data?.length && (data[0].store?.Default?.units === 'mmol' || data[0].units === 'mmol')) {
        unit = UNITS.MMOL;
      }
      this.userUnitsCache.set(ck, unit);
      return unit;
    } catch {
      this.userUnitsCache.set(ck, UNITS.MGDL);
      return UNITS.MGDL;
    }
  }

  convertToDisplay(v, unit) {
    return unit === UNITS.MMOL ? (v / 18).toFixed(1) : Math.round(v);
  }

  getTrendArrow(dir) {
    const map = {
      DoubleUp: '^^', SingleUp: '^', FortyFiveUp: '/',
      Flat: '→', FortyFiveDown: '\\', SingleDown: '↓', DoubleDown: '↓↓',
      NONE: '-', 'NOT COMPUTABLE': '?',
    };
    return map[dir] || '→';
  }

  async formatForG1(data, settings) {
    const unit = settings.glucoseUnit || UNITS.MGDL;
    const display = this.convertToDisplay(data.sgv, unit);
    const mgdl = unit === UNITS.MMOL ? parseFloat(display) * 18 : parseFloat(display);

    let sym = '*';
    if (mgdl < settings.lowAlert) sym = '!';
    else if (mgdl > settings.highAlert) sym = '^';

    const locale = { es: 'es-ES', en: 'en-US' }[settings.language] || 'en-US';
    const time = new Date(data.date || Date.now()).toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
    });

    return `${sym} ${display} ${unit}\n${time}`;
  }

  async getGlucoseData(settings) {
    let u = settings.nightscoutUrl;
    if (!u) throw new Error('URL no configurada');
    if (!u.startsWith('http')) u = 'https://' + u;
    u = u.replace(/\/$/, '');
    const { data } = await axios.get(`${u}/api/v1/entries/current.json`, {
      params: { token: settings.nightscoutToken },
      timeout: 10000,
      headers: { 'User-Agent': 'MentraOS-Nightscout/1.0' },
    });
    const reading = Array.isArray(data) ? data[0] : data;
    if (!reading?.sgv) throw new Error('Sin datos');
    return reading;
  }

  /* ---------- session & alerts ---------- */
  async onSession(session, sessionId, userId) {
    console.log(`🚀 Nueva sesión: ${sessionId} para ${userId}`);
    try {
      const settings = await this.getUserSettings(session);
      settings.glucoseUnit = await this.getGlucoseUnit(settings);

      if (!settings.nightscoutUrl || !settings.nightscoutToken) {
        const msg = {
          en: 'Please configure Nightscout\nURL and token in settings',
          es: 'Configura URL y token\nde Nightscout en ajustes',
        };
        session.layouts.showTextWall(msg[settings.language] || msg.en);
        return;
      }

      await this.showInitialAndHide(session, sessionId, settings);
      await this.startNormalOperation(session, sessionId, userId, settings);
      this.setupSafeEventHandlers(session, sessionId, userId);
    } catch (e) {
      console.error('Error en sesión:', e);
      session.layouts.showTextWall('Error: Check app settings');
    }
  }

  async showInitialAndHide(session, sessionId, settings) {
    try {
      const data = await this.getGlucoseData(settings);
      session.layouts.showTextWall(await this.formatForG1(data, settings));
      setTimeout(() => this.hideDisplay(session, sessionId), 5000);
    } catch {}
  }

  hideDisplay(session) {
    try {
      session.layouts.showTextWall('');
    } catch {}
  }

  setupSafeEventHandlers(session, sessionId, userId) {
    try {
      session.events?.onButtonPress?.(async () => {
        await this.showGlucoseTemporarily(session, sessionId, 10000);
      });
      session.events?.onDisconnected?.(() => {
        const timer = this.displayTimers.get(sessionId);
        if (timer) clearTimeout(timer);
        this.displayTimers.delete(sessionId);

        const us = this.activeSessions.get(sessionId);
        if (us?.updateInterval) clearInterval(us.updateInterval);

        this.activeSessions.delete(sessionId);
        this.alertHistory.delete(sessionId);
      });
    } catch {}
  }

  async showGlucoseTemporarily(session, sessionId, ms) {
    try {
      const { settings } = this.activeSessions.get(sessionId);
      const data = await this.getGlucoseData(settings);
      session.layouts.showTextWall(await this.formatForG1(data, settings));
      const timer = setTimeout(() => this.hideDisplay(session, sessionId), ms);
      this.displayTimers.set(sessionId, timer);
    } catch {}
  }

  async startNormalOperation(session, sessionId, userId, settings) {
    this.activeSessions.set(sessionId, { session, userId, settings });
    const ms = settings.updateInterval * 60 * 1000;
    const iv = setInterval(async () => {
      if (!this.activeSessions.has(sessionId)) return clearInterval(iv);
      try {
        const s = await this.getUserSettings(session);
        s.glucoseUnit = await this.getGlucoseUnit(s);
        const d = await this.getGlucoseData(s);
        if (s.alertsEnabled) await this.checkAlerts(session, sessionId, d, s);
      } catch {}
    }, ms);
    this.activeSessions.get(sessionId).updateInterval = iv;
  }

  async checkAlerts(session, sessionId, data, settings) {
    const unit = settings.glucoseUnit || UNITS.MGDL;
    const display = this.convertToDisplay(data.sgv, unit);
    const mgdl = unit === UNITS.MMOL ? parseFloat(display) * 18 : parseFloat(display);

    const last = this.alertHistory.get(sessionId);
    if (last && Date.now() - last < 600000) return;

    const msgs = {
      en: { low: `🚨 LOW!\n${display} ${unit}`, high: `🚨 HIGH!\n${display} ${unit}` },
      es: { low: `🚨 ¡BAJA!\n${display} ${unit}`, high: `🚨 ¡ALTA!\n${display} ${unit}` },
    };
    const lang = settings.language || 'en';
    let msg = null;
    if (mgdl < settings.lowAlert) {
      msg = msgs[lang]?.low || msgs.en.low;
      this.alertHistory.set(sessionId, Date.now());
    } else if (mgdl > settings.highAlert) {
      msg = msgs[lang]?.high || msgs.en.high;
      this.alertHistory.set(sessionId, Date.now());
    }
    if (msg) {
      session.layouts.showTextWall(msg);
      const timer = setTimeout(() => this.hideDisplay(session, sessionId), 15000);
      this.displayTimers.set(sessionId, timer);
    }
  }

  /* ---------- tool call ---------- */
  async onToolCall(data) {
    const toolId = data.toolId || data.toolName;
    const userId = data.userId;
    const activeSession = data.activeSession;

    const isSpanish = ['obtener_glucosa', 'revisar_glucosa', 'nivel_glucosa', 'mi_glucosa'].includes(toolId);
    const lang = isSpanish ? 'es' : 'en';

    try {
      let settings = null;
      if (activeSession?.settings?.settings) {
        settings = this.parseSettingsFromArray(activeSession.settings.settings);
      } else {
        for (const [sid, data] of this.activeSessions) {
          if (data.userId === userId) {
            settings = await this.getUserSettings(data.session);
            break;
          }
        }
      }
      if (!settings?.nightscoutUrl || !settings?.nightscoutToken) {
        throw new Error(lang === 'es' ? 'Nightscout no configurado' : 'Nightscout not configured');
      }

      settings.glucoseUnit = await this.getGlucoseUnit(settings);
      const data = await this.getGlucoseData(settings);
      const display = this.convertToDisplay(data.sgv, settings.glucoseUnit);
      const trend = this.getTrendArrow(data.direction);
      const status = this.getGlucoseStatusText(data.sgv, settings, lang);
      const msg =
        lang === 'es'
          ? `Tu glucosa está en ${display} ${settings.glucoseUnit} ${trend}. Estado: ${status}.`
          : `Your glucose is ${display} ${settings.glucoseUnit} ${trend}. Status: ${status}.`;
      return { success: true, data: { glucose: display, unit: settings.glucoseUnit, trend, status }, message: msg };
    } catch (e) {
      return { success: false, error: lang === 'es' ? `Error: ${e.message}` : `Error: ${e.message}` };
    }
  }

  getGlucoseStatusText(value, settings, lang) {
    const mgdl = settings.glucoseUnit === UNITS.MMOL ? value * 18 : value;
    if (mgdl < 70) return lang === 'es' ? 'Crítico Bajo' : 'Critical Low';
    if (mgdl < settings.lowAlert) return lang === 'es' ? 'Bajo' : 'Low';
    if (mgdl > 250) return lang === 'es' ? 'Crítico Alto' : 'Critical High';
    if (mgdl > settings.highAlert) return lang === 'es' ? 'Alto' : 'High';
    return 'Normal';
  }
}

/* ---------- init ---------- */
const server = new NightscoutMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT,
});

server.start().catch(err => {
  console.error('❌ Error iniciando servidor:', err);
  process.exit(1);
});

console.log('🚀 Nightscout MentraOS v2.4.3 – TOKEN + SLIDER SAFE');

/* ---------- keep-alive ---------- */
const KEEP_ALIVE_URL = process.env.RENDER_URL || `https://mentra-nightscout.onrender.com`;
server.app.get('/health', (_, res) => res.json({ status: 'alive', timestamp: new Date().toISOString(), version: '2.4.3' }));
setInterval(() => axios.get(KEEP_ALIVE_URL).catch(() => {}), 3 * 60 * 1000);
