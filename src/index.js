// ---- HARD SHIM (colócalo como PRIMERA línea del archivo) ----
if (typeof Object.prototype.updateSettingsForTesting !== 'function') {
  Object.defineProperty(Object.prototype, 'updateSettingsForTesting', {
    value: async function () { /* noop compat for older/newer SDKs */ },
    writable: true,
    configurable: true,
    enumerable: false
  });
}
// --------------------------------------------------------------



// src/index.js — Nightscout MentraOS v2.5.1 (ROBUST + FALLBACK + COMPAT SHIMS)

require('dotenv').config();
// ---------- PATCH para evitar error en updateSettingsForTesting ----------
try {
  const sdk = require("@mentra/sdk");
  if (!sdk.updateSettingsForTesting) {
    sdk.updateSettingsForTesting = () => {
      console.warn("⚠️ updateSettingsForTesting no soportado en esta versión del SDK");
    };
  }
} catch (err) {
  console.error("No se pudo cargar @mentra/sdk:", err);
}
// -------------------------------------------------------------------------


const { AppServer } = require('@mentra/sdk');
const axios = require('axios');

// ---- Log de versiones del SDK (para verificar qué paquete está en runtime)
try {
  const v1 = require('@mentra/sdk/package.json').version;
  console.log(`@mentra/sdk version at runtime: ${v1}`);
} catch {}
try {
  const v2 = require('amentra/sdk/package.json').version; // por si hay un paquete/fork “amentra”
  console.log(`amentra/sdk version at runtime: ${v2}`);
} catch {}

// ---- SHIMS DE COMPATIBILIDAD (prototipo) ----
// Añade updateSettingsForTesting si falta, tanto para @mentra como para amentra.
// Evita el TypeError en handlers internos de “settings update”.
try {
  const { AppSession } = require('@mentra/sdk');
  if (AppSession && typeof AppSession.prototype.updateSettingsForTesting !== 'function') {
    AppSession.prototype.updateSettingsForTesting = async function () {
      this.logger?.debug?.('Compat shim (@mentra): updateSettingsForTesting noop');
    };
  }
} catch {}
try {
  // Por si el runtime cargase “amentra/sdk”
  const { AppSession } = require('amentra/sdk');
  if (AppSession && typeof AppSession.prototype.updateSettingsForTesting !== 'function') {
    AppSession.prototype.updateSettingsForTesting = async function () {
      this.logger?.debug?.('Compat shim (amentra): updateSettingsForTesting noop');
    };
  }
} catch {}

// ---- Constantes de aplicación ----
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
  }

  /* ---------- helpers ---------- */
  parseSlicerValue(val, fallback) {
    const n = (typeof val === 'object' && val !== null) ? parseFloat(val.value) : parseFloat(val);
    return Number.isFinite(n) ? n : fallback;
  }

  validateSlicerValue(val, min, max, fallback) {
    const v = this.parseSlicerValue(val, fallback);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
  }

  /* ---------- Util para alarmas ---------- */
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

      const finalUrl = String(url || '').trim() || '';
      const finalToken = String(token || '').trim() || '';

      console.log(`🔍 Settings - URL:${finalUrl ? '[SET]' : '[EMPTY]'} Token:${finalToken ? '[SET]' : '[EMPTY]'} Units:${units || 'mg/dL'}`);

      return {
        nightscoutUrl: finalUrl,
        nightscoutToken: finalToken,
        updateInterval: this.parseSlicerValue(updateInterval, 5),
        low_alert_mg: this.validateSlicerValue(lowMg, 40, 90, 70),
        high_alert_mg: this.validateSlicerValue(highMg, 180, 400, 250),
        low_alert_mmol: this.validateSlicerValue(lowMmol, 2, 5, 3.9),
        high_alert_mmol: this.validateSlicerValue(highMmol, 8, 30, 13.9),
        alertsEnabled:
          alertsEnabled === true || alertsEnabled === 'true' ||
          alertsEnabled === 1 || alertsEnabled === '1',
        language: language || 'en',
        timezone: timezone || null,
        units: units || 'mg/dL'
      };
    } catch (e) {
      console.error('Error leyendo settings:', e);
      return {
        nightscoutUrl: '', nightscoutToken: '',
        updateInterval: 5,
        low_alert_mg: 70, high_alert_mg: 250,
        low_alert_mmol: 3.9, high_alert_mmol: 13.9,
        alertsEnabled: true, language: 'en', timezone: null, units: 'mg/dL'
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
      alertsEnabled:
        o.alerts_enabled === true || o.alerts_enabled === 'true' ||
        o.alerts_enabled === 1 || o.alerts_enabled === '1',
      language: o.language || 'en',
      timezone: o.timezone || null,
      units
    };
  }

  /* ---------- utils ---------- */
  convertToDisplay(mgdlValue, targetUnit) {
    if (targetUnit === UNITS.MMOL) {
      return (mgdlValue / 18).toFixed(1);
    }
    return Math.round(mgdlValue);
  }

  getTrendArrow(dir) {
    const map = {
      'DoubleUp': '⇈', 'SingleUp': '↑', 'FortyFiveUp': '↗',
      'Flat': '→', 'FortyFiveDown': '↘', 'SingleDown': '↓', 'DoubleDown': '⇊',
      'NONE': '-', 'NOT COMPUTABLE': '→', // mapea a Flat
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
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit'
    });

    const minutesAgo = Math.floor((Date.now() - data.date) / 60000);
    const lang = settings.language || 'en';
    const timeAgo = minutesAgo <= 1 ? (lang === 'es' ? 'ahora' : 'now')
      : (lang === 'es' ? `hace ${minutesAgo}m` : `${minutesAgo}m ago`);

    return `${display} ${settings.units} ${trend}\n${timeStr} (${timeAgo})`;
  }

  /* ---------- Data con fallbacks ---------- */
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
          params,
          timeout: 10000,
          headers: { 'User-Agent': 'MentraOS-Nightscout/2.5.1' },
        });

        const reading = Array.isArray(data) ? data[0] : data;
        if (!reading) throw new Error('Empty response');

        const glucoseRaw = (reading.sgv ?? reading.glucose);
        const glucose = Number(glucoseRaw);
        if (!Number.isFinite(glucose)) throw new Error('No glucose data found');

        const dateValue = reading.date || reading.dateString || reading.sysTime;
        if (!dateValue) throw new Error('No date found');

        const normalizedReading = {
          sgv: glucose,
          date: typeof dateValue === 'string' ? new Date(dateValue).getTime() : dateValue,
          direction: reading.direction || reading.trend || 'NONE'
        };

        console.log(`✅ Endpoint successful: ${endpoint}`);
        console.log(`📊 Data: ${glucose} ${normalizedReading.direction}`);
        return normalizedReading;

      } catch (error) {
        if (error?.response?.status === 404) {
          console.log(`⚠️ 404: ${endpoint}`);
        } else if (error?.code === 'ECONNABORTED') {
          console.log(`⏱️ Timeout: ${endpoint}`);
        } else {
          console.warn(`❌ ${endpoint} - ${error.message}`);
        }
        lastError = error;
        continue;
      }
    }

    throw new Error(`All endpoints failed. Last error: ${lastError?.message || 'unknown'}`);
  }

  /* ---------- session ---------- */
  async onSession(session, sessionId, userId) {
    console.log(`🚀 Nueva sesión: ${sessionId} para ${userId}`);

    // Shim por instancia (doble red: si el objeto session no trae el método)
    if (typeof session.updateSettingsForTesting !== 'function') {
      session.updateSettingsForTesting = async () => {
        session.logger?.debug?.('Compat shim: updateSettingsForTesting noop');
      };
    }

    session.logger?.info('Session started', { userId, sessionId });

    try {
      const settings = await this.getUserSettings(session);

      if (!settings.nightscoutUrl || !settings.nightscoutToken) {
        const msg = {
          en: 'Please configure Nightscout\nURL and token in settings',
          es: 'Configura URL y token\nde Nightscout en ajustes',
        };
        session.layouts.showTextWall(msg[settings.language] || msg.en);
        return;
      }

      // cache + handlers primero
      this.activeSessions.set(sessionId, { session, userId, settings });
      this.setupEventHandlers(session, sessionId, userId);

      // UI inicial + operación normal
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
      console.log(`✅ Mostrando datos iniciales: ${formattedData.replace('\n', ' ')}`);
      const t = setTimeout(() => this.hideDisplay(session, sessionId), 5000);
      this.displayTimers.set(sessionId, t);
    } catch (error) {
      console.error('❌ Error obteniendo datos iniciales:', error.message);

      let errorMsg;
      if (error.message.includes('URL no configurada')) {
        errorMsg = {
          en: 'Nightscout URL not set\nCheck settings',
          es: 'URL de Nightscout no configurada\nRevisa ajustes'
        };
      } else if (error.message.includes('Sin datos') || error.message.includes('timeout')) {
        errorMsg = {
          en: 'Cannot connect to Nightscout\nCheck URL and token',
          es: 'No se puede conectar\nRevisa URL y token'
        };
      } else {
        errorMsg = {
          en: 'Error loading glucose data\nCheck your settings',
          es: 'Error cargando datos\nRevisa tu configuración'
        };
      }

      const msg = errorMsg[settings.language] || errorMsg.en;
      session.layouts.showTextWall(msg);
      const t = setTimeout(() => this.hideDisplay(session, sessionId), 5000);
      this.displayTimers.set(sessionId, t);
    }
  }

  hideDisplay(session, sessionId) {
    try {
      session.layouts.showTextWall('');
    } catch {}
  }

  setupEventHandlers(session, sessionId, userId) {
    try {
      // Botón
      session.events?.onButtonPress?.(async () => {
        await this.showGlucoseTemporarily(session, sessionId, 10000);
      });

      // Handler común para updates de ajustes
      const settingsHandler = async (settingsData) => {
        session.logger?.info('Settings update received', { settingsCount: settingsData?.length });
        console.log('🎯 Received settings update for user', userId);

        try {
          const parsedSettings = this.parseSettingsFromArray(settingsData || []);
          const sessionData = this.activeSessions.get(sessionId);
          if (!sessionData) return;

          const oldSettings = sessionData.settings || {};

          if (oldSettings.units !== parsedSettings.units) {
            console.log(`🔄 Cambio de unidades: ${oldSettings.units} → ${parsedSettings.units}`);
            session.logger?.info('Units changed', { from: oldSettings.units, to: parsedSettings.units });
          }
          if (oldSettings.language !== parsedSettings.language) {
            console.log(`🌍 Cambio de idioma: ${oldSettings.language} → ${parsedSettings.language}`);
            session.logger?.info('Language changed', { from: oldSettings.language, to: parsedSettings.language });
          }

          // Reinicio de intervalo si cambia
          if (oldSettings.updateInterval !== parsedSettings.updateInterval) {
            console.log(`⏱️ Cambio de intervalo: ${oldSettings.updateInterval} → ${parsedSettings.updateInterval} min`);
            session.logger?.info('Update interval changed', { from: oldSettings.updateInterval, to: parsedSettings.updateInterval });
            if (sessionData.updateInterval) {
              clearInterval(sessionData.updateInterval);
              sessionData.updateInterval = null;
              console.log('🔄 Reiniciando timer con nuevo intervalo');
            }
            await this.startNormalOperation(session, sessionId, userId, parsedSettings);
          }

          // Limpiar historial de alertas si cambian límites
          if (this.alertLimitsChanged(oldSettings, parsedSettings)) {
            console.log('🔔 Límites de alerta cambiados, reiniciando historial');
            this.alertHistory.delete(sessionId);
            session.logger?.info('Alert limits changed, cleared alert history');
          }

          sessionData.settings = parsedSettings;
          this.activeSessions.set(sessionId, sessionData);
          console.log('✅ Settings updated successfully');
          session.logger?.info('Settings updated successfully');

        } catch (error) {
          console.error('❌ Error processing settings update:', error);
          session.logger?.error(error, 'Failed to process settings update');
        }
      };

      // Suscripción “amplia” (por compatibilidad con distintas builds)
      session.events?.onAppSettingsUpdate?.(settingsHandler);
      session.events?.onSettingsUpdate?.(settingsHandler);
      session.events?.onSettingsChange?.(settingsHandler);

      // Limpieza
      session.events?.onDisconnected?.(() => {
        session.logger?.info('Session disconnected');

        const timer = this.displayTimers.get(sessionId);
        if (timer) clearTimeout(timer);
        this.displayTimers.delete(sessionId);

        const sessionData = this.activeSessions.get(sessionId);
        if (sessionData?.updateInterval) clearInterval(sessionData.updateInterval);

        this.activeSessions.delete(sessionId);
        this.alertHistory.delete(sessionId);

        console.log(`🔌 Sesión ${sessionId} desconectada y limpiada`);
      });

    } catch (error) {
      console.error('❌ Error setting up event handlers:', error);
      session.logger?.error(error, 'Failed to setup event handlers');
    }
  }

  async showGlucoseTemporarily(session, sessionId, ms) {
    try {
      const sessionData = this.activeSessions.get(sessionId);
      if (!sessionData) return;

      const settings = await this.getUserSettings(sessionData.session);
      const data = await this.getGlucoseData(settings);
      session.layouts.showTextWall(await this.formatForG1(data, settings));

      const timer = setTimeout(() => this.hideDisplay(session, sessionId), ms);
      this.displayTimers.set(sessionId, timer);
    } catch (error) {
      session.logger?.error(error, 'Failed to show glucose temporarily');
    }
  }

  async startNormalOperation(session, sessionId, userId, settings) {
    const ms = settings.updateInterval * 60 * 1000;
    const iv = setInterval(async () => {
      if (!this.activeSessions.has(sessionId)) return clearInterval(iv);
      try {
        const s = await this.getUserSettings(session);
        const d = await this.getGlucoseData(s);
        if (s.alertsEnabled) await this.checkAlerts(session, sessionId, d, s);
      } catch (error) {
        session.logger?.debug('Normal operation cycle failed', { error: error.message });
      }
    }, ms);

    const sessionData = this.activeSessions.get(sessionId);
    if (sessionData) {
      sessionData.updateInterval = iv;
      this.activeSessions.set(sessionId, sessionData);
    }
  }

  async checkAlerts(session, sessionId, data, settings) {
    const limits = this.getAlertLimits(settings);
    const mgdl = data.sgv;
    const display = this.convertToDisplay(mgdl, settings.units);

    const last = this.alertHistory.get(sessionId);
    if (last && Date.now() - last < 600000) return; // 10 min

    const msgs = {
      en: {
        low: `🚨 LOW GLUCOSE!\n${display} ${settings.units}`,
        high: `🚨 HIGH GLUCOSE!\n${display} ${settings.units}`
      },
      es: {
        low: `🚨 ¡GLUCOSA BAJA!\n${display} ${settings.units}`,
        high: `🚨 ¡GLUCOSA ALTA!\n${display} ${settings.units}`
      }
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
      const timer = setTimeout(() => this.hideDisplay(session, sessionId), 15000);
      this.displayTimers.set(sessionId, timer);
      console.log(`🚨 Alerta enviada: ${msg.split('\n')[0]}`);
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
        for (const [sid, sData] of this.activeSessions) {
          if (sData.userId === userId) {
            settings = await this.getUserSettings(sData.session);
            break;
          }
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

      return {
        success: true,
        data: { glucose: display, unit: settings.units, trend, status },
        message: msg
      };

    } catch (e) {
      return {
        success: false,
        error: lang === 'es' ? `Error: ${e.message}` : `Error: ${e.message}`
      };
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

console.log('🚀 Nightscout MentraOS v2.5.1 — ROBUST + FALLBACK ENDPOINTS');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({
  status: 'alive',
  timestamp: new Date().toISOString(),
  version: '2.5.1',
  activeSessions: server.activeSessions.size
}));

setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);
