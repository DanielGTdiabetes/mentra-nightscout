// src/index.js - Aplicación Nightscout MentraOS Completa con Correcciones + MEJORAS MÍNIMAS + ALERTAS CONFIGURABLES

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
 * NightscoutMentraApp - Aplicación MentraOS para mostrar datos de glucosa
 * Con sistema oficial de Settings y manejo seguro de eventos
 */
class NightscoutMentraApp extends AppServer {
    constructor(options) {
        super(options);
        this.activeSessions = new Map();
        this.alertHistory = new Map();
        this.displayTimers = new Map(); // 🆕 NUEVO: Para controlar display inteligente
    }

    /**
     * Método principal onSession con manejo seguro de eventos
     */
    async onSession(session, sessionId, userId) {
        session.logger.info(`Nueva sesión oficial: ${sessionId} para ${userId}`);
        
        try {
            // DIAGNÓSTICO: Probar todos los settings individualmente
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

            // 🆕 DIAGNÓSTICO DE ALERTAS
            try {
                const lowAlert = await session.settings.get('low_alert');
                const highAlert = await session.settings.get('high_alert');
                session.logger.info(`🔔 Alertas configuradas - Baja: ${lowAlert}, Alta: ${highAlert}`);
            } catch (e) {
                session.logger.error('Error getting alert settings:', e);
            }

            session.logger.info('=== FIN DIAGNÓSTICO ===');

            // PASO 1: Obtener configuración del usuario
            const userSettings = await this.getUserSettings(session);
            session.logger.info('Settings finales obtenidos:', {
                hasUrl: !!userSettings.nightscoutUrl,
                hasToken: !!userSettings.nightscoutToken,
                language: userSettings.language,
                lowAlert: userSettings.lowAlert,  // 🆕 NUEVO
                highAlert: userSettings.highAlert // 🆕 NUEVO
            });

            // PASO 2: Validar configuración esencial
            if (!userSettings.nightscoutUrl || !userSettings.nightscoutToken) {
                await this.showConfigurationNeeded(session, userSettings);
                return;
            }

            // PASO 3: 🆕 MOSTRAR INICIAL Y OCULTAR (Display inteligente)
            await this.showInitialAndHide(session, sessionId, userSettings);

            // PASO 4: Iniciar operación normal con settings oficiales (MODIFICADO)
            await this.startNormalOperation(session, sessionId, userId, userSettings);

            // PASO 5: MANEJO SEGURO DE EVENTOS (EXPANDIDO con gestos)
            this.setupSafeEventHandlers(session, sessionId, userId);

            // PASO 6: Escuchar cambios de configuración EN TIEMPO REAL
            this.setupSettingsListener(session, sessionId, userId);

        } catch (error) {
            session.logger.error(`Error en sesión: ${error.message}`);
            session.layouts.showTextWall("Error: Check app settings\nin MentraOS app");
        }
    }

    /**
     * 🆕 NUEVO: Mostrar inicial y ocultar (Display inteligente)
     */
    async showInitialAndHide(session, sessionId, userSettings) {
        try {
            const glucoseData = await this.getGlucoseData(userSettings);
            const displayText = this.formatForG1(glucoseData, userSettings);
            
            // Mostrar datos iniciales
            session.layouts.showTextWall(displayText);
            session.logger.info('✅ Datos iniciales mostrados');
            
            // OCULTAR después de 5 segundos
            setTimeout(() => {
                this.hideDisplay(session, sessionId);
            }, 5000);
            
        } catch (error) {
            session.logger.error('Error en display inicial:', error);
        }
    }

    /**
     * 🆕 NUEVO: Ocultar display
     */
    hideDisplay(session, sessionId) {
        try {
            session.layouts.showTextWall(""); // Pantalla vacía
            session.logger.info(`🙈 Display ocultado para sesión ${sessionId}`);
        } catch (error) {
            session.logger.error('Error ocultando display:', error);
        }
    }

    /**
     * 🆕 NUEVO: Mostrar glucosa temporalmente
     */
    async showGlucoseTemporarily(session, sessionId, duration = 8000) {
        try {
            const userSettings = await this.getUserSettings(session);
            const glucoseData = await this.getGlucoseData(userSettings);
            const displayText = this.formatForG1(glucoseData, userSettings);
            
            // Mostrar datos
            session.layouts.showTextWall(displayText);
            session.logger.info('👁️ Glucosa mostrada temporalmente');
            
            // Limpiar timer anterior si existe
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
     * NUEVO MÉTODO: Configurar event handlers de manera segura (EXPANDIDO)
     */
    setupSafeEventHandlers(session, sessionId, userId) {
        try {
            // 🆕 1. BUTTON PRESS - Mostrar glucosa al presionar botón
            if (session.events && typeof session.events.onButtonPress === 'function') {
                session.events.onButtonPress(async (buttonData) => {
                    session.logger.info(`🔘 Botón presionado: ${JSON.stringify(buttonData)}`);
                    await this.showGlucoseTemporarily(session, sessionId, 10000);
                });
            }

            // 🆕 2. TRANSCRIPTION - Comandos de voz
            if (session.events && typeof session.events.onTranscription === 'function') {
                session.events.onTranscription(async (transcription) => {
                    const text = transcription.text.toLowerCase();
                    
                    // Comandos para mostrar glucosa
                    const showCommands = [
                        'show glucose', 'mostrar glucosa', 'glucose', 'glucosa',
                        'sugar', 'azucar', 'nivel', 'level'
                    ];
                    
                    if (showCommands.some(cmd => text.includes(cmd))) {
                        session.logger.info(`🎤 Comando de voz reconocido: ${text}`);
                        await this.showGlucoseTemporarily(session, sessionId, 12000);
                    }
                });
            }

            // 3. DISCONNECT HANDLER (tu código original + limpieza de timers)
            if (session.events && typeof session.events.onDisconnected === 'function') {
                const disconnectHandler = () => {
                    try {
                        session.logger.info(`👋 Sesión ${sessionId} desconectada`);
                        
                        // 🆕 Limpiar timer de display
                        const displayTimer = this.displayTimers.get(sessionId);
                        if (displayTimer) {
                            clearTimeout(displayTimer);
                            this.displayTimers.delete(sessionId);
                        }

                        // Limpiar recursos de manera segura (tu código original)
                        const userSession = this.activeSessions.get(sessionId);
                        if (userSession && userSession.updateInterval) {
                            clearInterval(userSession.updateInterval);
                        }

                        if (userSession && userSession.autoCleanupTimeout) {
                            clearTimeout(userSession.autoCleanupTimeout);
                        }

                        // Remover sesión y alertas
                        this.activeSessions.delete(sessionId);
                        this.alertHistory.delete(sessionId);
                        
                    } catch (cleanupError) {
                        console.error(`❌ Error en cleanup de sesión ${sessionId}:`, cleanupError);
                    }
                };

                // Registrar el event listener con verificación
                session.events.onDisconnected(disconnectHandler);
                session.logger.info(`✅ Event handler registrado para sesión ${sessionId}`);
                
            } else {
                session.logger.warn('⚠️ session.events.onDisconnected no disponible, usando cleanup alternativo');
                
                // Cleanup alternativo usando timeout (tu código original + timer)
                const sessionData = this.activeSessions.get(sessionId);
                if (sessionData) {
                    sessionData.autoCleanupTimeout = setTimeout(() => {
                        session.logger.info(`🧹 Auto-cleanup para sesión ${sessionId}`);
                        
                        const userSession = this.activeSessions.get(sessionId);
                        if (userSession && userSession.updateInterval) {
                            clearInterval(userSession.updateInterval);
                        }

                        // 🆕 Limpiar timer de display
                        const displayTimer = this.displayTimers.get(sessionId);
                        if (displayTimer) {
                            clearTimeout(displayTimer);
                            this.displayTimers.delete(sessionId);
                        }

                        this.activeSessions.delete(sessionId);
                        this.alertHistory.delete(sessionId);
                    }, 1800000); // 30 minutos
                }
            }

        } catch (error) {
            session.logger.error(`❌ Error configurando event handlers: ${error.message}`);
        }
    }

    /**
     * 🆕 AI TOOLS para Mira (BILINGÜE INTELIGENTE)
     */
    async onToolCall(data) {
        // MentraOS pasa los datos en una estructura específica
        const toolId = data.toolId || data.toolName;
        const userId = data.userId;
        const activeSession = data.activeSession;
        
        console.log(`🤖 AI Tool called: ${toolId} for user ${userId}`);
        
        try {
            // 🆕 DETECTAR IDIOMA PREFERIDO del usuario
            let userPreferredLang = 'en'; // Default
            if (activeSession && activeSession.settings && activeSession.settings.settings) {
                const languageSetting = activeSession.settings.settings.find(s => s.key === 'language');
                if (languageSetting) {
                    userPreferredLang = languageSetting.value === 'es' ? 'es' : 'en';
                }
            }
            
            console.log(`🌍 Idioma preferido del usuario: ${userPreferredLang}`);

            switch (toolId) {
                // 🇺🇸 HERRAMIENTAS EN INGLÉS - Responder en inglés siempre
                case 'get_glucose':
                case 'glucose_level':
                case 'blood_sugar':
                    console.log(`🇺🇸 Tool específicamente inglés - respondiendo en inglés`);
                    return await this.handleGetGlucoseForMira(userId, activeSession, 'en');

                // 🇪🇸 HERRAMIENTAS EN ESPAÑOL - Responder en español siempre
                case 'obtener_glucosa':
                case 'revisar_glucosa':
                case 'nivel_glucosa':
                case 'mi_glucosa':
                    console.log(`🇪🇸 Tool específicamente español - respondiendo en español`);
                    return await this.handleGetGlucoseForMira(userId, activeSession, 'es');

                // 🌍 HERRAMIENTAS GENÉRICAS - Usar preferencia del usuario
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

    /**
     * 🆕 Manejar petición de glucosa desde Mira (CORREGIDO)
     */
    async handleGetGlucoseForMira(userId, activeSession, lang) {
        try {
            console.log(`📋 Processing glucose request for ${userId} in ${lang}`);
            
            // Obtener settings desde la sesión activa
            let userSettings = null;
            let sessionForDisplay = null;
            
            // Intentar obtener settings desde activeSession si está disponible
            if (activeSession && activeSession.settings && activeSession.settings.settings) {
                const settingsArray = activeSession.settings.settings;
                userSettings = this.parseSettingsFromArray(settingsArray);
                sessionForDisplay = activeSession;
                console.log('✅ Settings obtenidos desde activeSession');
            } else {
                // Fallback: buscar en sesiones activas
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
                const errorMsg = lang === 'es' ?
                    "Nightscout no está configurado. Configura la URL y token en los ajustes de la aplicación." :
                    "Nightscout is not configured. Configure URL and token in app settings.";
                console.log('❌ Settings no disponibles');
                return {
                    success: false,
                    error: errorMsg
                };
            }

            // Obtener datos de glucosa
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
            
            // 🆕 Mostrar en las gafas también si hay sesión disponible
            if (sessionForDisplay) {
                try {
                    const displayText = this.formatForG1(glucoseData, userSettings);
                    if (sessionForDisplay.layouts) {
                        sessionForDisplay.layouts.showTextWall(displayText);
                        console.log('📱 Glucosa mostrada en gafas por Mira');
                        
                        // Ocultar después de 10 segundos
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

            // Respuesta para Mira
            const trend = this.getTrendArrow(glucoseData.direction);
            const status = this.getGlucoseStatusText(glucoseData.sgv, userSettings, lang);
            
            const message = lang === 'es' ?
                `Tu glucosa está en ${glucoseData.sgv} mg/dL ${trend}. Estado: ${status}.` :
                `Your glucose is ${glucoseData.sgv} mg/dL ${trend}. Status: ${status}.`;

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
            const errorMsg = lang === 'es' ?
                `Error obteniendo glucosa: ${error.message}` :
                `Error getting glucose: ${error.message}`;
            return {
                success: false,
                error: errorMsg
            };
        }
    }

    /**
     * 🆕 Parsear settings desde array de MentraOS
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
            lowAlert: parseInt(settings.low_alert) || 70,    // 🆕 CORREGIDO
            highAlert: parseInt(settings.high_alert) || 180, // 🆕 CORREGIDO
            alertsEnabled: settings.alerts_enabled === 'true' || settings.alerts_enabled === true,
            language: settings.language || 'en',
            timezone: settings.timezone || null
        };
    }

    /**
     * 🆕 Obtener estado de glucosa en texto
     */
    getGlucoseStatusText(value, settings, lang) {
        if (value < 70) {
            return lang === 'es' ? 'Crítico Bajo' : 'Critical Low';
        }
        
        if (value < settings.lowAlert) {
            return lang === 'es' ? 'Bajo' : 'Low';
        }
        
        if (value > 250) {
            return lang === 'es' ? 'Crítico Alto' : 'Critical High';
        }
        
        if (value > settings.highAlert) {
            return lang === 'es' ? 'Alto' : 'High';
        }
        
        return lang === 'es' ? 'Normal' : 'Normal';
    }

    /**
     * 🆕 NUEVA FUNCIÓN: Validar rangos de alertas
     */
    validateAlertRanges(settings) {
        // Rangos permitidos según tu descripción de la app Mentra
        const MIN_LOW = 40;
        const MAX_LOW = 90;
        const MIN_HIGH = 180;
        const MAX_HIGH = 400;
        
        // Validar y ajustar si está fuera de rango
        const validatedLow = Math.max(MIN_LOW, Math.min(MAX_LOW, settings.lowAlert));
        const validatedHigh = Math.max(MIN_HIGH, Math.min(MAX_HIGH, settings.highAlert));
        
        console.log(`🔔 Validación de alertas - Original: L${settings.lowAlert}/H${settings.highAlert} → Validado: L${validatedLow}/H${validatedHigh}`);
        
        return {
            ...settings,
            lowAlert: validatedLow,
            highAlert: validatedHigh
        };
    }

    /**
     * Obtener configuración del usuario usando el sistema oficial de Settings (EXPANDIDO con timezone + VALIDACIÓN)
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
                timezone // 🆕 NUEVO setting para timezone
            ] = await Promise.all([
                session.settings.get('nightscout_url'),
                session.settings.get('nightscout_token'),
                session.settings.get('update_interval'),
                session.settings.get('low_alert'),
                session.settings.get('high_alert'),
                session.settings.get('alerts_enabled'),
                session.settings.get('language'),
                session.settings.get('timezone') // 🆕 NUEVO
            ]);

            const settings = {
                nightscoutUrl: nightscoutUrl?.trim(),
                nightscoutToken: nightscoutToken?.trim(),
                updateInterval: parseInt(updateInterval) || 5,
                lowAlert: parseInt(lowAlert) || 70,
                highAlert: parseInt(highAlert) || 180,
                alertsEnabled: alertsEnabled === 'true' || alertsEnabled === true,
                language: language || 'en',
                timezone: timezone || null // 🆕 NUEVO campo
            };

            // 🆕 APLICAR VALIDACIÓN DE RANGOS
            return this.validateAlertRanges(settings);

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
                timezone: null // 🆕 NUEVO campo
            };
        }
    }

    /**
     * Mostrar mensaje de configuración necesaria (TU CÓDIGO ORIGINAL)
     */
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

    /**
     * Iniciar operación normal con settings oficiales (LIGERAMENTE MODIFICADO)
     */
    async startNormalOperation(session, sessionId, userId, settings) {
        session.logger.info(`Iniciando con settings oficiales para ${userId}`);
        
        // Almacenar sesión con datos adicionales
        this.activeSessions.set(sessionId, {
            session,
            userId,
            settings,
            updateInterval: null,
            autoCleanupTimeout: null
        });

        try {
            // 🆕 MONITOREO SILENCIOSO - No mostrar datos automáticamente
            const intervalMs = settings.updateInterval * 60 * 1000;
            const updateInterval = setInterval(async () => {
                try {
                    // Verificar que la sesión sigue activa
                    if (!this.activeSessions.has(sessionId)) {
                        clearInterval(updateInterval);
                        return;
                    }

                    const currentSettings = await this.getUserSettings(session);
                    const newData = await this.getGlucoseData(currentSettings);
                    
                    // ❌ NO mostrar datos automáticamente (solo monitoreo silencioso)
                    // ✅ Solo revisar alertas críticas
                    if (currentSettings.alertsEnabled) {
                        await this.checkAlerts(session, sessionId, newData, currentSettings);
                    }

                    session.logger.debug(`🔄 Monitoreo silencioso: ${newData.sgv} mg/dL`);
                    
                } catch (error) {
                    session.logger.error('Error en update automático:', error);
                }
            }, intervalMs);

            // Guardar intervalo para cleanup
            const userSession = this.activeSessions.get(sessionId);
            if (userSession) {
                userSession.updateInterval = updateInterval;
            }

            // ✅ Event handlers se configuran en setupSafeEventHandlers()
            // ❌ NO hacer session.events.onDisconnected() aquí

        } catch (error) {
            session.logger.error('Error iniciando operación:', error);
            session.layouts.showTextWall("Error: Check Nightscout\nconnection in settings");
        }
    }

    /**
     * Configurar listener para cambios de settings en tiempo real (TU CÓDIGO ORIGINAL)
     */
    setupSettingsListener(session, sessionId, userId) {
        // Si el SDK soporta listeners de settings, configurar aquí
        // De momento, los cambios se detectan en cada update automático
        session.logger.info(`Settings listener configurado para ${sessionId}`);
    }

    /**
     * Obtener datos de glucosa desde Nightscout (TU CÓDIGO ORIGINAL)
     */
    async getGlucoseData(settings) {
        try {
            // 🆕 AÑADIR ESTAS LÍNEAS DE LIMPIEZA DE URL
            let cleanUrl = settings.nightscoutUrl?.trim();
            if (!cleanUrl) {
                throw new Error('URL de Nightscout no configurada');
            }

            // Asegurar protocolo HTTPS
            if (!cleanUrl.startsWith('http')) {
                cleanUrl = 'https://' + cleanUrl;
            }

            // 🎯 ESTA ES LA LÍNEA CLAVE PARA PREVENIR EL ERROR
            cleanUrl = cleanUrl.replace(/\/$/, ''); // Remover barra final si existe

            // Construir URL completa del endpoint usando la URL limpia
            const fullUrl = `${cleanUrl}/api/v1/entries/current.json`;
            // 🆕 FIN DE LAS LÍNEAS NUEVAS

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
     * Formatear datos para Even Realities G1 (TIMEZONE INTELIGENTE)
     */
    formatForG1(glucoseData, settings) {
        const glucoseValue = glucoseData.sgv;
        const trend = this.getTrendArrow(glucoseData.direction);

        // 🌍 TIMEZONE INTELIGENTE - Detectar automáticamente la zona horaria del usuario
        let timeZone = 'UTC'; // Fallback por defecto

        try {
            // Intentar detectar timezone del usuario desde settings
            if (settings.timezone) {
                timeZone = settings.timezone;
            } else {
                // Fallback: usar Intl.DateTimeFormat para detectar timezone del servidor/cliente
                timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            }
        } catch (error) {
            // Si falla todo, usar timezone basado en idioma como aproximación
            if (settings.language === 'es') {
                timeZone = 'Europe/Madrid'; // España por defecto para español
            } else if (settings.language === 'en') {
                timeZone = 'America/New_York'; // EST por defecto para inglés
            } else {
                timeZone = 'UTC'; // UTC como último recurso
            }
        }

        const time = new Date().toLocaleTimeString(settings.language === 'es' ? 'es-ES' : 'en-US', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: timeZone // ✅ Usar timezone detectado automáticamente
        });

        // Símbolos según configuración del usuario
        let symbol = '*';
        if (glucoseValue < settings.lowAlert) symbol = '!';
        else if (glucoseValue > settings.highAlert) symbol = '^';

        return `${symbol} ${glucoseValue} mg/dL ${trend}\n${time}`;
    }

    /**
     * Obtener flecha de tendencia (TU CÓDIGO ORIGINAL)
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
     * ✅ FUNCIÓN MODIFICADA: Verificar y mostrar alertas CON CONFIGURACIÓN PERSONALIZADA
     */
    async checkAlerts(session, sessionId, glucoseData, settings) {
        const glucoseValue = glucoseData.sgv;
        const currentTime = Date.now();

        // Evitar spam de alertas (máximo una cada 10 minutos)
        const lastAlert = this.alertHistory.get(sessionId);
        if (lastAlert && (currentTime - lastAlert) < 600000) {
            return;
        }

        let alertMessage = null;
        let alertDuration = 15000; // 15 segundos por defecto

        const messages = {
            en: {
                low: `🚨 LOW GLUCOSE ALERT!\n${glucoseValue} mg/dL\nCheck immediately`,
                high: `🚨 HIGH GLUCOSE ALERT!\n${glucoseValue} mg/dL\nTake action`
            },
            es: {
                low: `🚨 ALERTA GLUCOSA BAJA!\n${glucoseValue} mg/dL\nRevisar inmediatamente`,
                high: `🚨 ALERTA GLUCOSA ALTA!\n${glucoseValue} mg/dL\nTomar medidas`
            }
        };

        const lang = settings.language || 'en';
        const langMessages = messages[lang] || messages.en;

        // 🆕 USAR CONFIGURACIÓN PERSONALIZADA DEL USUARIO (en lugar de valores hardcodeados)
        if (glucoseValue < settings.lowAlert) { // Usar tu configuración (ej: 70)
            alertMessage = langMessages.low;
            alertDuration = 20000; // 20 segundos para alerta baja
            session.logger.warn(`🔔 Alerta baja activada: ${glucoseValue} < ${settings.lowAlert}`);
        } else if (glucoseValue > settings.highAlert) { // Usar tu configuración (ej: 180)
            alertMessage = langMessages.high;
            alertDuration = 15000;
            session.logger.warn(`🔔 Alerta alta activada: ${glucoseValue} > ${settings.highAlert}`);
        }

        if (alertMessage) {
            // MOSTRAR alerta personalizada
            session.layouts.showTextWall(alertMessage);
            this.alertHistory.set(sessionId, currentTime);
            session.logger.error(`🚨 ALERTA PERSONALIZADA mostrada: ${glucoseValue} mg/dL (límites: ${settings.lowAlert}-${settings.highAlert})`);

            // 🆕 Limpiar timer anterior
            const existingTimer = this.displayTimers.get(sessionId);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            // 🆕 OCULTAR alerta después del tiempo especificado
            const alertTimer = setTimeout(() => {
                this.hideDisplay(session, sessionId);
                this.displayTimers.delete(sessionId);
                session.logger.info(`🙈 Alerta personalizada ocultada para ${sessionId}`);
            }, alertDuration);

            this.displayTimers.set(sessionId, alertTimer);
        }
    }

    /**
     * Método adicional para cleanup manual si es necesario (MODIFICADO: + timers)
     */
    cleanupSession(sessionId) {
        const sessionData = this.activeSessions.get(sessionId);
        if (sessionData) {
            if (sessionData.updateInterval) {
                clearInterval(sessionData.updateInterval);
            }

            if (sessionData.autoCleanupTimeout) {
                clearTimeout(sessionData.autoCleanupTimeout);
            }

            // 🆕 Limpiar timer de display
            const displayTimer = this.displayTimers.get(sessionId);
            if (displayTimer) {
                clearTimeout(displayTimer);
                this.displayTimers.delete(sessionId);
            }

            this.activeSessions.delete(sessionId);
            this.alertHistory.delete(sessionId);
            console.log(`🧹 Sesión ${sessionId} limpiada manualmente`);
        }
    }
}

// Crear y iniciar el servidor (TU CÓDIGO ORIGINAL)
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
console.log(`👁️ Display inteligente activado`); // 🆕
console.log(`🤖 AI Tools bilingües habilitados`); // 🆕
console.log(`🇪🇸 Timezone España corregido`); // 🆕
console.log(`🔔 Alertas configurables implementadas`); // 🆕 NUEVO
