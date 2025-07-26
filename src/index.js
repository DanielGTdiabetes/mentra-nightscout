// src/index.js – Nightscout MentraOS v2.4.5 (DUAL-UNITS + TIMEZONE-FIX)

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

    /* ---------- helpers ---------- */
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
                low_alert_mg: 70, high_alert_mg: 250,
                low_alert_mmol: 3.9, high_alert_mmol: 13.9,
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
            low_alert_mg: this.validateSlicerValue(o.low_alert_mg, 40, 90, 70),
            high_alert_mg: this.validateSlicerValue(o.high_alert_mg, 180, 400, 250),
            low_alert_mmol: this.validateSlicerValue(o.low_alert_mmol, 2, 5, 3.9),
            high_alert_mmol: this.validateSlicerValue(o.high_alert_mmol, 8, 30, 13.9),
            alertsEnabled: o.alerts_enabled === true || o.alerts_enabled === 'true',
            language: o.language || 'en',
            timezone: o.timezone || null,
            units: units
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
            'NONE': '-', 'NOT COMPUTABLE': '?',
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

    // MÉTODO MEJORADO: formatForG1 con unidades configurables
    async formatForG1(data, settings) {
        const display = this.convertToDisplay(data.sgv, settings.units);
        const trend = this.getTrendArrow(data.direction);

        // Formatear tiempo
        const langSettings = this.getLanguageSettings(settings);
        const timezone = settings.timezone ? this.validateTimezone(settings.timezone) : langSettings.timezone;
        const readingTime = new Date(data.date);
        const timeStr = readingTime.toLocaleTimeString(langSettings.locale, {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit'
        });

        // Calcular minutos desde la última lectura con idioma
        const minutesAgo = Math.floor((Date.now() - data.date) / 60000);
        const lang = settings.language || 'en';
        let timeAgo;
        if (minutesAgo <= 1) {
            timeAgo = lang === 'es' ? 'ahora' : 'now';
        } else {
            timeAgo = lang === 'es' ? `hace ${minutesAgo}m` : `${minutesAgo}m ago`;
        }

        return `${display} ${settings.units} ${trend}\n${timeStr} (${timeAgo})`;
    }

    /* ---------- data ---------- */
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

    /* ---------- session ---------- */
    async onSession(session, sessionId, userId) {
        console.log(`🚀 Nueva sesión: ${sessionId} para ${userId}`);
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

            // Guardar configuración en cache
            this.activeSessions.set(sessionId, { session, userId, settings });

            await this.showInitialAndHide(session, sessionId, settings);
            await this.startNormalOperation(session, sessionId, userId, settings);
            this.setupSafeEventHandlers(session, sessionId, userId);

        } catch (e) {
            console.error('Error en sesión:', e);
            session.layouts.showTextWall('Error: Check app settings');
        }
    }

    // MÉTODO CORREGIDO: showInitialAndHide con unidades
    async showInitialAndHide(session, sessionId, settings) {
        try {
            const data = await this.getGlucoseData(settings);
            const formattedData = await this.formatForG1(data, settings);
            session.layouts.showTextWall(formattedData);
            console.log(`✅ Mostrando datos iniciales: ${formattedData.replace('\n', ' ')}`);
            setTimeout(() => this.hideDisplay(session, sessionId), 5000);
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
            setTimeout(() => this.hideDisplay(session, sessionId), 5000);
        }
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
            const sessionData = this.activeSessions.get(sessionId);
            if (!sessionData) return;

            // Obtener configuración actualizada
            const settings = await this.getUserSettings(sessionData.session);
            const data = await this.getGlucoseData(settings);
            session.layouts.showTextWall(await this.formatForG1(data, settings));
            
            const timer = setTimeout(() => this.hideDisplay(session, sessionId), ms);
            this.displayTimers.set(sessionId, timer);
        } catch {}
    }

    async startNormalOperation(session, sessionId, userId, settings) {
        const ms = settings.updateInterval * 60 * 1000;
        const iv = setInterval(async () => {
            if (!this.activeSessions.has(sessionId)) return clearInterval(iv);
            try {
                const s = await this.getUserSettings(session);
                const d = await this.getGlucoseData(s);
                if (s.alertsEnabled) await this.checkAlerts(session, sessionId, d, s);
            } catch {}
        }, ms);

        // Actualizar la referencia en el mapa
        const sessionData = this.activeSessions.get(sessionId);
        sessionData.updateInterval = iv;
        this.activeSessions.set(sessionId, sessionData);
    }

    // MÉTODO MEJORADO: checkAlerts con soporte para mmol/L
    async checkAlerts(session, sessionId, data, settings) {
        const limits = this.getAlertLimits(settings);
        const mgdl = data.sgv;
        const display = this.convertToDisplay(mgdl, settings.units);

        const last = this.alertHistory.get(sessionId);
        if (last && Date.now() - last < 600000) return; // Evitar spam (10 min)

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

    // NUEVO MÉTODO: Manejo de cambios de configuración
    async onSettingsChange(session, sessionId, settings) {
        console.log(`⚙️ Configuración cambiada para ${sessionId}`);
        try {
            const parsedSettings = this.parseSettingsFromArray(settings);
            
            // Log cambios importantes
            const sessionData = this.activeSessions.get(sessionId);
            const oldSettings = sessionData?.settings || {};
            
            if (oldSettings.units !== parsedSettings.units) {
                console.log(`🔄 Cambio de unidades: ${oldSettings.units} → ${parsedSettings.units}`);
            }

            if (oldSettings.language !== parsedSettings.language) {
                console.log(`🌐 Cambio de idioma: ${oldSettings.language} → ${parsedSettings.language}`);
            }

            // Actualizar configuración en la sesión activa
            if (sessionData) {
                sessionData.settings = parsedSettings;
                this.activeSessions.set(sessionId, sessionData);
            }

            // Limpiar historial de alertas si cambiaron los límites
            if (this.alertLimitsChanged(oldSettings, parsedSettings)) {
                console.log(`🔔 Límites de alerta cambiados, reiniciando historial`);
                this.alertHistory.delete(sessionId);
            }

        } catch (error) {
            console.error(`❌ Error en onSettingsChange ${sessionId}:`, error);
        }
    }

    // Detectar cambios en límites de alerta
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

            const data = await this.getGlucoseData(settings);
            const display = this.convertToDisplay(data.sgv, settings.units);
            const trend = this.getTrendArrow(data.direction);
            const status = this.getGlucoseStatusText(data.sgv, settings, lang);

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

console.log('🚀 Nightscout MentraOS v2.4.5 – DUAL-UNITS + TIMEZONE-FIX aplicado');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({ 
    status: 'alive', 
    timestamp: new Date().toISOString(), 
    version: '2.4.5',
    activeSessions: server.activeSessions.size
}));

setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);
