// src/index.js - Aplicación Nightscout MentraOS con Soporte Completo de Idioma/Región + Alertas Configurables

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

/**
 * NightscoutMentraApp - Aplicación MentraOS completa con soporte multi-idioma y alertas configurables
 */
class NightscoutMentraApp extends AppServer {
    constructor(options) {
        super(options);
        this.activeSessions = new Map();
        this.alertHistory = new Map();
        this.displayTimers = new Map();
        
        // Log de inicio
        console.log(`📦 SDK Version: ${require('@mentra/sdk/package.json').version}`);
        console.log(`🌍 Multi-language support enabled`);
        console.log(`🔔 Configurable alerts enabled`);
    }

    /**
     * Método principal onSession con diagnóstico completo
     */
    async onSession(session, sessionId, userId) {
        session.logger.info(`🚀 Nueva sesión iniciada: ${sessionId} para ${userId}`);
        
        try {
            // DIAGNÓSTICO COMPLETO DE SETTINGS
            session.logger.info('=== DIAGNÓSTICO COMPLETO DE SETTINGS ===');
            
            try {
                const url = await session.settings.get('nightscout_url');
                const token = await session.settings.get('nightscout_token');
                const lowAlert = await session.settings.get('low_alert');
                const highAlert = await session.settings.get('high_alert');
                const language = await session.settings.get('language');
                const region = await session.settings.get('region');
                const timezone = await session.settings.get('timezone');
                
                session.logger.info(`URL: "${url ? 'configurada' : 'no configurada'}"`);
                session.logger.info(`Token: "${token ? 'configurado' : 'no configurado'}"`);
                session.logger.info(`🔔 Alertas - Baja: ${lowAlert}, Alta: ${highAlert}`);
                session.logger.info(`🌍 Localización - Idioma: ${language}, Región: ${region}, Timezone: ${timezone}`);
                
            } catch (e) {
                session.logger.error('Error en diagnóstico de settings:', e);
            }
            
            session.logger.info('=== FIN DIAGNÓSTICO ===');

            // OBTENER CONFIGURACIÓN COMPLETA
            const userSettings = await this.getUserSettings(session);
            session.logger.info('⚙️ Settings finales procesados:', {
                hasUrl: !!userSettings.nightscoutUrl,
                hasToken: !!userSettings.nightscoutToken,
                language: userSettings.language,
                region: userSettings.region,
                timezone: userSettings.timezone,
                lowAlert: userSettings.lowAlert,
                highAlert: userSettings.highAlert
            });

            // VALIDAR CONFIGURACIÓN ESENCIAL
            if (!userSettings.nightscoutUrl || !userSettings.nightscoutToken) {
                await this.showConfigurationNeeded(session, userSettings);
                return;
            }

            // MOSTRAR DATOS INICIALES Y OCULTAR
            await this.showInitialAndHide(session, sessionId, userSettings);

            // INICIAR OPERACIÓN NORMAL
            await this.startNormalOperation(session, sessionId, userId, userSettings);

            // CONFIGURAR EVENT HANDLERS
            this.setupSafeEventHandlers(session, sessionId, userId);

            // LISTENER DE CAMBIOS DE CONFIGURACIÓN
            this.setupSettingsListener(session, sessionId, userId);

        } catch (error) {
            session.logger.error(`❌ Error en sesión: ${error.message}`);
            
            // Mensaje de error según idioma
            const errorMessage = await this.getErrorMessage(session, 'connection_error');
            session.layouts.showTextWall(errorMessage);
        }
    }

    /**
     * 🆕 MEJORADO: Obtener mensaje de error localizado
     */
    async getErrorMessage(session, errorType) {
        try {
            const language = await session.settings.get('language') || 'en';
            
            const messages = {
                connection_error: {
                    en: "Error: Check app settings\nin MentraOS app",
                    es: "Error: Revisa configuración\nen app MentraOS",
                    fr: "Erreur: Vérifiez les paramètres\ndans l'app MentraOS"
                },
                configuration_needed: {
                    en: "Please configure your\nNightscout URL and token\nin MentraOS app settings",
                    es: "Por favor configura tu\nURL y token de Nightscout\nen ajustes de MentraOS",
                    fr: "Veuillez configurer votre\nURL et token Nightscout\ndans les paramètres MentraOS"
                }
            };
            
            return messages[errorType][language] || messages[errorType].en;
        } catch (error) {
            return "Error: Check app settings";
        }
    }

    /**
     * Mostrar datos iniciales y ocultar automáticamente
     */
    async showInitialAndHide(session, sessionId, userSettings) {
        try {
            const glucoseData = await this.getGlucoseData(userSettings);
            const displayText = this.formatForG1(glucoseData, userSettings);
            
            session.layouts.showTextWall(displayText);
            session.logger.info('✅ Datos iniciales mostrados');
            
            // Ocultar después de 5 segundos
            setTimeout(() => {
                this.hideDisplay(session, sessionId);
            }, 5000);
            
        } catch (error) {
            session.logger.error('Error en display inicial:', error);
        }
    }

    /**
     * Ocultar display
     */
    hideDisplay(session, sessionId) {
        try {
            session.layouts.showTextWall("");
            session.logger.info(`🙈 Display ocultado para sesión ${sessionId}`);
        } catch (error) {
            session.logger.error('Error ocultando display:', error);
        }
    }

    /**
     * Mostrar glucosa temporalmente
     */
    async showGlucoseTemporarily(session, sessionId, duration = 8000) {
        try {
            const userSettings = await this.getUserSettings(session);
            const glucoseData = await this.getGlucoseData(userSettings);
            const displayText = this.formatForG1(glucoseData, userSettings);
            
            session.layouts.showTextWall(displayText);
            session.logger.info('👁️ Glucosa mostrada temporalmente');
            
            // Limpiar timer anterior
            const existingTimer = this.displayTimers.get(sessionId);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            // Ocultar después del tiempo especificado
            const hideTimer = setTimeout(() => {
                this.hideDisplay(session, sessionId);
                this.displayTimers.delete(sessionId);
            }, duration);

            this.displayTimers.set(sessionId, hideTimer);
            
        } catch (error) {
            session.logger.error('Error mostrando glucosa temporal:', error);
        }
    }

    /**
     * Configurar event handlers seguros
     */
    setupSafeEventHandlers(session, sessionId, userId) {
        try {
            // BUTTON PRESS - Mostrar glucosa
            if (session.events && typeof session.events.onButtonPress === 'function') {
                session.events.onButtonPress(async (buttonData) => {
                    session.logger.info(`🔘 Botón presionado: ${JSON.stringify(buttonData)}`);
                    await this.showGlucoseTemporarily(session, sessionId, 10000);
                });
            }

            // TRANSCRIPTION - Comandos de voz multiidioma
            if (session.events && typeof session.events.onTranscription === 'function') {
                session.events.onTranscription(async (transcription) => {
                    const text = transcription.text.toLowerCase();
                    
                    // Comandos en múltiples idiomas
                    const showCommands = [
                        // Inglés
                        'show glucose', 'glucose', 'sugar', 'level',
                        // Español
                        'mostrar glucosa', 'glucosa', 'azucar', 'nivel',
                        // Francés
                        'montrer glucose', 'glucose', 'sucre', 'niveau'
                    ];
                    
                    if (showCommands.some(cmd => text.includes(cmd))) {
                        session.logger.info(`🎤 Comando de voz reconocido: ${text}`);
                        await this.showGlucoseTemporarily(session, sessionId, 12000);
                    }
                });
            }

            // DISCONNECT HANDLER
            if (session.events && typeof session.events.onDisconnected === 'function') {
                const disconnectHandler = () => {
                    try {
                        session.logger.info(`👋 Sesión ${sessionId} desconectada`);
                        this.performCompleteCleanup(sessionId);
                    } catch (cleanupError) {
                        console.error(`❌ Error en cleanup: ${cleanupError.message}`);
                    }
                };

                session.events.onDisconnected(disconnectHandler);
                session.logger.info(`✅ Event handlers configurados para ${sessionId}`);
                
            } else {
                // Cleanup alternativo
                const sessionData = this.activeSessions.get(sessionId);
                if (sessionData) {
                    sessionData.autoCleanupTimeout = setTimeout(() => {
                        session.logger.info(`🧹 Auto-cleanup para sesión ${sessionId}`);
                        this.performCompleteCleanup(sessionId);
                    }, 1800000); // 30 minutos
                }
            }

        } catch (error) {
            session.logger.error(`❌ Error configurando event handlers: ${error.message}`);
        }
    }

    /**
     * 🆕 AI TOOLS para Mira con soporte multiidioma mejorado
     */
    async onToolCall(data) {
        const toolId = data.toolId || data.toolName;
        const userId = data.userId;
        const activeSession = data.activeSession;
        
        console.log(`🤖 AI Tool llamado: ${toolId} para usuario ${userId}`);
        
        try {
            // Detectar idioma preferido del usuario
            let userPreferredLang = 'en';
            if (activeSession && activeSession.settings && activeSession.settings.settings) {
                const languageSetting = activeSession.settings.settings.find(s => s.key === 'language');
                if (languageSetting) {
                    userPreferredLang = languageSetting.value || 'en';
                }
            }
            
            console.log(`🌍 Idioma detectado: ${userPreferredLang}`);

            // Determinar idioma de respuesta según herramienta
            let responseLanguage = userPreferredLang;
            
            // Herramientas específicas por idioma
            if (['get_glucose', 'glucose_level', 'blood_sugar'].includes(toolId)) {
                responseLanguage = 'en';
            } else if (['obtener_glucosa', 'revisar_glucosa', 'nivel_glucosa', 'mi_glucosa'].includes(toolId)) {
                responseLanguage = 'es';
            } else if (['obtenir_glucose', 'glucose', 'niveau_glucose'].includes(toolId)) {
                responseLanguage = 'fr';
            }

            return await this.handleGetGlucoseForMira(userId, activeSession, responseLanguage);

        } catch (error) {
            console.error('❌ Error en AI Tool:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * 🆕 MEJORADO: Manejar petición de glucosa desde Mira con multiidioma
     */
    async handleGetGlucoseForMira(userId, activeSession, lang) {
        try {
            console.log(`📋 Procesando petición de glucosa para ${userId} en ${lang}`);
            
            // Obtener settings
            let userSettings = null;
            let sessionForDisplay = null;
            
            if (activeSession && activeSession.settings && activeSession.settings.settings) {
                userSettings = this.parseSettingsFromArray(activeSession.settings.settings);
                sessionForDisplay = activeSession;
                console.log('✅ Settings obtenidos desde activeSession');
            } else {
                // Buscar en sesiones activas
                for (const [sessionId, sessionData] of this.activeSessions) {
                    if (sessionData.userId === userId) {
                        userSettings = await this.getUserSettings(sessionData.session);
                        sessionForDisplay = sessionData.session;
                        console.log('✅ Settings obtenidos desde sesión activa');
                        break;
                    }
                }
            }

            if (!userSettings || !userSettings.nightscoutUrl || !userSettings.nightscoutToken) {
                const errorMessages = {
                    en: "Nightscout is not configured. Configure URL and token in app settings.",
                    es: "Nightscout no está configurado. Configura la URL y token en los ajustes de la aplicación.",
                    fr: "Nightscout n'est pas configuré. Configurez l'URL et le token dans les paramètres de l'application."
                };
                
                return {
                    success: false,
                    error: errorMessages[lang] || errorMessages.en
                };
            }

            // Obtener datos de glucosa
            const glucoseData = await this.getGlucoseData(userSettings);
            
            if (!glucoseData) {
                const errorMessages = {
                    en: "No glucose data available.",
                    es: "No hay datos de glucosa disponibles.",
                    fr: "Aucune donnée de glucose disponible."
                };
                
                return {
                    success: false,
                    error: errorMessages[lang] || errorMessages.en
                };
            }

            // Mostrar en las gafas también
            if (sessionForDisplay) {
                try {
                    const displayText = this.formatForG1(glucoseData, userSettings);
                    if (sessionForDisplay.layouts) {
                        sessionForDisplay.layouts.showTextWall(displayText);
                        console.log('📱 Glucosa mostrada en gafas por Mira');
                        
                        setTimeout(() => {
                            if (sessionForDisplay.layouts) {
                                sessionForDisplay.layouts.showTextWall("");
                            }
                        }, 10000);
                    }
                } catch (displayError) {
                    console.error('Error mostrando en gafas:', displayError);
                }
            }

            // Respuesta para Mira en el idioma correcto
            const trend = this.getTrendArrow(glucoseData.direction);
            const status = this.getGlucoseStatusText(glucoseData.sgv, userSettings, lang);
            
            const messages = {
                en: `Your glucose is ${glucoseData.sgv} mg/dL ${trend}. Status: ${status}.`,
                es: `Tu glucosa está en ${glucoseData.sgv} mg/dL ${trend}. Estado: ${status}.`,
                fr: `Votre glucose est ${glucoseData.sgv} mg/dL ${trend}. État: ${status}.`
            };

            const message = messages[lang] || messages.en;
            console.log(`🤖 Respuesta para Mira: ${message}`);
            
            return {
                success: true,
                data: {
                    glucose: glucoseData.sgv,
                    trend: trend,
                    status: status
                },
                message: message
            };

        } catch (error) {
            console.error('❌ Error en handleGetGlucoseForMira:', error);
            const errorMessages = {
                en: `Error getting glucose: ${error.message}`,
                es: `Error obteniendo glucosa: ${error.message}`,
                fr: `Erreur lors de l'obtention du glucose: ${error.message}`
            };
            
            return {
                success: false,
                error: errorMessages[lang] || errorMessages.en
            };
        }
    }

    /**
     * 🆕 NUEVO: Obtener estado de glucosa en texto multiidioma
     */
    getGlucoseStatusText(value, settings, lang) {
        const statusTexts = {
            critical_low: {
                en: 'Critical Low',
                es: 'Crítico Bajo',
                fr: 'Critique Bas'
            },
            low: {
                en: 'Low',
                es: 'Bajo',
                fr: 'Bas'
            },
            normal: {
                en: 'Normal',
                es: 'Normal',
                fr: 'Normal'
            },
            high: {
                en: 'High',
                es: 'Alto',
                fr: 'Élevé'
            },
            critical_high: {
                en: 'Critical High',
                es: 'Crítico Alto',
                fr: 'Critique Élevé'
            }
        };

        let statusKey = 'normal';
        
        if (value < 70) {
            statusKey = 'critical_low';
        } else if (value < settings.lowAlert) {
            statusKey = 'low';
        } else if (value > 250) {
            statusKey = 'critical_high';
        } else if (value > settings.highAlert) {
            statusKey = 'high';
        }
        
        return statusTexts[statusKey][lang] || statusTexts[statusKey].en;
    }

    /**
     * Parsear settings desde array de MentraOS
     */
    parseSettingsFromArray(settingsArray) {
        const settings = {};
        for (const setting of settingsArray) {
            settings[setting.key] = setting.value;
        }

        return {
            nightscoutUrl: settings.nightscout_url?.trim(),
            nightscoutToken: settings.nightscout_token?.trim(),
            updateInterval: parseInt(settings.update_interval) || 5,
            lowAlert: parseInt(settings.low_alert) || 70,
            highAlert: parseInt(settings.high_alert) || 180,
            alertsEnabled: settings.alerts_enabled === 'true' || settings.alerts_enabled === true,
            language: settings.language || 'en',
            region: settings.region || 'default',
            timezone: settings.timezone || null
        };
    }

    /**
     * 🆕 NUEVO: Validar timezone
     */
    isValidTimezone(timezone) {
        try {
            Intl.DateTimeFormat(undefined, { timeZone: timezone });
            return true;
        } catch (error) {
            console.warn(`⚠️ Timezone inválido: ${timezone}`);
            return false;
        }
    }

    /**
     * 🆕 NUEVO: Obtener timezone por idioma y región
     */
    getTimezoneByLanguageRegion(language, region) {
        const timezoneMap = {
            'es': {
                'ES': 'Europe/Madrid',
                'MX': 'America/Mexico_City',
                'AR': 'America/Argentina/Buenos_Aires',
                'CO': 'America/Bogota',
                'PE': 'America/Lima',
                'CL': 'America/Santiago',
                'VE': 'America/Caracas',
                'default': 'Europe/Madrid'
            },
            'en': {
                'US': 'America/New_York',
                'GB': 'Europe/London',
                'CA': 'America/Toronto',
                'AU': 'Australia/Sydney',
                'default': 'America/New_York'
            },
            'fr': {
                'FR': 'Europe/Paris',
                'CA': 'America/Montreal',
                'default': 'Europe/Paris'
            }
        };

        const langMap = timezoneMap[language] || timezoneMap['en'];
        return langMap[region] || langMap['default'] || 'UTC';
    }

    /**
     * 🆕 NUEVO: Obtener locale desde settings
     */
    getLocaleFromSettings(settings) {
        const localeMap = {
            'es': {
                'ES': 'es-ES',
                'MX': 'es-MX',
                'AR': 'es-AR',
                'CO': 'es-CO',
                'default': 'es-ES'
            },
            'en': {
                'US': 'en-US',
                'GB': 'en-GB',
                'CA': 'en-CA',
                'AU': 'en-AU',
                'default': 'en-US'
            },
            'fr': {
                'FR': 'fr-FR',
                'CA': 'fr-CA',
                'default': 'fr-FR'
            }
        };

        const language = settings.language || 'en';
        const region = settings.region || 'default';
        const langMap = localeMap[language] || localeMap['en'];
        
        return langMap[region] || langMap['default'] || 'en-US';
    }

    /**
     * 🆕 FUNCIÓN MEJORADA: Validar rangos de alertas
     */
    validateAlertRanges(settings) {
        const MIN_LOW = 40;
        const MAX_LOW = 90;
        const MIN_HIGH = 180;
        const MAX_HIGH = 400;
        
        const validatedLow = Math.max(MIN_LOW, Math.min(MAX_LOW, settings.lowAlert));
        const validatedHigh = Math.max(MIN_HIGH, Math.min(MAX_HIGH, settings.highAlert));
        
        if (validatedLow !== settings.lowAlert || validatedHigh !== settings.highAlert) {
            console.log(`🔔 Alertas ajustadas - Original: L${settings.lowAlert}/H${settings.highAlert} → Validado: L${validatedLow}/H${validatedHigh}`);
        }
        
        return {
            ...settings,
            lowAlert: validatedLow,
            highAlert: validatedHigh
        };
    }

    /**
     * 🆕 FUNCIÓN EXPANDIDA: Obtener configuración con soporte completo de región
     */
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
                region,
                timezone
            ] = await Promise.all([
                session.settings.get('nightscout_url'),
                session.settings.get('nightscout_token'),
                session.settings.get('update_interval'),
                session.settings.get('low_alert'),
                session.settings.get('high_alert'),
                session.settings.get('alerts_enabled'),
                session.settings.get('language'),
                session.settings.get('region'),
                session.settings.get('timezone')
            ]);

            const settings = {
                nightscoutUrl: nightscoutUrl?.trim(),
                nightscoutToken: nightscoutToken?.trim(),
                updateInterval: parseInt(updateInterval) || 5,
                lowAlert: parseInt(lowAlert) || 70,
                highAlert: parseInt(highAlert) || 180,
                alertsEnabled: alertsEnabled === 'true' || alertsEnabled === true,
                language: language || 'en',
                region: region || 'default',
                timezone: timezone || null
            };

            console.log(`🌍 Settings procesados - Idioma: ${settings.language}, Región: ${settings.region}, Timezone: ${settings.timezone}`);

            return this.validateAlertRanges(settings);

        } catch (error) {
            session.logger.error('Error obteniendo settings:', error);
            return {
                nightscoutUrl: null,
                nightscoutToken: null,
                updateInterval: 5,
                lowAlert: 70,
                highAlert: 180,
                alertsEnabled: true,
                language: 'en',
                region: 'default',
                timezone: null
            };
        }
    }

    /**
     * 🆕 MEJORADA: Mostrar mensaje de configuración necesaria localizado
     */
    async showConfigurationNeeded(session, settings) {
        const message = await this.getErrorMessage(session, 'configuration_needed');
        session.layouts.showTextWall(message);
        session.logger.info('Configuración requerida mostrada al usuario');
    }

    /**
     * Iniciar operación normal
     */
    async startNormalOperation(session, sessionId, userId, settings) {
        session.logger.info(`🚀 Iniciando operación normal para ${userId}`);
        
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
                    const newData = await this.getGlucoseData(currentSettings);
                    
                    // Solo revisar alertas críticas
                    if (currentSettings.alertsEnabled) {
                        await this.checkAlerts(session, sessionId, newData, currentSettings);
                    }

                    session.logger.debug(`🔄 Monitoreo: ${newData.sgv} mg/dL`);
                    
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
            const errorMessage = await this.getErrorMessage(session, 'connection_error');
            session.layouts.showTextWall(errorMessage);
        }
    }

    /**
     * Configurar listener de settings
     */
    setupSettingsListener(session, sessionId, userId) {
        session.logger.info(`⚙️ Settings listener configurado para ${sessionId}`);
    }

    /**
     * Obtener datos de glucosa desde Nightscout
     */
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

    /**
     * 🆕 COMPLETAMENTE REESCRITA: Formatear datos con timezone dinámico
     */
    formatForG1(glucoseData, settings) {
        const glucoseValue = glucoseData.sgv;
        const trend = this.getTrendArrow(glucoseData.direction);

        // TIMEZONE DINÁMICO CON VALIDACIÓN COMPLETA
        let timeZone = 'UTC';
        
        try {
            // 1. PRIORIDAD: Timezone configurado por el usuario
            if (settings.timezone && this.isValidTimezone(settings.timezone)) {
                timeZone = settings.timezone;
                console.log(`✅ Usando timezone del usuario: ${timeZone}`);
            } 
            // 2. FALLBACK: Detectar por idioma/región
            else if (settings.language && settings.region) {
                timeZone = this.getTimezoneByLanguageRegion(settings.language, settings.region);
                console.log(`✅ Timezone por idioma/región: ${timeZone}`);
            }
            // 3. ÚLTIMO RECURSO: Detectar del sistema
            else {
                timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                console.log(`✅ Timezone del sistema: ${timeZone}`);
            }
        } catch (error) {
            console.warn(`⚠️ Error con timezone, usando UTC: ${error.message}`);
            timeZone = 'UTC';
        }

        // FORMATEAR TIEMPO CON LOCALE CORRECTO
        const locale = this.getLocaleFromSettings(settings);
        const time = new Date().toLocaleTimeString(locale, {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: timeZone
        });

        // Símbolos según configuración
        let symbol = '*';
        if (glucoseValue < settings.lowAlert) symbol = '!';
        else if (glucoseValue > settings.highAlert) symbol = '^';

        return `${symbol} ${glucoseValue} mg/dL ${trend}\n${time}`;
    }

    /**
     * Obtener flecha de tendencia
     */
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

    /**
     * 🆕 MEJORADA: Verificar alertas con configuración personalizada y multiidioma
     */
    async checkAlerts(session, sessionId, glucoseData, settings) {
        const glucoseValue = glucoseData.sgv;
        const currentTime = Date.now();

        // Evitar spam de alertas
        const lastAlert = this.alertHistory.get(sessionId);
        if (lastAlert && (currentTime - lastAlert) < 600000) {
            return;
        }

        let alertMessage = null;
        let alertDuration = 15000;

        const messages = {
            en: {
                low: `🚨 LOW GLUCOSE ALERT!\n${glucoseValue} mg/dL\nCheck immediately`,
                high: `🚨 HIGH GLUCOSE ALERT!\n${glucoseValue} mg/dL\nTake action`
            },
            es: {
                low: `🚨 ALERTA GLUCOSA BAJA!\n${glucoseValue} mg/dL\nRevisar inmediatamente`,
                high: `🚨 ALERTA GLUCOSA ALTA!\n${glucoseValue} mg/dL\nTomar medidas`
            },
            fr: {
                low: `🚨 ALERTE GLUCOSE BAS!\n${glucoseValue} mg/dL\nVérifier immédiatement`,
                high: `🚨 ALERTE GLUCOSE ÉLEVÉ!\n${glucoseValue} mg/dL\nAgir maintenant`
            }
        };

        const lang = settings.language || 'en';
        const langMessages = messages[lang] || messages.en;

        // USAR CONFIGURACIÓN PERSONALIZADA
        if (glucoseValue < settings.lowAlert) {
            alertMessage = langMessages.low;
            alertDuration = 20000;
            session.logger.warn(`🔔 Alerta baja: ${glucoseValue} < ${settings.lowAlert}`);
        } else if (glucoseValue > settings.highAlert) {
            alertMessage = langMessages.high;
            alertDuration = 15000;
            session.logger.warn(`🔔 Alerta alta: ${glucoseValue} > ${settings.highAlert}`);
        }

        if (alertMessage) {
            session.layouts.showTextWall(alertMessage);
            this.alertHistory.set(sessionId, currentTime);
            session.logger.error(`🚨 Alerta mostrada: ${glucoseValue} mg/dL (límites: ${settings.lowAlert}-${settings.highAlert})`);

            // Limpiar timer anterior
            const existingTimer = this.displayTimers.get(sessionId);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            // Ocultar alerta después del tiempo especificado
            const alertTimer = setTimeout(() => {
                this.hideDisplay(session, sessionId);
                this.displayTimers.delete(sessionId);
                session.logger.info(`🙈 Alerta ocultada para ${sessionId}`);
            }, alertDuration);

            this.displayTimers.set(sessionId, alertTimer);
        }
    }

    /**
     * 🆕 MEJORADO: Manejar paradas por cambios de configuración
     */
    async onStop(session, sessionId, userId) {
        try {
            session.logger.info(`🛑 Parada solicitada para ${userId} - detectando cambios de configuración`);
            
            // Cleanup inmediato
            this.performCompleteCleanup(sessionId);
            
            // Log de nuevos settings si están disponibles
            try {
                const newSettings = await this.getUserSettings(session);
                session.logger.info(`🔄 Configuración detectada:`, {
                    language: newSettings.language,
                    region: newSettings.region,
                    timezone: newSettings.timezone,
                    lowAlert: newSettings.lowAlert,
                    highAlert: newSettings.highAlert
                });
            } catch (settingsError) {
                session.logger.warn('No se pudieron obtener nuevos settings:', settingsError.message);
            }
            
            // Desconexión segura
            if (session && typeof session.disconnect === 'function') {
                await session.disconnect();
                session.logger.info(`✅ Sesión desconectada correctamente`);
            } else {
                session.logger.warn(`⚠️ session.disconnect no disponible - cleanup manual completado`);
            }
            
            session.logger.info(`🏁 Parada completada para ${sessionId}`);
            
        } catch (error) {
            console.error(`❌ Error en onStop: ${error.message}`);
            this.performCompleteCleanup(sessionId);
        }
    }

    /**
     * 🆕 NUEVO: Cleanup completo y robusto
     */
    performCompleteCleanup(sessionId) {
        try {
            console.log(`🧹 Iniciando cleanup completo para ${sessionId}`);
            
            const sessionData = this.activeSessions.get(sessionId);
            if (sessionData) {
                if (sessionData.updateInterval) {
                    clearInterval(sessionData.updateInterval);
                    console.log(`✅ Update interval limpiado`);
                }
                if (sessionData.autoCleanupTimeout) {
                    clearTimeout(sessionData.autoCleanupTimeout);
                    console.log(`✅ Auto-cleanup timeout limpiado`);
                }
            }
            
            const displayTimer = this.displayTimers.get(sessionId);
            if (displayTimer) {
                clearTimeout(displayTimer);
                this.displayTimers.delete(sessionId);
                console.log(`✅ Display timer limpiado`);
            }

            this.activeSessions.delete(sessionId);
            this.alertHistory.delete(sessionId);
            
            console.log(`✅ Cleanup completo finalizado para ${sessionId}`);
            
        } catch (error) {
            console.error(`❌ Error en cleanup completo: ${error.message}`);
            // Forzar limpieza básica
            this.activeSessions.delete(sessionId);
            this.alertHistory.delete(sessionId);
            this.displayTimers.delete(sessionId);
        }
    }

    /**
     * Método adicional para cleanup manual
     */
    cleanupSession(sessionId) {
        this.performCompleteCleanup(sessionId);
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
console.log(`🤖 AI Tools multiidioma habilitados`);
console.log(`🌍 Soporte completo de idioma/región/timezone`);
console.log(`🔔 Alertas configurables implementadas`);
