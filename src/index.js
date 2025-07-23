// src/index.js – Nightscout MentraOS App (G1b)
// Unificado: mismo comportamiento que tu original + fixes de idioma/horario dinámicos,
// listener fiable, limpieza correcta y hora de medición real.

const { AppServer } = require('@mentra/sdk');
const axios = require('axios');
require('dotenv').config();

const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.tucompania.nightscout-glucose';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

if (!MENTRAOS_API_KEY) {
  console.error('❌ MENTRAOS_API_KEY environment variable is required');
  process.exit(1);
}

class NightscoutMentraApp extends AppServer {
  constructor(options) {
    super(options);
    this.activeSessions = new Map(); // sessionId -> { session, userId, settings, updateInterval, settingsPolling, autoCleanupTimeout }
    this.alertHistory = new Map();   // sessionId -> ts last alert
    this.displayTimers = new Map();  // sessionId -> timeout for temporary display
  }

  // ===================== ENTRY POINT SESIÓN =====================
  async onSession(session, sessionId, userId) {
    session.logger.info(`Nueva sesión oficial: ${sessionId} para ${userId}`);

    try {
      // === DIAGNÓSTICO DE SETTINGS (tu bloque original) ===
      session.logger.info('=== DIAGNÓSTICO DE SETTINGS ===');
      try {
        const url = await session.settings.get('nightscout_url');
        session.logger.info(`URL setting: "${url}" (type: ${typeof url})`);
      } catch (e) { session.logger.error('Error getting URL setting:', e); }

      try {
        const token = await session.settings.get('nightscout_token');
        session.logger.info(`Token setting: "${token ? token.substring(0, 8) + '***' : null}" (type: ${typeof token})`);
      } catch (e) { session.logger.error('Error getting token setting:', e); }

      try {
        const lowAlert = await session.settings.get('low_alert');
        const highAlert = await session.settings.get('high_alert');
        session.logger.info(`🔔 Alertas configuradas - Baja: ${lowAlert}, Alta: ${highAlert}`);
      } catch (e) { session.logger.error('Error getting alert settings:', e); }
      session.logger.info('=== FIN DIAGNÓSTICO ===');

      // Cargar settings validados
      const userSettings = await this.getUserSettings(session);
      session.logger.info('Settings finales obtenidos:', {
        hasUrl: !!userSettings.nightscoutUrl,
        hasToken: !!userSettings.nightscoutToken,
        language: userSettings.language,
        lowAlert: userSettings.lowAlert,
        highAlert: userSettings.highAlert,
        timezone: userSettings.timezone
      });

      if (!userSettings.nightscoutUrl || !userSettings.nightscoutToken) {
        await this.showConfigurationNeeded(session, userSettings);
        return;
      }

      await this.showInitialAndHide(session, sessionId, userSettings);
      await this.startNormalOperation(session, sessionId, userId, userSettings);

      this.setupSafeEventHandlers(session, sessionId, userId);
      this.setupSettingsListener(session, sessionId, userId);
    } catch (error) {
      session.logger.error(`Error en sesión: ${error.message}`);
      session.layouts.showTextWall('Error: Check app settings\nin MentraOS app');
    }
  }

  // -------- Display inicial y ocultar --------
  async showInitialAndHide(session, sessionId, userSettings) {
    try {
      const glucoseData = await this.getGlucoseData(userSettings);
      const displayText = this.formatForG1(glucoseData, userSettings);
      session.layouts.showTextWall(displayText);
      session.logger.info('✅ Datos iniciales mostrados');
      setTimeout(() => this.hideDisplay(session, sessionId), 5000);
    } catch (error) {
      session.logger.error('Error en display inicial:', error);
    }
  }

  hideDisplay(session, sessionId) {
    try {
      session.layouts.showTextWall('');
      session.logger.info(`🙈 Display ocultado para sesión ${sessionId}`);
    } catch (error) {
      session.logger.error('Error ocultando display:', error);
    }
  }

  async showGlucoseTemporarily(session, sessionId, duration = 8000) {
    try {
      const sData = this.activeSessions.get(sessionId);
      const userSettings = sData ? sData.settings : await this.getUserSettings(session);
      const glucoseData = await this.getGlucoseData(userSettings);
      const displayText = this.formatForG1(glucoseData, userSettings);

      session.layouts.showTextWall(displayText);
      session.logger.info(`👁️ Glucosa temporal (lang: ${userSettings.language}, tz: ${userSettings.timezone})`);

      const existing = this.displayTimers.get(sessionId);
      if (existing) clearTimeout(existing);

      const hideTimer = setTimeout(() => {
        this.hideDisplay(session, sessionId);
        this.displayTimers.delete(sessionId);
      }, duration);
      this.displayTimers.set(sessionId, hideTimer);
    } catch (error) {
      session.logger.error('Error mostrando glucosa temporal:', error);
    }
  }

  // ================= EVENTOS =================
  setupSafeEventHandlers(session, sessionId, userId) {
    try {
      // Botón físico
      if (session.events?.onButtonPress) {
        session.events.onButtonPress(async (buttonData) => {
          session.logger.info(`🔘 Botón: ${JSON.stringify(buttonData)}`);
          await this.showGlucoseTemporarily(session, sessionId, 10000);
        });
      }

      // Comandos de voz
      if (session.events?.onTranscription) {
        session.events.onTranscription(async (transcription) => {
          const text = (transcription.text || '').toLowerCase();
          const showCmds = ['show glucose', 'mostrar glucosa', 'glucose', 'glucosa', 'sugar', 'azucar', 'nivel', 'level'];
          if (showCmds.some((c) => text.includes(c))) {
            session.logger.info(`🎤 Voz reconocida: ${text}`);
            await this.showGlucoseTemporarily(session, sessionId, 12000);
          }
        });
      }

      // Desconexión
      if (session.events?.onDisconnected) {
        session.events.onDisconnected(() => this.cleanupSession(sessionId, session));
        session.logger.info(`✅ onDisconnected registrado (${sessionId})`);
      } else {
        session.logger.warn('⚠️ onDisconnected no disponible, fallback timeout');
        const sData = this.activeSessions.get(sessionId);
        if (sData) {
          sData.autoCleanupTimeout = setTimeout(() => {
            session.logger.info(`🧹 Auto-cleanup ${sessionId}`);
            this.cleanupSession(sessionId, session);
          }, 30 * 60 * 1000);
        }
      }
    } catch (error) {
      session.logger.error(`❌ Error en event handlers: ${error.message}`);
    }
  }

  // ================= AI Tools (Mira) =================
  async onToolCall(data) {
    const toolId = data.toolId || data.toolName;
    const userId = data.userId;
    const activeSession = data.activeSession;

    console.log(`🤖 AI Tool called: ${toolId} for user ${userId}`);

    try {
      let userPreferredLang = 'en';
      if (activeSession?.settings?.settings) {
        const langSetting = activeSession.settings.settings.find((s) => s.key === 'language');
        if (langSetting) userPreferredLang = langSetting.value === 'es' ? 'es' : 'en';
      }

      const forceEn = ['get_glucose', 'glucose_level', 'blood_sugar'];
      const forceEs = ['obtener_glucosa', 'revisar_glucosa', 'nivel_glucosa', 'mi_glucosa'];

      if (forceEn.includes(toolId)) return this.handleGetGlucoseForMira(userId, activeSession, 'en');
      if (forceEs.includes(toolId)) return this.handleGetGlucoseForMira(userId, activeSession, 'es');
      return this.handleGetGlucoseForMira(userId, activeSession, userPreferredLang);
    } catch (error) {
      console.error('Error in AI Tool:', error);
      return { success: false, error: error.message };
    }
  }

  async handleGetGlucoseForMira(userId, activeSession, lang) {
    try {
      console.log(`📋 Mira request for ${userId} in ${lang}`);

      let userSettings = null;
      let sessionForDisplay = null;

      if (activeSession?.settings?.settings) {
        userSettings = this.parseSettingsFromArray(activeSession.settings.settings);
        sessionForDisplay = activeSession;
      } else {
        for (const [sid, sData] of this.activeSessions) {
          if (sData.userId === userId) {
            userSettings = await this.getUserSettings(sData.session);
            sessionForDisplay = sData.session;
            break;
          }
        }
      }

      if (!userSettings?.nightscoutUrl || !userSettings?.nightscoutToken) {
        const err = lang === 'es'
          ? 'Nightscout no está configurado. Configura la URL y token en los ajustes de la aplicación.'
          : 'Nightscout is not configured. Configure URL and token in app settings.';
        return { success: false, error: err };
      }

      const glucoseData = await this.getGlucoseData(userSettings);
      if (!glucoseData) {
        const err = lang === 'es' ? 'No hay datos de glucosa disponibles.' : 'No glucose data available.';
        return { success: false, error: err };
      }

      if (sessionForDisplay?.layouts) {
        try {
          const displayText = this.formatForG1(glucoseData, userSettings);
          sessionForDisplay.layouts.showTextWall(displayText);
          setTimeout(() => {
            if (sessionForDisplay.layouts) sessionForDisplay.layouts.showTextWall('');
          }, 10000);
        } catch (e) { console.error('Error mostrando en gafas:', e); }
      }

      const trend = this.getTrendArrow(glucoseData.direction);
      const status = this.getGlucoseStatusText(glucoseData.sgv, userSettings, lang);
      const message = lang === 'es'
        ? `Tu glucosa está en ${glucoseData.sgv} mg/dL ${trend}. Estado: ${status}.`
        : `Your glucose is ${glucoseData.sgv} mg/dL ${trend}. Status: ${status}.`;

      return { success: true, data: { glucose: glucoseData.sgv, trend, status }, message };
    } catch (error) {
      console.error('❌ Error en handleGetGlucoseForMira:', error);
      const err = lang === 'es' ? `Error obteniendo glucosa: ${error.message}` : `Error getting glucose: ${error.message}`;
      return { success: false, error: err };
    }
  }

  // ================= Utils settings =================
  parseSettingsFromArray(arr) {
    const o = {};
    for (const s of arr) o[s.key] = s.value;
    return {
      nightscoutUrl: o.nightscout_url?.trim(),
      nightscoutToken: o.nightscout_token?.trim(),
      updateInterval: parseInt(o.update_interval) || 5,
      lowAlert: parseInt(o.low_alert) || 70,
      highAlert: parseInt(o.high_alert) || 180,
      alertsEnabled: o.alerts_enabled === 'true' || o.alerts_enabled === true,
      language: o.language || 'en',
      timezone: o.timezone || null
    };
  }

  getGlucoseStatusText(value, settings, lang) {
    if (value < 70) return lang === 'es' ? 'Crítico Bajo' : 'Critical Low';
    if (value < settings.lowAlert) return lang === 'es' ? 'Bajo' : 'Low';
    if (value > 250) return lang === 'es' ? 'Crítico Alto' : 'Critical High';
    if (value > settings.highAlert) return lang === 'es' ? 'Alto' : 'High';
    return lang === 'es' ? 'Normal' : 'Normal';
  }

  validateAlertRanges(s) {
    const MIN_LOW = 40, MAX_LOW = 90, MIN_HIGH = 180, MAX_HIGH = 400;
    const vLow = Math.max(MIN_LOW, Math.min(MAX_LOW, s.lowAlert));
    const vHigh = Math.max(MIN_HIGH, Math.min(MAX_HIGH, s.highAlert));
    if (vLow !== s.lowAlert || vHigh !== s.highAlert) {
      console.log(`🔔 Validación alertas: L${s.lowAlert}/H${s.highAlert} → L${vLow}/H${vHigh}`);
    }
    return { ...s, lowAlert: vLow, highAlert: vHigh };
  }

  async getUserSettings(session) {
    try {
      const [
        nightscoutUrl, nightscoutToken, updateInterval,
        lowAlert, highAlert, alertsEnabled,
        language, timezone
      ] = await Promise.all([
        session.settings.get('nightscout_url'),
        session.settings.get('nightscout_token'),
        session.settings.get('update_interval'),
        session.settings.get('low_alert'),
        session.settings.get('high_alert'),
        session.settings.get('alerts_enabled'),
        session.settings.get('language'),
        session.settings.get('timezone')
      ]);

      const s = {
        nightscoutUrl: nightscoutUrl?.trim(),
        nightscoutToken: nightscoutToken?.trim(),
        updateInterval: parseInt(updateInterval) || 5,
        lowAlert: parseInt(lowAlert) || 70,
        highAlert: parseInt(highAlert) || 180,
        alertsEnabled: alertsEnabled === 'true' || alertsEnabled === true,
        language: language || 'en',
        timezone: timezone || null
      };
      return this.validateAlertRanges(s);
    } catch (error) {
      session.logger.error('Error obteniendo settings del usuario:', error);
      return {
        nightscoutUrl: null,
        nightscoutToken: null,
        updateInterval: 5,
        lowAlert: 70,
        highAlert: 180,
        alertsEnabled: true,
        language: 'en',
        timezone: null
      };
    }
  }

  async showConfigurationNeeded(session, settings) {
    const messages = {
      en: 'Please configure your\nNightscout URL and token\nin MentraOS app settings',
      es: 'Por favor configura tu\nURL y token de Nightscout\nen ajustes de MentraOS',
      fr: 'Veuillez configurer votre\nURL et token Nightscout\ndans les paramètres MentraOS'
    };
    session.layouts.showTextWall(messages[settings.language] || messages.en);
    session.logger.info('Configuración requerida mostrada al usuario');
  }

  async startNormalOperation(session, sessionId, userId, settings) {
    session.logger.info(`Iniciando con settings oficiales para ${userId}`);

    this.activeSessions.set(sessionId, {
      session,
      userId,
      settings,
      updateInterval: null,
      settingsPolling: null,
      autoCleanupTimeout: null
    });

    try {
      const intervalMs = settings.updateInterval * 60 * 1000;
      const updateInterval = setInterval(async () => {
        try {
          if (!this.activeSessions.has(sessionId)) {
            clearInterval(updateInterval);
            return;
          }
          const currentSettings = await this.getUserSettings(session);
          const newData = await this.getGlucoseData(currentSettings);

          if (currentSettings.alertsEnabled) {
            await this.checkAlerts(session, sessionId, newData, currentSettings);
          }
          session.logger.debug(`🔄 Monitoreo silencioso: ${newData.sgv} mg/dL`);
        } catch (error) {
          session.logger.error('Error en update automático:', error);
        }
      }, intervalMs);

      const sData = this.activeSessions.get(sessionId);
      if (sData) sData.updateInterval = updateInterval;
    } catch (error) {
      session.logger.error('Error iniciando operación:', error);
      session.layouts.showTextWall('Error: Check Nightscout\nconnection in settings');
    }
  }

  // Listener reactivo / polling
  setupSettingsListener(session, sessionId) {
    try {
      const sData = this.activeSessions.get(sessionId);
      if (!sData) return;

      if (session.
