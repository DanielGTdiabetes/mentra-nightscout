// src/index.js - Nightscout MentraOS COMPLETO CORREGIDO
// Fix: Timezone, Language, mmol/L support + all previous features

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

// 🆕 NEW: Unit constants and conversion utilities
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
        this.userUnitsCache = new Map(); // Cache for user units
    }

    // 🆕 NEW: Validate timezone
    validateTimezone(timezone) {
        const validTimezones = [
            'Europe/Madrid', 'Europe/London', 'America/New_York', 
            'America/Los_Angeles', 'America/Mexico_City', 'America/Argentina/Buenos_Aires',
            'America/Sao_Paulo', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'
        ];
        return validTimezones.includes(timezone) ? timezone : 'UTC';
    }

    // 🆕 NEW: Detect glucose unit from Nightscout
    async getGlucoseUnit(settings) {
        const cacheKey = `${settings.nightscoutUrl}_${settings.nightscoutToken}`;
        if (this.userUnitsCache.has(cacheKey)) {
            return this.userUnitsCache.get(cacheKey);
        }

        try {
            let cleanUrl = settings.nightscoutUrl?.trim();
            if (!cleanUrl) return UNITS.MGDL;

            if (!cleanUrl.startsWith('http')) {
                cleanUrl = 'https://' + cleanUrl;
            }
            cleanUrl = cleanUrl.replace(/\/$/, '');

            // Try profile endpoint first
            const profileUrl = `${cleanUrl}/api/v1/profile`;
            const response = await axios.get(profileUrl, {
                params: { token: settings.nightscoutToken },
                timeout: 5000,
                headers: { 'User-Agent': 'MentraOS-Nightscout/1.0' }
            });

            let unit = UNITS.MGDL;
            if (response.data && response.data.length > 0) {
                const profile = response.data[0];
                if (profile.store?.Default?.units === 'mmol') {
                    unit = UNITS.MMOL;
                } else if (profile.units === 'mmol') {
                    unit = UNITS.MMOL;
                }
            }

            this.userUnitsCache.set(cacheKey, unit);
            return unit;

        } catch (error) {
            console.warn('⚠️ Unit detection failed, defaulting to mg/dL:', error.message);
            this.userUnitsCache.set(cacheKey, UNITS.MGDL);
            return UNITS.MGDL;
        }
    }

    // 🆕 NEW: Conversion utilities
    convertToDisplay(value, unit) {
        if (unit === UNITS.MMOL) {
            return (value / 18).toFixed(1);
        }
        return Math.round(value);
    }

    convertToMgdl(value, sourceUnit) {
        if (sourceUnit === UNITS.MMOL) {
            return Math.round(value * 18);
        }
        return value;
    }

    // 🆕 NEW: Get language settings
    getLanguageSettings(settings) {
        const langMap = {
            'es': { locale: 'es-ES', timezone: 'Europe/Madrid', messages: 'es' },
            'en': { locale: 'en-US', timezone: 'America/New_York', messages: 'en' },
            'fr': { locale: 'fr-FR', timezone: 'Europe/Paris', messages: 'fr' }
        };
        return langMap[settings.language] || langMap['en'];
    }

    async onSession(session, sessionId, userId) {
        session.logger.info(`Nueva sesión oficial: ${sessionId} para ${userId}`);
        
        try {
            session.logger.info('=== DIAGNÓSTICO DE SETTINGS ===');
            try {
                const url = await session.settings.get('nightscout_url');
                session.logger.info(`URL setting: "${url}" (type: ${typeof url})`);
            } catch (e) {
                session.logger.error('Error getting URL setting:', e);
            }

            try {
                const token = await session.settings.get('nightscout_token');
                session.logger.info(`Token setting: "${token ? token.substring(0, 8) + '***' : null}" (type: ${typeof token})`);
            } catch (e) {
                session.logger.error('Error getting token setting:', e);
            }

            try {
                const lowAlert = await session.settings.get('low_alert');
                const highAlert = await session.settings.get('high_alert');
                const language = await session.settings.get('language');
                const timezone = await session.settings.get('timezone');
                session.logger.info(`🔔 Alertas configuradas - Baja: ${lowAlert}, Alta: ${highAlert}`);
                session.logger.info(`🌍 Language: ${language}, Timezone: ${timezone}`);
            } catch (e) {
                session.logger.error('Error getting alert settings:', e);
            }

            session.logger.info('=== FIN DIAGNÓSTICO ===');

            const userSettings = await this.getUserSettings(session);
            const glucoseUnit = await this.getGlucoseUnit(userSettings);
            const enhancedSettings = { ...userSettings, glucoseUnit };
            
            session.logger.info('Settings finales obtenidos:', {
                hasUrl: !!enhancedSettings.nightscoutUrl,
                hasToken: !!enhancedSettings.nightscoutToken,
                language: enhancedSettings.language,
                unit: enhancedSettings.glucoseUnit,
                timezone: enhancedSettings.timezone
            });

            if (!enhancedSettings.nightscoutUrl || !enhancedSettings.nightscoutToken) {
                await this.showConfigurationNeeded(session, enhancedSettings);
                return;
            }

            await this.showInitialAndHide(session, sessionId, enhancedSettings);
            await this.startNormalOperation(session, sessionId, userId, enhancedSettings);
            this.setupSafeEventHandlers(session, sessionId, userId);
            this.setupSettingsListener(session, sessionId, userId);

        } catch (error) {
            session.logger.error(`Error en sesión: ${error.message}`);
            session.layouts.showTextWall("Error: Check app settings\nin MentraOS app");
        }
    }

    async showInitialAndHide(session, sessionId, settings) {
        try {
            const glucoseData = await this.getGlucoseData(settings);
            const displayText = await this.formatForG1(glucoseData, settings);
            
            session.layouts.showTextWall(displayText);
            session.logger.info('✅ Datos iniciales mostrados');
            
            setTimeout(() => {
                this.hideDisplay(session, sessionId);
            }, 5000);
            
        } catch (error) {
            session.logger.error('Error en display inicial:', error);
        }
    }

    hideDisplay(session, sessionId) {
        try {
            session.layouts.showTextWall("");
            session.logger.info(`🙈 Display ocultado para sesión ${sessionId}`);
        } catch (error) {
            session.logger.error('Error ocultando display:', error);
        }
    }

    async showGlucoseTemporarily(session, sessionId, duration = 8000, settings = null) {
        try {
            if (!settings) {
                settings = await this.getUserSettings(session);
                settings.glucoseUnit = await this.getGlucoseUnit(settings);
            }
            
            const glucoseData = await this.getGlucoseData(settings);
            const displayText = await this.formatForG1(glucoseData, settings);
            
            session.layouts.showTextWall(displayText);
            session.logger.info('👁️ Glucosa mostrada temporalmente');
            
            const existingTimer = this.displayTimers.get(sessionId);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            const hideTimer = setTimeout(() => {
                this.hideDisplay(session, sessionId);
                this.displayTimers.delete(sessionId);
            }, duration);

            this.displayTimers.set(sessionId, hideTimer);
            
        } catch (error) {
            session.logger.error('Error mostrando glucosa temporal:', error);
        }
    }

    setupSafeEventHandlers(session, sessionId, userId) {
        try {
            if (session.events && typeof session.events.onButtonPress === 'function') {
                session.events.onButtonPress(async (buttonData) => {
                    session.logger.info(`🔘 Botón presionado: ${JSON.stringify(buttonData)}`);
                    await this.showGlucoseTemporarily(session, sessionId, 10000);
                });
            }

            if (session.events && typeof session.events.onTranscription === 'function') {
                session.events.onTranscription(async (transcription) => {
                    const text = transcription.text.toLowerCase();
                    
                    const showCommands = [
                        'show glucose', 'mostrar glucosa', 'glucose', 'glucosa',
                        'sugar', 'azucar', 'nivel', 'level', 'blood sugar'
                    ];
                    
                    if (showCommands.some(cmd => text.includes(cmd))) {
                        session.logger.info(`🎤 Comando de voz reconocido: ${text}`);
                        await this.showGlucoseTemporarily(session, sessionId, 12000);
                    }
                });
            }

            if (session.events && typeof session.events.onDisconnected === 'function') {
                const disconnectHandler = () => {
                    try {
                        session.logger.info(`👋 Sesión ${sessionId} desconectada`);
                        
                        const displayTimer = this.displayTimers.get(sessionId);
                        if (displayTimer) {
                            clearTimeout(displayTimer);
                            this.displayTimers.delete(sessionId);
                        }

                        const userSession = this.activeSessions.get(sessionId);
                        if (userSession && userSession.updateInterval) {
                            clearInterval(userSession.updateInterval);
                        }

                        if (userSession && userSession.autoCleanupTimeout) {
                            clearTimeout(userSession.autoCleanupTimeout);
                        }

                        this.activeSessions.delete(sessionId);
                        this.alertHistory.delete(sessionId);
                        
                    } catch (cleanupError) {
                        console.error(`❌ Error en cleanup de sesión ${sessionId}:`, cleanupError);
                    }
                };

                session.events.onDisconnected(disconnectHandler);
                session.logger.info(`✅ Event handler registrado para sesión ${sessionId}`);
                
            } else {
                session.logger.warn('⚠️ session.events.onDisconnected no disponible, usando cleanup alternativo');
                
                const sessionData = this.activeSessions.get(sessionId);
                if (sessionData) {
                    sessionData.autoCleanupTimeout = setTimeout(() => {
                        session.logger.info(`🧹 Auto-cleanup para sesión ${sessionId}`);
                        
                        const userSession = this.activeSessions.get(sessionId);
                        if (userSession && userSession.updateInterval) {
                            clearInterval(userSession.updateInterval);
                        }

                        const displayTimer = this.displayTimers.get(sessionId);
                        if (displayTimer) {
                            clearTimeout(displayTimer);
                            this.displayTimers.delete(sessionId);
                        }

                        this.activeSessions.delete(sessionId);
                        this.alertHistory.delete(sessionId);
                    }, 1800000);
                }
            }

        } catch (error) {
            session.logger.error(`❌ Error configurando event handlers: ${error.message}`);
        }
    }

    async onToolCall(data) {
        const toolId = data.toolId || data.toolName;
        const userId = data.userId;
        const activeSession = data.activeSession;
        
        console.log(`🤖 AI Tool called: ${toolId} for user ${userId}`);
        
        try {
            let userPreferredLang = 'en';
            if (activeSession && activeSession.settings && activeSession.settings.settings) {
                const languageSetting = activeSession.settings.settings.find(s => s.key === 'language');
                if (languageSetting) {
                    userPreferredLang = languageSetting.value === 'es' ? 'es' : 'en';
                }
            }
            
            console.log(`🌍 Idioma preferido del usuario: ${userPreferredLang}`);

            switch (toolId) {
                case 'get_glucose':
                case 'glucose_level':
                case 'blood_sugar':
                    console.log(`🇺🇸 Tool específicamente inglés - respondiendo en inglés`);
                    return await this.handleGetGlucoseForMira(userId, activeSession, 'en');

                case 'obtener_glucosa':
                case 'revisar_glucosa':
                case 'nivel_glucosa':
                case 'mi_glucosa':
                    console.log(`🇪🇸 Tool específicamente español - respondiendo en español`);
                    return await this.handleGetGlucoseForMira(userId, activeSession, 'es');

                case 'check_glucose':
                case 'glucose_status':
                    console.log(`🌍 Tool genérico - usando preferencia del usuario: ${userPreferredLang}`);
                    return await this.handleGetGlucoseForMira(userId, activeSession, userPreferredLang);

                default:
                    console.log(`⚠️ Unknown AI tool: ${toolId} - usando preferencia del usuario: ${userPreferredLang}`);
                    return await this.handleGetGlucoseForMira(userId, activeSession, userPreferredLang);
            }

        } catch (error) {
            console.error('Error in AI Tool:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async handleGetGlucoseForMira(userId, activeSession, lang) {
        try {
            console.log(`📋 Processing glucose request for ${userId} in ${lang}`);
            
            let userSettings = null;
            let sessionForDisplay = null;
            
            if (activeSession && activeSession.settings && activeSession.settings.settings) {
                const settingsArray = activeSession.settings.settings;
                userSettings = this.parseSettingsFromArray(settingsArray);
                sessionForDisplay = activeSession;
                console.log('✅ Settings obtenidos desde activeSession');
            } else {
                for (const [sessionId, sessionData] of this.activeSessions) {
                    if (sessionData.userId === userId) {
                        userSettings = await this.getUserSettings(sessionData.session);
                        userSettings.glucoseUnit = await this.getGlucoseUnit(userSettings);
                        sessionForDisplay = sessionData.session;
                        console.log('✅ Settings obtenidos desde sesión activa');
                        break;
                    }
                }
            }

            if (!userSettings || !userSettings.nightscoutUrl || !userSettings.nightscoutToken) {
                const errorMsg = lang === 'es' ?
                    "Nightscout no está configurado. Configura la URL y token en los ajustes de la aplicación." :
                    "Nightscout is not configured. Configure URL and token in app settings.";
                console.log('❌ Settings no disponibles');
                return {
                    success: false,
                    error: errorMsg
                };
            }

            console.log('📡 Obteniendo datos de Nightscout...');
            const glucoseData = await this.getGlucoseData(userSettings);
            
            if (!glucoseData) {
                const errorMsg = lang === 'es' ?
                    "No hay datos de glucosa disponibles." :
                    "No glucose data available.";
                console.log('❌ No hay datos de glucosa');
                return {
                    success: false,
                    error: errorMsg
                };
            }

            console.log(`✅ Datos obtenidos: ${glucoseData.sgv} mg/dL`);
            
            if (sessionForDisplay) {
                try {
                    const displayText = await this.formatForG1(glucoseData, userSettings);
                    if (sessionForDisplay.layouts) {
                        sessionForDisplay.layouts.showTextWall(displayText);
                        console.log('📱 Glucosa mostrada en gafas por Mira');
                        
                        setTimeout(() => {
                            if (sessionForDisplay.layouts) {
                                sessionForDisplay.layouts.showTextWall("");
                                console.log('🙈 Display ocultado después de Mira');
                            }
                        }, 10000);
                    }
                } catch (displayError) {
                    console.error('Error mostrando en gafas:', displayError);
                }
            }

            const trend = this.getTrendArrow(glucoseData.direction);
            const status = this.getGlucoseStatusText(glucoseData.sgv, userSettings, lang);
            
            const displayValue = this.convertToDisplay(glucoseData.sgv, userSettings.glucoseUnit);
            const message = lang === 'es' ?
                `Tu glucosa está en ${displayValue} ${userSettings.glucoseUnit} ${trend}. Estado: ${status}.` :
                `Your glucose is ${displayValue} ${userSettings.glucoseUnit} ${trend}. Status: ${status}.`;

            console.log(`🤖 Respuesta para Mira: ${message}`);
            
            return {
                success: true,
                data: {
                    glucose: displayValue,
                    unit: userSettings.glucoseUnit,
                    trend: trend,
                    status: status
                },
                message: message
            };

        } catch (error) {
            console.error('❌ Error en handleGetGlucoseForMira:', error);
            const errorMsg = lang === 'es' ?
                `Error obteniendo glucosa: ${error.message}` :
                `Error getting glucose: ${error.message}`;
            return {
                success: false,
                error: errorMsg
            };
        }
    }

    parseSettingsFromArray(settingsArray) {
        const settings = {};
        for (const setting of settingsArray) {
            settings[setting.key] = setting.value;
        }

        return this.validateAlertRanges({
            nightscoutUrl: settings.nightscout_url?.trim(),
            nightscoutToken: settings.nightscout_token?.trim(),
            updateInterval: parseInt(settings.update_interval) || 5,
            lowAlert: parseInt(settings.low_alert) || 70,
            highAlert: parseInt(settings.high_alert) || 180,
            alertsEnabled: settings.alerts_enabled === 'true' || settings.alerts_enabled === true,
            language: settings.language || 'en',
            timezone: settings.timezone || null
        });
    }

    getGlucoseStatusText(value, settings, lang) {
        const mgdlValue = settings.glucoseUnit === UNITS.MMOL ? 
            this.convertToMgdl(parseFloat(value), UNITS.MMOL) : 
            value;

        if (mgdlValue < 70) {
            return lang === 'es' ? 'Crítico Bajo' : 'Critical Low';
        }
        
        if (mgdlValue < settings.lowAlert) {
            return lang === 'es' ? 'Bajo' : 'Low';
        }
        
        if (mgdlValue > 250) {
            return lang === 'es' ? 'Crítico Alto' : 'Critical High';
        }
        
        if (mgdlValue > settings.highAlert) {
            return lang === 'es' ? 'Alto' : 'High';
        }
        
        return lang === 'es' ? 'Normal' : 'Normal';
    }

    validateAlertRanges(settings) {
        const MIN_LOW = 40;
        const MAX_LOW = 90;
        const MIN_HIGH = 180;
        const MAX_HIGH = 400;
        
        const validatedLow = Math.max(MIN_LOW, Math.min(MAX_LOW, settings.lowAlert));
        const validatedHigh = Math.max(MIN_HIGH, Math.min(MAX_HIGH, settings.highAlert));
        
        console.log(`🔔 Validación de alertas - Original: L${settings.lowAlert}/H${settings.highAlert} → Validado: L${validatedLow}/H${validatedHigh}`);
        
        return {
            ...settings,
            lowAlert: validatedLow,
            highAlert: validatedHigh
        };
    }

    async getUserSettings(session) {
        try {
            const [
                nightscoutUrl,
                nightscoutToken,
                updateInterval,
                lowAlert,
                highAlert,
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

            return this.validateAlertRanges({
                nightscoutUrl: nightscoutUrl?.trim(),
                nightscoutToken: nightscoutToken?.trim(),
                updateInterval: parseInt(updateInterval) || 5,
                lowAlert: parseInt(lowAlert) || 70,
                highAlert: parseInt(highAlert) || 180,
                alertsEnabled: alertsEnabled === 'true' || alertsEnabled === true,
                language: language || 'en',
                timezone: timezone || null
            });

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
            en: "Please configure your\nNightscout URL and token\nin MentraOS app settings",
            es: "Por favor configura tu\nURL y token de Nightscout\nen ajustes de MentraOS",
            fr: "Veuillez configurer votre\nURL et token Nightscout\ndans les paramètres MentraOS"
        };

        const message = messages[settings.language] || messages.en;
        session.layouts.showTextWall(message);
        session.logger.info('Configuración requerida mostrada al usuario');
    }

    async startNormalOperation(session, sessionId, userId, settings) {
        session.logger.info(`Iniciando con settings oficiales para ${userId}`);
        
        this.activeSessions.set(sessionId, {
            session,
            userId,
            settings,
            updateInterval: null,
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
                    currentSettings.glucoseUnit = await this.getGlucoseUnit(currentSettings);
                    const newData = await this.getGlucoseData(currentSettings);
                    
                    if (currentSettings.alertsEnabled) {
                        await this.checkAlerts(session, sessionId, newData, currentSettings);
                    }

                    session.logger.debug(`🔄 Monitoreo silencioso: ${newData.sgv} ${currentSettings.glucoseUnit}`);
                    
                } catch (error) {
                    session.logger.error('Error en update automático:', error);
                }
            }, intervalMs);

            const userSession = this.activeSessions.get(sessionId);
            if (userSession) {
                userSession.updateInterval = updateInterval;
            }

        } catch (error) {
            session.logger.error('Error iniciando operación:', error);
            session.layouts.showTextWall("Error: Check Nightscout\nconnection in settings");
        }
    }

    setupSettingsListener(session, sessionId, userId) {
        session.logger.info(`Settings listener configurado para ${sessionId}`);
    }

    async getGlucoseData(settings) {
        try {
            let cleanUrl = settings.nightscoutUrl?.trim();
            if (!cleanUrl) {
                throw new Error('URL de Nightscout no configurada');
            }

            if (!cleanUrl.startsWith('http')) {
                cleanUrl = 'https://' + cleanUrl;
            }

            cleanUrl = cleanUrl.replace(/\/$/, '');
            const fullUrl = `${cleanUrl}/api/v1/entries/current.json`;

            const response = await axios.get(fullUrl, {
                params: { token: settings.nightscoutToken },
                timeout: 10000,
                headers: { 'User-Agent': 'MentraOS-Nightscout/1.0' }
            });

            const data = response.data;
            const reading = Array.isArray(data) ? data[0] : data;

            if (!reading || !reading.sgv) {
                throw new Error('No se encontraron datos válidos de glucosa');
            }

            return reading;
        } catch (error) {
            console.error('❌ Error obteniendo datos de Nightscout:', error.message);
            throw error;
        }
    }

    async formatForG1(glucoseData, settings) {
        const unit = settings.glucoseUnit || UNITS.MGDL;
        const displayValue = this.convertToDisplay(glucoseData.sgv, unit);
        const trend = this.getTrendArrow(glucoseData.direction);

        // 🆕 FIXED: Proper timezone and language detection
        const langSettings = this.getLanguageSettings(settings);
        let timeZone = langSettings.timezone;

        try {
            if (settings.timezone) {
                timeZone = this.validateTimezone(settings.timezone);
            } else {
                const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
                if (detected && detected !== 'UTC') {
                    timeZone = this.validateTimezone(detected);
                }
            }
        } catch (error) {
            console.warn('⚠️ Timezone detection failed, using fallback:', timeZone);
        }

        const time = new Date(glucoseData.date || Date.now()).toLocaleTimeString(langSettings.locale, {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: timeZone
        });

        // 🆕 ADJUSTED: Thresholds based on unit
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
            'DoubleUp': '^^',
            'SingleUp': '^',
            'FortyFiveUp': '/',
            'Flat': '->',
            'FortyFiveDown': '\\',
            'SingleDown': 'v',
            'DoubleDown': 'vv',
            'NONE': '-',
            'NOT COMPUTABLE': '?'
        };
        return arrows[direction] || '->';
    }

    async checkAlerts(session, sessionId, glucoseData, settings) {
        const unit = settings.glucoseUnit || UNITS.MGDL;
        const displayValue = this.convertToDisplay(glucoseData.sgv, unit);
        const mgdlValue = unit === UNITS.MMOL ? 
            this.convertToMgdl(parseFloat(displayValue), UNITS.MMOL) : 
            parseFloat(displayValue);

        const currentTime = Date.now();
        const lastAlert = this.alertHistory.get(sessionId);

        if (lastAlert && (currentTime - lastAlert) < 600000) {
            return;
        }

        let alertMessage = null;
        let alertDuration = 15000;

        const messages = {
            en: {
                low: `🚨 LOW GLUCOSE ALERT!\n${displayValue} ${unit}\nCheck immediately`,
                high: `🚨 HIGH GLUCOSE ALERT!\n${displayValue} ${unit}\nTake action`
            },
            es: {
                low: `🚨 ALERTA GLUCOSA BAJA!\n${displayValue} ${unit}\nRevisar inmediatamente`,
                high: `🚨 ALERTA GLUCOSA ALTA!\n${displayValue} ${unit}\nTomar medidas`
            },
            fr: {
                low: `🚨 ALERTE BASSE!\n${displayValue} ${unit}\nVérifiez immédiatement`,
                high: `🚨 ALERTE HAUTE!\n${displayValue} ${unit}\nPrenez des mesures`
            }
        };

        const lang = settings.language || 'en';
        const langMessages = messages[lang] || messages.en;

        if (mgdlValue < settings.lowAlert) {
            alertMessage = langMessages.low;
            alertDuration = 20000;
            session.logger.warn(`🔔 Alerta baja: ${displayValue} ${unit} < ${settings.lowAlert} mg/dL`);
        } else if (mgdlValue > settings.highAlert) {
            alertMessage = langMessages.high;
            alertDuration = 15000;
            session.logger.warn(`🔔 Alerta alta: ${displayValue} ${unit} > ${settings.highAlert} mg/dL`);
        }

        if (alertMessage) {
            session.layouts.showTextWall(alertMessage);
            this.alertHistory.set(sessionId, currentTime);
            session.logger.error(`🚨 ALERTA PERSONALIZADA: ${displayValue} ${unit} (límites: ${settings.lowAlert}-${settings.highAlert} mg/dL)`);

            const existingTimer = this.displayTimers.get(sessionId);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            const alertTimer = setTimeout(() => {
                this.hideDisplay(session, sessionId);
                this.displayTimers.delete(sessionId);
                session.logger.info(`🙈 Alerta ocultada para ${sessionId}`);
            }, alertDuration);

            this.displayTimers.set(sessionId, alertTimer);
        }
    }

    cleanupSession(sessionId) {
        const sessionData = this.activeSessions.get(sessionId);
        if (sessionData) {
            if (sessionData.updateInterval) {
                clearInterval(sessionData.updateInterval);
            }

            if (sessionData.autoCleanupTimeout) {
                clearTimeout(sessionData.autoCleanupTimeout);
            }

            const displayTimer = this.displayTimers.get(sessionId);
            if (displayTimer) {
                clearTimeout(displayTimer);
                this.displayTimers.delete(sessionId);
            }

            this.activeSessions.delete(sessionId);
            this.alertHistory.delete(sessionId);
            this.userUnitsCache.delete(sessionData.userId);
            console.log(`🧹 Sesión ${sessionId} limpiada manualmente`);
        }
    }
}

// Crear y iniciar el servidor
const server = new NightscoutMentraApp({
    packageName: PACKAGE_NAME,
    apiKey: MENTRAOS_API_KEY,
    port: PORT
});

server.start().catch(err => {
    console.error("❌ Error iniciando servidor:", err);
    process.exit(1);
});

console.log(`🚀 Nightscout MentraOS App iniciando...`);
console.log(`📱 Package: ${PACKAGE_NAME}`);
console.log(`🔌 Puerto: ${PORT}`);
console.log(`🥽 Optimizado para Even Realities G1`);
console.log(`⚙️ Sistema de Settings oficial habilitado`);
console.log(`👁️ Display inteligente activado`);
console.log(`🤖 AI Tools bilingües habilitados`);
console.log(`🇪🇸 Timezone España corregido`);
console.log(`🔔 Alertas configurables implementadas`);
console.log(`📊 Soporte mmol/L añadido`);
console.log(`🌍 Detección automática de zona horaria`);
