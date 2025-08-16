// src/index.js — Nightscout MentraOS v2.6.2
// SDK 2.1.18 — ROBUST + FALLBACK ENDPOINTS + HEAD-UP DISPLAY + MG/MMOL SYNC + SAFETY SHIMS

require('dotenv').config();

const { AppServer } = require('@mentra/sdk');
const axios = require('axios');

/* ---------- HARD SHIM: evita crash si el SDK invoca método inexistente ---------- */
// Mantener como PRIMER bloque del archivo.
if (typeof Object.prototype.updateSettingsForTesting !== 'function') {
  Object.defineProperty(Object.prototype, 'updateSettingsForTesting', {
    value: async function () { /* noop compat */ },
    writable: true,
    configurable: true,
    enumerable: false
  });
}
/* ------------------------------------------------------------------------------- */

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
    this.activeSessions = new Map();   // sessionId -> { session, userId, settings, updateInterval }
    this.alertHistory = new Map();     // sessionId -> timestamp
    this.displayTimers = new Map();    // sessionId -> timeoutId
    this.headUpLastShown = new Map();  // sessionId -> timestamp (cooldown)
  }

  /* ---------------- helpers ---------------- */
  parseSlicerValue(val, fallback) {
    const n = (typeof val === 'object' && val !== null) ? parseFloat(val.value) : parseFloat(val);
    return Number.isFinite(n) ? n : fallback;
  }
  validateSlicerValue(val, min, max, fallback) {
    const v = this.parseSlicerValue(val, fallback);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
  }

  // --- Helpers de sincronización mg/dL <-> mmol/L ---
  syncFromMmolToMg(mmol, min = 40, max = 400) {
    const mg = Math.round((Number(mmol) || 0) * 18);
    return Math.max(min, Math.min(max, mg));
  }
  syncFromMgToMmol(mg, min = 2, max = 30) {
    const mmol = Number(((Number(mg) || 0) / 18).toFixed(1));
    return Math.max(min, Math.min(max, mmol));
  }
  isDifferent(a, b, tol = 0.1) {
    return Math.abs(Number(a) - Number(b)) > tol;
  }

  /* ---------------- Util para alarmas ---------------- */
  getAlertLimits(settings) {
    if (settings.units === 'mmol/L') {
      return { low: Math.round(settings.low_alert_mmol * 18), high: Math.round(settings.high_alert_mmol * 18) };
    }
    return { low: Math.round(settings.low_alert_mg), high: Math.round(settings.high_alert_mg) };
  }

  /* ---------------- settings (lectura directa del store) ---------------- */
  async getUserSettings(session) {
    try {
      const [
        url, token, updateInterval,
        lowMg, highMg, lowMmol, highMmol,
        alertsEnabled, language, timezone, units,
        enable_head_up_display
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
        session.settings.get('units'),
        session.settings.get('enable_head_up_display')
      ]);

      const finalUrl = String(url || '').trim() || '';
      const finalToken = String(token || '').trim() || '';
      console.log(`🔍 Settings - URL:${finalUrl ? '[SET]' : '[EMPTY]'} Token:${finalToken ? '[SET]' : '[EMPTY]'} Units:${units || 'mg/dL'}`);

      const result = {
        nightscoutUrl: finalUrl,
        nightscoutToken: finalToken,
        updateInterval: this.parseSlicerValue(updateInterval, 5),
        low_alert_mg: this.validateSlicerValue(lowMg, 40, 90, 70),
        high_alert_mg: this.validateSlicerValue(highMg, 180, 400, 250),
        low_alert_mmol: this.validateSlicerValue(lowMmol, 2, 5, 3.9),
        high_alert_mmol: this.validateSlicerValue(highMmol, 8, 30, 13.9),
        alertsEnabled: (alertsEnabled === true || alertsEnabled === 'true' || alertsEnabled === 1 || alertsEnabled === '1'),
        language: language || 'en',
        timezone: timezone || null,
        units: units || 'mg/dL',
        enable_head_up_display: (enable_head_up_display === true || enable_head_up_display === 'true' || enable_head_up_display === 1 || enable_head_up_display === '1')
      };

      // --- Normalización/coherencia entre pares (para que la UI siempre muestre equivalentes) ---
      try {
        if (result.units === 'mmol/L') {
          const mgLow = this.syncFromMmolToMg(result.low_alert_mmol);
          const mgHigh = this.syncFromMmolToMg(result.high_alert_mmol);
          if (this.isDifferent(result.low_alert_mg, mgLow) || this.isDifferent(result.high_alert_mg, mgHigh)) {
            await Promise.all([
              session.settings.set('low_alert_mg', mgLow),
              session.settings.set('high_alert_mg', mgHigh),
            ]);
            result.low_alert_mg = mgLow;
            result.high_alert_mg = mgHigh;
          }
        } else { // mg/dL
          const mmolLow = this.syncFromMgToMmol(result.low_alert_mg);
          const mmolHigh = this.syncFromMgToMmol(result.high_alert_mg);
          if (this.isDifferent(result.low_alert_mmol, mmolLow) || this.isDifferent(result.high_alert_mmol, mmolHigh)) {
            await Promise.all([
              session.settings.set('low_alert_mmol', mmolLow),
              session.settings.set('high_alert_mmol', mmolHigh),
            ]);
            result.low_alert_mmol = mmolLow;
            result.high_alert_mmol = mmolHigh;
          }
        }
      } catch (e) {
        session?.logger?.debug?.('Sync (startup) skipped/failed', { err: e?.message });
      }

      return result;
    } catch (e) {
      console.error('Error leyendo settings:', e);
      return {
        nightscoutUrl: '', nightscoutToken: '',
        updateInterval: 5,
        low_alert_mg: 70, high_alert_mg: 250,
        low_alert_mmol: 3.9, high_alert_mmol: 13.9,
        alertsEnabled: true, language: 'en', timezone: null, units: 'mg/dL',
        enable_head_up_display: false
      };
    }
  }

  parseSettingsFromArray(arr) {
    const o = {};
    (arr || []).forEach(s => (o[s.key] = s.value));
    const units = o.units || 'mg/dL';
    console.log(`🔍 Settings parseados - Units:${units}`);

    return {
      nightscoutUrl: String(o.nightscout_url || '').trim() || '',
      nightscoutToken: String(o.nightscout_token || '').trim() || '',
      updateInterval: this.parseSlicerValue(o.update_interval, 5),
      low_alert_mg: this.validateSlicerValue(o.low_alert_mg, 40, 90, 70),
      high_alert_mg: this.validateSlicerValue(o.high_alert_mg, 180, 400, 250),
      low_alert_mmol: this.validateSlicerValue(o.low_alert_mmol, 2, 5, 3.9),
      high_alert_mmol: this.validateSlicerValue(o.high_alert_mmol, 8, 30, 13.9),
      alertsEnabled: (o.alerts_enabled === true || o.alerts_enabled === 'true' || o.alerts_enabled === 1 || o.alerts_enabled === '1'),
      language: o.language || 'en',
      timezone: o.timezone || null,
      units,
      enable_head_up_display: (o.enable_head_up_display === true || o.enable_head_up_display === 'true' || o.enable_head_up_display === 1 || o.enable_head_up_display === '1')
    };
  }

  /* ---------------- utils ---------------- */
  convertToDisplay(mgdlValue, targetUnit) {
    if (targetUnit === UNITS.MMOL) return (mgdlValue / 18).toFixed(1);
    return Math.round(mgdlValue);
  }
  getTrendArrow(dir) {
    const map = {
      'DoubleUp': '⇈', 'SingleUp': '↑', 'FortyFiveUp': '↗',
      'Flat': '→', 'FortyFiveDown': '↘', 'SingleDown': '↓', 'DoubleDown': '⇊',
      'NONE': '-', 'NOT COMPUTABLE': '→',
    };
    return map[dir] || '→';
  }
  getLanguageSettings(settings) {
    const langMap = {
      es: { locale: 'es-ES', timezone: 'Europe/Madrid' },
      en: { locale: 'en-US', timezone: 'America/New_York' },
    };
    return langMap[settings.language] || langMap['en'];
  }
  validateTimezone(tz) {
    const valid = [
      'Europe/Madrid', 'Atlantic/Canary', 'Europe/London', 'Europe/Paris',
      'Europe/Berlin', 'Europe/Rome', 'America/New_York', 'America/Chicago',
      'America/Los_Angeles', 'America/Mexico_City', 'America/Argentina/Buenos_Aires',
      'America/Sao_Paulo', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
    ];
    return valid.includes(tz) ? tz : 'UTC';
  }
  async formatForG1(data, settings) {
    const display = this.convertToDisplay(data.sgv, settings.units);
    const trend = this.getTrendArrow(data.direction);

    const langSettings = this.getLanguageSettings(settings);
    const timezone = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
    const readingTime = new Date(data.date);
    const timeStr = readingTime.toLocaleTimeString(langSettings.locale, {
      timeZone: timezone, hour: '2-digit', minute: '2-digit'
    });

    const minutesAgo = Math.floor((Date.now() - data.date) / 60000);
    const lang = settings.language || 'en';
    const timeAgo = minutesAgo <= 1 ? (lang === 'es' ? 'ahora' : 'now') : (lang === 'es' ? `hace ${minutesAgo}m` : `${minutesAgo}m ago`);

    return `${display} ${settings.units} ${trend}\n${timeStr} (${timeAgo})`;
  }

  /* ---------------- Data con fallbacks ---------------- */
  async getGlucoseData(settings) {
    let u = settings.nightscoutUrl;
    if (!u) throw new Error('URL no configurada');
    if (!u.startsWith('http')) u = 'https://' + u;
    u = u.replace(/\/$/, '');

    const endpoints = [
      `${u}/api/v1/entries/sgv.json?count=1`,
      `${u}/api/v1/entries.json?count=1`,
      `${u}/api/v1/entries/current.json`
    ];

    let lastError;
    for (const endpoint of endpoints) {
      try {
        console.log(`🔍 Trying endpoint: ${endpoint}`);
        const params = settings.nightscoutToken ? { token: settings.nightscoutToken } : {};
        const { data } = await axios.get(endpoint, {
          params, timeout: 10000, headers: { 'User-Agent': 'MentraOS-Nightscout/2.6.2' }
        });

        const reading = Array.isArray(data) ? data[0] : data;
        if (!reading) throw new Error('Empty response');

        const glucoseRaw = (reading.sgv ?? reading.glucose);
        const glucose = Number(glucoseRaw);
        if (!Number.isFinite(glucose)) throw new Error('No glucose data found');

        const dateValue = reading.date || reading.dateString || reading.sysTime;
        if (!dateValue) throw new Error('No date found');

        return {
          sgv: glucose,
          date: typeof dateValue === 'string' ? new Date(dateValue).getTime() : dateValue,
          direction: reading.direction || reading.trend || 'NONE'
        };
      } catch (error) {
        if (error?.response?.status === 404) console.log(`⚠️ 404: ${endpoint}`);
        else if (error?.code === 'ECONNABORTED') console.log(`⏱️ Timeout: ${endpoint}`);
        else console.warn(`❌ ${endpoint} - ${error.message}`);
        lastError = error;
        continue;
      }
    }
    throw new Error(`All endpoints failed. Last error: ${lastError?.message || 'unknown'}`);
  }

  /* ---------------- Ciclo de vida de sesión ---------------- */
  async onSession(session, sessionId, userId) {
    console.log(`🚀 Nueva sesión: ${sessionId} para ${userId}`);

    if (typeof session.updateSettingsForTesting !== 'function') {
      session.updateSettingsForTesting = async () => {
        session.logger?.debug?.('Compat shim: updateSettingsForTesting noop');
      };
    }

    session.logger?.info('Session started', { userId, sessionId });

    try {
      const settings = await this.getUserSettings(session);

      if (!settings.nightscoutUrl || !settings.nightscoutToken) {
        const msg = { en: 'Please configure Nightscout\nURL and token in settings', es: 'Configura URL y token\nde Nightscout en ajustes' };
        session.layouts.showTextWall(msg[settings.language] || msg.en);
        return;
      }

      this.activeSessions.set(sessionId, { session, userId, settings, updateInterval: null });
      this.setupEventHandlers(session, sessionId, userId);

      await this.showInitialAndHide(session, sessionId, settings);
      await this.startNormalOperation(session, sessionId, userId, settings);

    } catch (e) {
      session.logger?.error(e, 'Error en sesión');
      console.error('Error en sesión:', e);
      session.layouts.showTextWall('Error: Check app settings');
    }
  }

  async showInitialAndHide(session, sessionId, settings) {
    try {
      const data = await this.getGlucoseData(settings);
      const formattedData = await this.formatForG1(data, settings);
      session.layouts.showTextWall(formattedData);
      const t = setTimeout(() => this.hideDisplay(session, sessionId), 5000);
      this.displayTimers.set(sessionId, t);
    } catch (error) {
      const errorMsg =
        error.message.includes('URL no configurada') ? { en: 'Nightscout URL not set\nCheck settings', es: 'URL de Nightscout no configurada\nRevisa ajustes' } :
        (error.message.includes('Sin datos') || error.message.includes('timeout')) ? { en: 'Cannot connect to Nightscout\nCheck URL and token', es: 'No se puede conectar\nRevisa URL y token' } :
        { en: 'Error loading glucose data\nCheck your settings', es: 'Error cargando datos\nRevisa tu configuración' };
      const msg = errorMsg[settings.language] || errorMsg.en;
      session.layouts.showTextWall(msg);
      const t = setTimeout(() => this.hideDisplay(session, sessionId), 5000);
      this.displayTimers.set(sessionId, t);
    }
  }

  hideDisplay(session, sessionId) {
    try { session.layouts.showTextWall(''); } catch {}
  }

  /* ---------------- Handlers de eventos ---------------- */
  setupEventHandlers(session, sessionId, userId) {
    try {
      // Botón físico (tap)
      session.events?.onButtonPress?.(async () => {
        const sd = this.activeSessions.get(sessionId);
        const s = sd?.settings || await this.getUserSettings(session); // cache primero
        await this.showGlucoseTemporarily(session, sessionId, 10000, s);
      });

      // Cambios de ajustes (compatibilidad con varios nombres de evento)
      const settingsHandler = async (settingsData) => {
        session.logger?.info('Settings update received', { settingsCount: settingsData?.length });
        console.log('🎯 Received settings update for user', userId);

        try {
          const parsedSettings = this.parseSettingsFromArray(settingsData || []);
          const sessionData = this.activeSessions.get(sessionId);
          if (!sessionData) return;

          const oldSettings = sessionData.settings || {};

          if (oldSettings.units !== parsedSettings.units) {
            session.logger?.info('Units changed', { from: oldSettings.units, to: parsedSettings.units });
          }
          if (oldSettings.language !== parsedSettings.language) {
            session.logger?.info('Language changed', { from: oldSettings.language, to: parsedSettings.language });
          }
          if (oldSettings.updateInterval !== parsedSettings.updateInterval) {
            session.logger?.info('Update interval changed', { from: oldSettings.updateInterval, to: parsedSettings.updateInterval });
            if (sessionData.updateInterval) { clearInterval(sessionData.updateInterval); sessionData.updateInterval = null; }
            await this.startNormalOperation(session, sessionId, userId, parsedSettings);
          }
          if (this.alertLimitsChanged(oldSettings, parsedSettings)) {
            this.alertHistory.delete(sessionId);
            session.logger?.info('Alert limits changed, cleared alert history');
          }

          // --- Sincronización bidireccional según unidad activa ---
          try {
            if (parsedSettings.units === 'mmol/L') {
              const mgLowNew  = this.syncFromMmolToMg(parsedSettings.low_alert_mmol);
              const mgHighNew = this.syncFromMmolToMg(parsedSettings.high_alert_mmol);
              if (this.isDifferent(parsedSettings.low_alert_mg, mgLowNew) || this.isDifferent(parsedSettings.high_alert_mg, mgHighNew)) {
                await Promise.all([
                  session.settings.set('low_alert_mg', mgLowNew),
                  session.settings.set('high_alert_mg', mgHighNew),
                ]);
                parsedSettings.low_alert_mg  = mgLowNew;
                parsedSettings.high_alert_mg = mgHighNew;
              }
            } else { // mg/dL
              const mmolLowNew  = this.syncFromMgToMmol(parsedSettings.low_alert_mg);
              const mmolHighNew = this.syncFromMgToMmol(parsedSettings.high_alert_mg);
              if (this.isDifferent(parsedSettings.low_alert_mmol, mmolLowNew) || this.isDifferent(parsedSettings.high_alert_mmol, mmolHighNew)) {
                await Promise.all([
                  session.settings.set('low_alert_mmol', mmolLowNew),
                  session.settings.set('high_alert_mmol', mmolHighNew),
                ]);
                parsedSettings.low_alert_mmol  = mmolLowNew;
                parsedSettings.high_alert_mmol = mmolHighNew;
              }
            }
          } catch (e) {
            session.logger?.debug('Sync (onChange) skipped/failed', { err: e?.message });
          }

          // Cachea los nuevos settings (no dependas del store para re-lectura inmediata)
          sessionData.settings = parsedSettings;
          this.activeSessions.set(sessionId, sessionData);

          // Persistencia best-effort de los settings principales
          try {
            await Promise.all([
              session.settings.set('low_alert_mg', parsedSettings.low_alert_mg),
              session.settings.set('high_alert_mg', parsedSettings.high_alert_mg),
              session.settings.set('low_alert_mmol', parsedSettings.low_alert_mmol),
              session.settings.set('high_alert_mmol', parsedSettings.high_alert_mmol),
              session.settings.set('update_interval', parsedSettings.updateInterval),
              session.settings.set('alerts_enabled', !!parsedSettings.alertsEnabled),
              session.settings.set('units', parsedSettings.units),
              session.settings.set('language', parsedSettings.language),
              session.settings.set('timezone', parsedSettings.timezone || ''),
              session.settings.set('enable_head_up_display', !!parsedSettings.enable_head_up_display)
            ]);
          } catch (e) {
            session.logger?.debug('Store persistence skipped/failed', { err: e?.message });
          }

          // Eco visual breve — solo el par ACTIVO
          try {
            const lines = ['Ajustes guardados'];
            if (parsedSettings.units === 'mmol/L') {
              lines.push(`Low: ${parsedSettings.low_alert_mmol} mmol/L`);
              lines.push(`High: ${parsedSettings.high_alert_mmol} mmol/L`);
            } else {
              lines.push(`Low: ${parsedSettings.low_alert_mg} mg/dL`);
              lines.push(`High: ${parsedSettings.high_alert_mg} mg/dL`);
            }
            lines.push(`Units: ${parsedSettings.units}`);
            lines.push(`HeadUp: ${parsedSettings.enable_head_up_display ? 'ON' : 'OFF'}`);
            session.layouts.showTextWall(`\n${lines.join('\n')}`);
            setTimeout(() => this.hideDisplay(session, sessionId), 2000);
          } catch {}

        } catch (error) {
          console.error('❌ Error processing settings update:', error);
          session.logger?.error(error, 'Failed to process settings update');
        }
      };

      session.events?.onAppSettingsUpdate?.(settingsHandler);
      session.events?.onSettingsUpdate?.(settingsHandler);
      session.events?.onSettingsChange?.(settingsHandler);

      // HEAD-UP: mostrar al mirar ARRIBA (evita solapar HUD de hora/batería con saltos de línea)
      session.events?.onHeadPosition?.(async (data) => {
        try {
          if (data?.position !== 'up') return;

          const sd = this.activeSessions.get(sessionId);
          const s = sd?.settings;
          if (!s?.enable_head_up_display) return;

          // Cooldown 10 s
          const now = Date.now();
          const last = this.headUpLastShown.get(sessionId) || 0;
          if (now - last < 10_000) return;
          this.headUpLastShown.set(sessionId, now);

          const reading = await this.getGlucoseData(s);
          const text = await this.formatForG1(reading, s);
          session.layouts.showTextWall(`\n\n${text}`); // 2 saltos para no chocar con hora/batería
          setTimeout(() => this.hideDisplay(session, sessionId), 4000);
        } catch (e) {
          try { session.layouts.showTextWall('\n\nError al cargar'); } catch {}
          setTimeout(() => this.hideDisplay(session, sessionId), 2000);
        }
      });

      // Limpieza
      session.events?.onDisconnected?.(() => {
        const t = this.displayTimers.get(sessionId);
        if (t) clearTimeout(t);
        this.displayTimers.delete(sessionId);

        const sd = this.activeSessions.get(sessionId);
        if (sd?.updateInterval) clearInterval(sd.updateInterval);

        this.activeSessions.delete(sessionId);
        this.alertHistory.delete(sessionId);
        this.headUpLastShown.delete(sessionId);

        session.logger?.info('Session disconnected');
      });

    } catch (error) {
      console.error('❌ Error setting up event handlers:', error);
      session.logger?.error(error, 'Failed to setup event handlers');
    }
  }

  /* ---------------- Mostrar temporal con cache primero ---------------- */
  async showGlucoseTemporarily(session, sessionId, ms, providedSettings) {
    try {
      const sd = this.activeSessions.get(sessionId);
      if (!sd) return;
      const settings = providedSettings || sd.settings || await this.getUserSettings(sd.session);
      const data = await this.getGlucoseData(settings);
      session.layouts.showTextWall(await this.formatForG1(data, settings));
      const timer = setTimeout(() => this.hideDisplay(session, sessionId), ms);
      this.displayTimers.set(sessionId, timer);
    } catch (error) {
      session.logger?.error(error, 'Failed to show glucose temporarily');
    }
  }

  /* ---------------- Bucle normal (usa settings cache) ---------------- */
  async startNormalOperation(session, sessionId, userId, initialSettings) {
    const ms = (initialSettings.updateInterval || 5) * 60 * 1000;
    const iv = setInterval(async () => {
      if (!this.activeSessions.has(sessionId)) return clearInterval(iv);
      try {
        const sd = this.activeSessions.get(sessionId);
        const s = (sd && sd.settings) ? sd.settings : await this.getUserSettings(session);
        const d = await this.getGlucoseData(s);
        if (s.alertsEnabled) await this.checkAlerts(session, sessionId, d, s);
      } catch (error) {
        session.logger?.debug('Normal operation cycle failed', { error: error.message });
      }
    }, ms);

    const sessionData = this.activeSessions.get(sessionId);
    if (sessionData) {
      if (sessionData.updateInterval) clearInterval(sessionData.updateInterval);
      sessionData.updateInterval = iv;
      this.activeSessions.set(sessionId, sessionData);
    }
  }

  /* ---------------- Alertas ---------------- */
  async checkAlerts(session, sessionId, data, settings) {
    const limits = this.getAlertLimits(settings);
    const mgdl = data.sgv;
    const display = this.convertToDisplay(mgdl, settings.units);

    const last = this.alertHistory.get(sessionId);
    if (last && Date.now() - last < 600000) return; // 10 min

    const msgs = {
      en: { low: `🚨 LOW GLUCOSE!\n${display} ${settings.units}`, high: `🚨 HIGH GLUCOSE!\n${display} ${settings.units}` },
      es: { low: `🚨 ¡GLUCOSA BAJA!\n${display} ${settings.units}`, high: `🚨 ¡GLUCOSA ALTA!\n${display} ${settings.units}` }
    };
    const lang = settings.language || 'en';
    let msg = null;

    if (mgdl <= limits.low) { msg = msgs[lang]?.low || msgs.en.low; this.alertHistory.set(sessionId, Date.now()); }
    else if (mgdl >= limits.high) { msg = msgs[lang]?.high || msgs.en.high; this.alertHistory.set(sessionId, Date.now()); }

    if (msg) {
      session.layouts.showTextWall(msg);
      const timer = setTimeout(() => this.hideDisplay(session, sessionId), 15000);
      this.displayTimers.set(sessionId, timer);
      session.logger?.warn('Alert sent', { type: mgdl <= limits.low ? 'low' : 'high', value: mgdl });
    }
  }

  alertLimitsChanged(oldSettings, newSettings) {
    if (!oldSettings) return false;
    return (
      oldSettings.low_alert_mg !== newSettings.low_alert_mg ||
      oldSettings.high_alert_mg !== newSettings.high_alert_mg ||
      oldSettings.low_alert_mmol !== newSettings.low_alert_mmol ||
      oldSettings.high_alert_mmol !== newSettings.high_alert_mmol ||
      oldSettings.units !== newSettings.units
    );
  }

  /* ---------------- Tool calls (Mira) ---------------- */
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
        for (const [sid, sData] of this.activeSessions) {
          if (sData.userId === userId) { settings = sData.settings || await this.getUserSettings(sData.session); break; }
        }
      }

      if (!settings?.nightscoutUrl || !settings?.nightscoutToken) {
        throw new Error(lang === 'es' ? 'Nightscout no configurado' : 'Nightscout not configured');
      }

      const reading = await this.getGlucoseData(settings);
      const display = this.convertToDisplay(reading.sgv, settings.units);
      const trend = this.getTrendArrow(reading.direction);
      const status = this.getGlucoseStatusText(reading.sgv, settings, lang);

      const msg = lang === 'es'
        ? `Tu glucosa está en ${display} ${settings.units} ${trend}. Estado: ${status}.`
        : `Your glucose is ${display} ${settings.units} ${trend}. Status: ${status}.`;

      return { success: true, data: { glucose: display, unit: settings.units, trend, status }, message: msg };
    } catch (e) {
      return { success: false, error: lang === 'es' ? `Error: ${e.message}` : `Error: ${e.message}` };
    }
  }

  getGlucoseStatusText(value, settings, lang) {
    const limits = this.getAlertLimits(settings);
    if (value < 70) return lang === 'es' ? 'Crítico Bajo' : 'Critical Low';
    if (value <= limits.low) return lang === 'es' ? 'Bajo' : 'Low';
    if (value > 250) return lang === 'es' ? 'Crítico Alto' : 'Critical High';
    if (value >= limits.high) return lang === 'es' ? 'Alto' : 'High';
    return 'Normal';
  }
}

/* ---------------- init ---------------- */
const server = new NightscoutMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT,
});

server.start().catch(err => {
  console.error('❌ Error iniciando servidor:', err);
  process.exit(1);
});

console.log('🚀 Nightscout MentraOS v2.6.2 — ROBUST + FALLBACK + HEAD-UP + SYNC');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({
  status: 'alive',
  timestamp: new Date().toISOString(),
  version: '2.6.2',
  activeSessions: server.activeSessions.size
}));

setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);
