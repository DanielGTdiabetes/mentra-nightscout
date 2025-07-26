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
    this.updateTimers = new Map();
  }

  /* ---------- Helpers ---------- */
  parseSlicerValue(val, fallback) {
    if (typeof val === 'object' && val !== null) return parseFloat(val.value) || fallback;
    return parseFloat(val) || fallback;
  }

  validateSlicerValue(val, min, max, fallback) {
    const v = this.parseSlicerValue(val, fallback);
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

  /* ---------- Settings ---------- */
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
      console.log(`🔍 Settings - URL:${finalUrl ? '[SET]' : '[EMPTY]'}  Token:${finalToken ? '[SET]' : '[EMPTY]'}  Units:${units || 'mg/dL'}`);

      return {
        nightscoutUrl: finalUrl,
        nightscoutToken: finalToken,
        updateInterval: this.parseSlicerValue(updateInterval, 5),
        low_alert_mg: this.validateSlicerValue(lowMg, 40, 90, 70),
        high_alert_mg: this.validateSlicerValue(highMg, 180, 400, 250),
        low_alert_mmol: this.validateSlicerValue(lowMmol, 2, 5, 3.9),
        high_alert_mmol: this.validateSlicerValue(highMmol, 8, 30, 13.9),
        alertsEnabled: alertsEnabled === true || alertsEnabled === 'true' || alertsEnabled === 1,
        language: language || 'en',
        timezone: timezone || 'Europe/Madrid',
        units: units || 'mg/dL'
      };
    } catch (e) {
      console.error('Error leyendo settings:', e);
      return {
        nightscoutUrl: '', nightscoutToken: '',
        updateInterval: 5,
        low_alert_mg: 70, high_alert_mg: 250,
        low_alert_mmol: 3.9, high_alert_mmol: 13.9,
        alertsEnabled: true, language: 'en', timezone: 'Europe/Madrid', units: 'mg/dL'
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
      low_alert_mg: this.validateSlicerValue(o.low_alert_mg, 40, 90, 70),
      high_alert_mg: this.validateSlicerValue(o.high_alert_mg, 180, 400, 250),
      low_alert_mmol: this.validateSlicerValue(o.low_alert_mmol, 2, 5, 3.9),
      high_alert_mmol: this.validateSlicerValue(o.high_alert_mmol, 8, 30, 13.9),
      alertsEnabled: o.alerts_enabled === true || o.alerts_enabled === 'true',
      language: o.language || 'en',
      timezone: o.timezone || 'Europe/Madrid',
      units: units
    };
  }

  /* ---------- Conversión y formato ---------- */
  convertToDisplay(mgdlValue, targetUnit) {
    if (targetUnit === UNITS.MMOL) {
      return (mgdlValue / 18).toFixed(1);
    }
    return Math.round(mgdlValue);
  }

  getTrendArrow(trend) {
    const arrows = {
      'Flat': '→',
      'FortyFiveUp': '↗',
      'SingleUp': '↑',
      'DoubleUp': '⇈',
      'FortyFiveDown': '↘',
      'SingleDown': '↓',
      'DoubleDown': '⇊'
    };
    return arrows[trend] || '→';
  }

  formatTime(date, timezone) {
    try {
      return new Intl.DateTimeFormat('es-ES', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(date);
    } catch (e) {
      return new Date(date).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
  }

  /* ---------- Nightscout API ---------- */
  async fetchGlucoseData(settings) {
    if (!settings.nightscoutUrl || !settings.nightscoutToken) {
      throw new Error('URL de Nightscout o token no configurados');
    }

    const url = `${settings.nightscoutUrl}/api/v1/entries.json?count=1&token=${settings.nightscoutToken}`;
    
    try {
      console.log('🔄 Fetching from Nightscout...');
      const response = await axios.get(url, { timeout: 10000 });
      const data = response.data;

      if (!data || data.length === 0) {
        throw new Error('No se encontraron datos de glucosa');
      }

      const entry = data[0];
      const ageMinutes = Math.round((Date.now() - entry.date) / 60000);

      return {
        sgv: entry.sgv,
        trend: entry.trend || entry.direction,
        date: new Date(entry.date),
        ageMinutes: ageMinutes,
        isStale: ageMinutes > 15
      };
    } catch (error) {
      console.error('❌ Error fetching Nightscout data:', error.message);
      throw error;
    }
  }

  /* ---------- Display y UI ---------- */
  async updateDisplay(session, sessionId, settings) {
    try {
      const data = await this.fetchGlucoseData(settings);
      const displayValue = this.convertToDisplay(data.sgv, settings.units);
      const arrow = this.getTrendArrow(data.trend);
      const currentTime = this.formatTime(new Date(), settings.timezone);

      let statusIcon = '🟢';
      const limits = this.getAlertLimits(settings);
      
      if (data.sgv <= limits.low) statusIcon = '🔴';
      else if (data.sgv >= limits.high) statusIcon = '🟡';
      else if (data.isStale) statusIcon = '⚪';

      // Dashboard principal con unidades actuales
      const mainContent = `${statusIcon} ${displayValue} ${settings.units} ${arrow}`;
      session.dashboard.content.writeToMain(mainContent);

      // Dashboard expandido con información localizada
      let expandedContent;
      if (settings.language === 'es') {
        expandedContent = `🩸 Glucosa: ${displayValue} ${settings.units} ${arrow}
🕐 Hora: ${currentTime}
📊 Última lectura: hace ${data.ageMinutes} min
⚠️ Alerta baja: ${settings.units === 'mg/dL' ? settings.low_alert_mg : settings.low_alert_mmol} ${settings.units}
⚠️ Alerta alta: ${settings.units === 'mg/dL' ? settings.high_alert_mg : settings.high_alert_mmol} ${settings.units}
${data.isStale ? '⚠️ Datos obsoletos' : '✅ Datos actuales'}`;
      } else {
        expandedContent = `🩸 Glucose: ${displayValue} ${settings.units} ${arrow}
🕐 Time: ${currentTime}
📊 Last reading: ${data.ageMinutes} min ago
⚠️ Low alert: ${settings.units === 'mg/dL' ? settings.low_alert_mg : settings.low_alert_mmol} ${settings.units}
⚠️ High alert: ${settings.units === 'mg/dL' ? settings.high_alert_mg : settings.high_alert_mmol} ${settings.units}
${data.isStale ? '⚠️ Stale data' : '✅ Current data'}`;
      }
      
      session.dashboard.content.writeToExpanded(expandedContent);

      // Verificar alarmas con configuración actual
      if (settings.alertsEnabled) {
        await this.checkAlerts(session, sessionId, data, settings);
      }

      console.log(`✅ Display actualizado - ${displayValue} ${settings.units} ${arrow} (${settings.language}, ${settings.timezone})`);

    } catch (error) {
      console.error(`❌ Error actualizando display:`, error.message);
      
      const currentTime = this.formatTime(new Date(), settings.timezone);
      const errorMsg = settings.language === 'es' ? '❌ Error conexión' : '❌ Connection error';
      const detailMsg = settings.language === 'es' 
        ? `❌ Error de conexión\n🕐 Hora: ${currentTime}\n🔧 Revisa configuración Nightscout`
        : `❌ Connection error\n🕐 Time: ${currentTime}\n🔧 Check Nightscout configuration`;
      
      session.dashboard.content.writeToMain(errorMsg);
      session.dashboard.content.writeToExpanded(detailMsg);
    }
  }

  async checkAlerts(session, sessionId, data, settings) {
    const limits = this.getAlertLimits(settings);
    const mgdl = data.sgv;
    const display = this.convertToDisplay(mgdl, settings.units);
    const last = this.alertHistory.get(sessionId);
    
    // Evitar spam de alertas (10 minutos)
    if (last && Date.now() - last < 600000) return;

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
    }
  }

  hideDisplay(session, sessionId) {
    try {
      session.layouts.clearAll();
      const timer = this.displayTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.displayTimers.delete(sessionId);
      }
    } catch (e) {
      console.error('Error ocultando display:', e);
    }
  }

  /* ---------- Gestión de sesiones ---------- */
  async onSession(session, sessionId, userId) {
    console.log(`👤 Nueva sesión: ${sessionId} (User: ${userId})`);
    
    try {
      this.activeSessions.set(sessionId, {
        session,
        userId,
        startTime: Date.now()
      });

      // Obtener configuración del usuario
      const settings = await this.getUserSettings(session);
      console.log(`⚙️ Configuración cargada para ${sessionId}:`);
      console.log(`   - Idioma: ${settings.language}`);
      console.log(`   - Timezone: ${settings.timezone}`);
      console.log(`   - Unidades: ${settings.units}`);
      console.log(`   - Alarmas: ${settings.alertsEnabled ? 'Activadas' : 'Desactivadas'}`);
      
      // Guardar configuración en cache
      this.userUnitsCache.set(sessionId, settings);

      // Mostrar datos iniciales inmediatamente
      await this.updateDisplay(session, sessionId, settings);

      // Configurar actualizaciones automáticas
      const updateInterval = settings.updateInterval * 60 * 1000; // minutos a ms
      const timer = setInterval(async () => {
        if (this.activeSessions.has(sessionId)) {
          const currentSettings = await this.getUserSettings(session);
          // Actualizar cache si hay cambios
          this.userUnitsCache.set(sessionId, currentSettings);
          await this.updateDisplay(session, sessionId, currentSettings);
        } else {
          clearInterval(timer);
        }
      }, updateInterval);

      this.updateTimers.set(sessionId, timer);
      console.log(`⏰ Timer configurado para ${sessionId} cada ${settings.updateInterval} min`);

    } catch (error) {
      console.error(`❌ Error en onSession ${sessionId}:`, error);
      session.dashboard.content.writeToMain('❌ Error configuración');
    }
  }

  async onSessionEnd(sessionId, userId) {
    console.log(`👋 Sesión terminada: ${sessionId}`);
    
    // Limpiar timers
    const updateTimer = this.updateTimers.get(sessionId);
    if (updateTimer) {
      clearInterval(updateTimer);
      this.updateTimers.delete(sessionId);
    }

    const displayTimer = this.displayTimers.get(sessionId);
    if (displayTimer) {
      clearTimeout(displayTimer);
      this.displayTimers.delete(sessionId);
    }

    // Limpiar datos
    this.activeSessions.delete(sessionId);
    this.alertHistory.delete(sessionId);
  }

  async onSettingsChange(session, sessionId, settings) {
    console.log(`⚙️ Configuración cambiada para ${sessionId}`);
    
    try {
      const parsedSettings = this.parseSettingsFromArray(settings);
      
      // Log cambios importantes
      const oldSettings = this.userUnitsCache.get(sessionId) || {};
      if (oldSettings.units !== parsedSettings.units) {
        console.log(`🔄 Cambio de unidades: ${oldSettings.units} → ${parsedSettings.units}`);
      }
      if (oldSettings.language !== parsedSettings.language) {
        console.log(`🌐 Cambio de idioma: ${oldSettings.language} → ${parsedSettings.language}`);
      }
      if (oldSettings.timezone !== parsedSettings.timezone) {
        console.log(`🌍 Cambio de timezone: ${oldSettings.timezone} → ${parsedSettings.timezone}`);
      }
      
      // Actualizar cache de configuración
      this.userUnitsCache.set(sessionId, parsedSettings);
      
      // Limpiar historial de alertas si cambiaron los límites
      if (this.alertLimitsChanged(oldSettings, parsedSettings)) {
        console.log(`🔔 Límites de alerta cambiados, reiniciando historial`);
        this.alertHistory.delete(sessionId);
      }
      
      // Actualizar display inmediatamente con nueva configuración
      await this.updateDisplay(session, sessionId, parsedSettings);
      
      // Reiniciar timer solo si cambió el intervalo
      if (oldSettings.updateInterval !== parsedSettings.updateInterval) {
        const oldTimer = this.updateTimers.get(sessionId);
        if (oldTimer) {
          clearInterval(oldTimer);
        }

        const updateInterval = parsedSettings.updateInterval * 60 * 1000;
        const newTimer = setInterval(async () => {
          if (this.activeSessions.has(sessionId)) {
            const currentSettings = await this.getUserSettings(session);
            await this.updateDisplay(session, sessionId, currentSettings);
          } else {
            clearInterval(newTimer);
          }
        }, updateInterval);

        this.updateTimers.set(sessionId, newTimer);
        console.log(`⏰ Timer reconfigurado para ${sessionId} cada ${parsedSettings.updateInterval} min`);
      }

    } catch (error) {
      console.error(`❌ Error en onSettingsChange ${sessionId}:`, error);
    }
  }

  // Nuevo método para detectar cambios en límites de alerta
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

  /* ---------- Herramientas de voz ---------- */
  async onToolCall(session, sessionId, toolId, parameters) {
    console.log(`🔧 Tool llamada: ${toolId} para sesión ${sessionId}`);
    
    try {
      const settings = await this.getUserSettings(session);
      
      if (['get_glucose', 'obtener_glucosa', 'check_glucose', 'revisar_glucosa'].includes(toolId)) {
        const data = await this.fetchGlucoseData(settings);
        const displayValue = this.convertToDisplay(data.sgv, settings.units);
        const arrow = this.getTrendArrow(data.trend);
        const currentTime = this.formatTime(new Date(), settings.timezone);

        const isSpanish = toolId.includes('obtener') || toolId.includes('revisar');
        
        let response;
        if (isSpanish) {
          response = `Tu glucosa actual es ${displayValue} ${settings.units} ${arrow}. Son las ${currentTime}.`;
          if (data.ageMinutes > 15) {
            response += ` Atención: los datos tienen ${data.ageMinutes} minutos de antigüedad.`;
          }
        } else {
          response = `Your current glucose is ${displayValue} ${settings.units} ${arrow}. It's ${currentTime}.`;
          if (data.ageMinutes > 15) {
            response += ` Note: data is ${data.ageMinutes} minutes old.`;
          }
        }

        return { response };
      }

    } catch (error) {
      console.error(`❌ Error en tool ${toolId}:`, error);
      const isSpanish = toolId.includes('obtener') || toolId.includes('revisar');
      return { 
        response: isSpanish 
          ? 'Lo siento, no puedo obtener los datos de glucosa en este momento. Revisa tu configuración de Nightscout.'
          : 'Sorry, I cannot get glucose data right now. Please check your Nightscout configuration.'
      };
    }
  }
}

// Inicialización del servidor
const server = new NightscoutMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT,
});

server.start().catch(err => {
  console.error('❌ Error iniciando servidor:', err);
  process.exit(1);
});

console.log('🚀 Nightscout MentraOS v2.5.0 – DUAL-SLIDER UNITS iniciado');

// Health check y keep-alive
const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({ 
  status: 'alive', 
  timestamp: new Date().toISOString(), 
  version: '2.5.0',
  activeSessions: server.activeSessions.size
}));

// Keep-alive cada 3 minutos
setInterval(() => {
  axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {});
}, 3 * 60 * 1000);
