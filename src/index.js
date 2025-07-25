// src/index.js - Nightscout MentraOS VERSIÓN GLUROO COMPATIBLE
// Fix: Soporte completo para tokens largos de Gluroo

const { AppServer } = require('@mentra/sdk');
const axios = require('axios');
require('dotenv').config();

const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.tucompania.nightscout-glucose";
const PORT = parseInt(process.env.PORT || "3000");
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

if (!MENTRAOS_API_KEY) {
    console.error("❌ MENTRAOS_API_KEY environment variable is required");
    process.exit(1);
}

const UNITS = {
    MGDL: 'mg/dL',
    MMOL: 'mmol/L'
};

class NightscoutMentraApp extends AppServer {
    constructor(options) {
        super(options);
        this.activeSessions = new Map();
        this.alertHistory = new Map();
        this.displayTimers = new Map();
        this.userUnitsCache = new Map();
    }

    // 🆕 FIX: Parsear valores de slicer y tokens largos
    parseSlicerValue(value, defaultValue) {
        if (typeof value === 'object' && value !== null) {
            return value.value || defaultValue;
        }
        return value || defaultValue;
    }

    validateToken(token) {
        return String(token || '').trim();
    }

    async onSettingsUpdate(updates, sessionId) {
        try {
            console.log(`🔄 Settings update received for ${sessionId}:`, updates);
            
            const sessionData = this.activeSessions.get(sessionId);
            if (!sessionData) {
                console.warn(`⚠️ No active session for settings update`);
                return;
            }

            const newSettings = await this.getUserSettings(sessionData.session);
            newSettings.glucoseUnit = await this.getGlucoseUnit(newSettings);
            
            sessionData.settings = newSettings;
            console.log(`✅ Settings refreshed - Token: ${newSettings.nightscoutToken?.substring(0,8)}...`);
            
        } catch (error) {
            console.error(`❌ Settings update failed:`, error);
        }
    }

    validateTimezone(timezone) {
        const validTimezones = [
            'Europe/Madrid', 'Europe/London', 'America/New_York', 
            'America/Los_Angeles', 'America/Mexico_City', 'America/Argentina/Buenos_Aires',
            'America/Sao_Paulo', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'
        ];
        return validTimezones.includes(timezone) ? timezone : 'UTC';
    }

    async getGlucoseUnit(settings) {
        const cacheKey = `${settings.nightscoutUrl}_${settings.nightscoutToken}`;
        if (this.userUnitsCache.has(cacheKey)) {
            return this.userUnitsCache.get(cacheKey);
        }

        try {
            let cleanUrl = settings.nightscoutUrl?.trim();
            if (!cleanUrl) return UNITS.MGDL;

            if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;
            cleanUrl = cleanUrl.replace(/\/$/, '');

            // 🆕 Soporte específico para URLs de Gluroo
            if (cleanUrl.includes('gluroo.com')) {
                console.log('✅ Configuración Gluroo detectada');
            }

            const profileUrl = `${cleanUrl}/api/v1/profile`;
            const response = await axios.get(profileUrl, {
                params: { token: settings.nightscoutToken },
                timeout: 5000,
                headers: { 'User-Agent': 'MentraOS-Nightscout/1.0' }
            });

            let unit = UNITS.MGDL;
            if (response.data && response.data.length > 0) {
                const profile = response.data[0];
                if (profile.store?.Default?.units === 'mmol' || profile.units === 'mmol') {
                    unit = UNITS.MMOL;
                }
            }

            this.userUnitsCache.set(cacheKey, unit);
            return unit;

        } catch (error) {
            console.warn('⚠️ Unit detection failed, defaulting to mg/dL');
            this.userUnitsCache.set(cacheKey, UNITS.MGDL);
            return UNITS.MGDL;
        }
    }

    convertToDisplay(value, unit) {
        if (unit === UNITS.MMOL) {
            return (value / 18).toFixed(1);
        }
        return Math.round(value);
    }

    getLanguageSettings(settings) {
        const langMap = {
            'es': { locale: 'es-ES', timezone: 'Europe/Madrid' },
            'en': { locale: 'en-US', timezone: 'America/New_York' },
            'fr': { locale: 'fr-FR', timezone: 'Europe/Paris' }
        };
        return langMap[settings.language] || langMap['en'];
    }

    async onSession(session, sessionId, userId) {
        console.log(`🚀 Nueva sesión: ${sessionId} para ${userId}`);
        
        try {
            const userSettings = await this.getUserSettings(session);
            userSettings.glucoseUnit = await this.getGlucoseUnit(userSettings);
            
            console.log('📊 Settings cargados:', {
                lowAlert: userSettings.lowAlert,
                highAlert: userSettings.highAlert,
                unit: userSettings.glucoseUnit,
                tokenLength: userSettings.nightscoutToken?.length
            });

            if (!userSettings.nightscoutUrl || !userSettings.nightscoutToken) {
                await this.showConfigurationNeeded(session, userSettings);
                return;
            }

            await this.showInitialAndHide(session, sessionId, userSettings);
            await this.startNormalOperation(session, sessionId, userId, userSettings);
            this.setupSafeEventHandlers(session, sessionId, userId);

        } catch (error) {
            session.logger.error(`Error en sesión: ${error.message}`);
            session.layouts.showTextWall("Error: Check app settings");
        }
    }

    async showInitialAndHide(session, sessionId, settings) {
        try {
            const glucoseData = await this.getGlucoseData(settings);
            const displayText = await this.formatForG1(glucoseData, settings);
            
            session.layouts.showTextWall(displayText);
            setTimeout(() => this.hideDisplay(session, sessionId), 5000);
            
        } catch (error) {
            console.error('Error en display inicial:', error);
        }
    }

    hideDisplay(session, sessionId) {
        try {
            session.layouts.showTextWall("");
        } catch (error) {
            console.error('Error ocultando display:', error);
        }
    }

    setupSafeEventHandlers(session, sessionId, userId) {
        try {
            if (session.events?.onButtonPress) {
                session.events.onButtonPress(async () => {
                    await this.showGlucoseTemporarily(session, sessionId, 10000);
                });
            }

            if (session.events?.onDisconnected) {
                session.events.onDisconnected(() => {
                    const displayTimer = this.displayTimers.get(sessionId);
                    if (displayTimer) {
                        clearTimeout(displayTimer);
                        this.displayTimers.delete(sessionId);
                    }

                    const userSession = this.activeSessions.get(sessionId);
                    if (userSession?.updateInterval) {
                        clearInterval(userSession.updateInterval);
                    }

                    this.activeSessions.delete(sessionId);
                    this.alertHistory.delete(sessionId);
                });
            }

        } catch (error) {
            console.error(`Error configurando event handlers: ${error.message}`);
        }
    }

    // 🆕 FIX: Manejo completo de settings incluyendo tokens largos
    async getUserSettings(session) {
        try {
            const [
                nightscoutUrl,
                nightscoutToken,
                updateInterval,
                lowAlertSetting,
                highAlertSetting,
                alertsEnabled,
                language,
                timezone
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

            // 🆕 FIX: Manejo completo de tokens (incluidos largos de Gluroo)
            const settings = {
                nightscoutUrl: this.validateToken(nightscoutUrl),
                nightscoutToken: this.validateToken(nightscoutToken),
                updateInterval: this.parseSlicerValue(updateInterval, 5),
                lowAlert: this.parseSlicerValue(lowAlertSetting, 70),
                highAlert: this.parseSlicerValue(highAlertSetting, 180),
                alertsEnabled: alertsEnabled === 'true' || alertsEnabled === true || alertsEnabled === 1,
                language: language || 'en',
                timezone: timezone || null
            };

            console.log('🔧 Settings procesados:', {
                url: settings.nightscoutUrl,
                token: settings.nightscoutToken?.substring(0,12) + '...',
                tokenLength: settings.nightscoutToken?.length
            });

            return settings;

        } catch (error) {
            console.error('Error obteniendo settings:', error);
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
            en: "Please configure Nightscout\nURL and token in settings",
            es: "Configura URL y token\nde Nightscout en ajustes",
            fr: "Configurez l'URL et le token\nNightscout dans les paramètres"
        };
        session.layouts.showTextWall(messages[settings.language] || messages.en);
    }

    async startNormalOperation(session, sessionId, userId, settings) {
        this.activeSessions.set(sessionId, { session, userId, settings });

        const intervalMs = settings.updateInterval * 60 * 1000;
        const updateInterval = setInterval(async () => {
            try {
                if (!this.activeSessions.has(sessionId)) {
                    clearInterval(updateInterval);
                    return;
                }

                const currentSettings = await this.getUserSettings(session);
                currentSettings.glucoseUnit = await this.getGlucoseUnit(currentSettings);
                const newData = await this.getGlucoseData(currentSettings);
                
                if (currentSettings.alertsEnabled) {
                    await this.checkAlerts(session, sessionId, newData, currentSettings);
                }

                console.log(`🔄 Update: ${newData.sgv} ${currentSettings.glucoseUnit} (Token: ${currentSettings.nightscoutToken?.substring(0,8)}...)`);

            } catch (error) {
                console.error('Error en update automático:', error);
            }
        }, intervalMs);

        this.activeSessions.get(sessionId).updateInterval = updateInterval;
    }

    async getGlucoseData(settings) {
        try {
            let cleanUrl = settings.nightscoutUrl?.trim();
            if (!cleanUrl) throw new Error('URL de Nightscout no configurada');

            // 🆕 Soporte para URLs de Gluroo
            if (cleanUrl.includes('gluroo.com')) {
                console.log('🌐 Conectando con Gluroo:', cleanUrl);
            }

            if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;
            cleanUrl = cleanUrl.replace(/\/$/, '');
            
            const response = await axios.get(`${cleanUrl}/api/v1/entries/current.json`, {
                params: { token: settings.nightscoutToken },
                timeout: 10000,
                headers: { 'User-Agent': 'MentraOS-Nightscout/1.0' }
            });

            const reading = Array.isArray(response.data) ? response.data[0] : response.data;
            if (!reading?.sgv) throw new Error('No hay datos de glucosa');

            return reading;
        } catch (error) {
            console.error('Error obteniendo datos:', error.message);
            throw error;
        }
    }

    async formatForG1(glucoseData, settings) {
        const unit = settings.glucoseUnit || UNITS.MGDL;
        const displayValue = this.convertToDisplay(glucoseData.sgv, unit);
        const trend = this.getTrendArrow(glucoseData.direction);

        const langSettings = this.getLanguageSettings(settings);
        let timeZone = langSettings.timezone;

        try {
            if (settings.timezone) {
                timeZone = this.validateTimezone(settings.timezone);
            } else {
                const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
                if (detected && detected !== 'UTC') timeZone = this.validateTimezone(detected);
            }
        } catch {
            console.warn('Timezone detection failed, using fallback');
        }

        const time = new Date(glucoseData.date || Date.now()).toLocaleTimeString(langSettings.locale, {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: timeZone
        });

        const mgdlValue = unit === UNITS.MMOL ? 
            this.convertToMgdl(parseFloat(displayValue), UNITS.MMOL) : 
            parseFloat(displayValue);

        let symbol = '*';
        if (mgdlValue < settings.lowAlert) symbol = '!';
        else if (mgdlValue > settings.highAlert) symbol = '^';

        return `${symbol} ${displayValue} ${unit}\n${time}`;
    }

    getTrendArrow(direction) {
        const arrows = {
            'DoubleUp': '^^', 'SingleUp': '^', 'FortyFiveUp': '/',
            'Flat': '->', 'FortyFiveDown': '\\', 'SingleDown': 'v',
            'DoubleDown': 'vv', 'NONE': '-', 'NOT COMPUTABLE': '?'
        };
        return arrows[direction] || '->';
    }

    getGlucoseStatusText(value, settings, lang) {
        const mgdlValue = settings.glucoseUnit === UNITS.MMOL ? 
            this.convertToMgdl(parseFloat(value), UNITS.MMOL) : 
            value;

        if (mgdlValue < 70) return lang === 'es' ? 'Crítico Bajo' : 'Critical Low';
        if (mgdlValue < settings.lowAlert) return lang === 'es' ? 'Bajo' : 'Low';
        if (mgdlValue > 250) return lang === 'es' ? 'Crítico Alto' : 'Critical High';
        if (mgdlValue > settings.highAlert) return lang === 'es' ? 'Alto' : 'High';
        return lang === 'es' ? 'Normal' : 'Normal';
    }

    // 🆕 FIX: Parsear settings array incluyendo slicers
    parseSettingsFromArray(settingsArray) {
        const settings = {};
        for (const setting of settingsArray) {
            settings[setting.key] = setting.value;
        }

        return {
            nightscoutUrl: this.validateToken(settings.nightscout_url),
            nightscoutToken: this.validateToken(settings.nightscout_token),
            updateInterval: this.parseSlicerValue(settings.update_interval, 5),
            lowAlert: this.parseSlicerValue(settings.low_alert, 70),
            highAlert: this.parseSlicerValue(settings.high_alert, 180),
            alertsEnabled: settings.alerts_enabled === 'true' || settings.alerts_enabled === true || settings.alerts_enabled === 1,
            language: settings.language || 'en',
            timezone: settings.timezone || null
        };
    }
}

// Iniciar servidor
const server = new NightscoutMentraApp({
    packageName: PACKAGE_NAME,
    apiKey: MENTRAOS_API_KEY,
    port: PORT
});

server.start().catch(err => {
    console.error("❌ Error iniciando servidor:", err);
    process.exit(1);
});

console.log(`🚀 Nightscout MentraOS v2.4 - GLUROO COMPATIBLE`);
console.log(`📊 Soporta tokens largos de Gluroo`);
console.log(`🔧 API Secret Token funcionando correctamente`);

const KEEP_ALIVE_URL = process.env.RENDER_URL || `https://mentra-nightscout.onrender.com`;

// Health check endpoint
server.app.get('/health', (req, res) => {
    res.json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        version: '2.4.1',
        gluroo_compatible: true
    });
});

// Auto-keep-alive
setInterval(() => {
    axios.get(KEEP_ALIVE_URL)
        .then(() => console.log(`🔄 Keep-alive: ${new Date().toLocaleTimeString()}`))
        .catch(() => {}); // Expected on startup
}, 3 * 60 * 1000); // Ping cada 3 minutos
