// src/index.js - Aplicación Nightscout MentraOS v2.4.2
// GLUROO COMPATIBLE + SETTINGS ORDER FIX + FUNCIONALIDADES AVANZADAS
const { AppServer } = require('@mentra/sdk');
const axios = require('axios');
require('dotenv').config();

// Configuración desde variables de entorno
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.tucompania.nightscout-glucose";
const PORT = parseInt(process.env.PORT || "3000");
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

// Constantes de la aplicación
const UNITS = {
    MGDL: 'mg/dL',
    MMOL: 'mmol/L'
};

const CONVERSION_FACTOR = 18.0; // mg/dL a mmol/L

if (!MENTRAOS_API_KEY) {
    console.error("❌ MENTRAOS_API_KEY environment variable is required");
    process.exit(1);
}

/**
 * NightscoutMentraApp - Aplicación completa para monitoreo de glucosa
 * Versión 2.4.2 con corrección de race conditions y funcionalidades avanzadas
 */
class NightscoutMentraApp extends AppServer {
    constructor(options) {
        super(options);
        this.activeSessions = new Map();
        this.alertHistory = new Map();
        this.displayTimers = new Map();      // Para display temporal
        this.userUnitsCache = new Map();     // Caché unidades por usuario
        this.sessionData = new Map();        // Datos de sesión extendidos
        
        // Configurar keep-alive para Render
        this.setupKeepAlive();
    }

    /**
     * 🆕 VERSIÓN CORREGIDA: Obtener configuración del usuario de forma secuencial
     * FIX: Elimina race conditions causados por Promise.all()
     */
    async getUserSettings(session) {
        try {
            console.log('🔧 [v2.4.2] Obteniendo settings secuencialmente para evitar race conditions...');
            
            // OBTENER SETTINGS UNO POR UNO para evitar conflictos de orden
            const nightscoutUrl = await session.settings.get('nightscout_url');
            console.log(`📍 URL obtenida: ${nightscoutUrl ? nightscoutUrl.substring(0, 25) + '...' : 'null'}`);
            
            // Pequeña pausa para evitar race conditions en MentraOS
            await new Promise(resolve => setTimeout(resolve, 50));
            
            const nightscoutToken = await session.settings.get('nightscout_token');
            console.log(`🔑 Token obtenido: ${nightscoutToken ? nightscoutToken.substring(0, 12) + '...' : 'null'} (length: ${nightscoutToken?.length || 0})`);
            
            await new Promise(resolve => setTimeout(resolve, 50));
            
            const updateInterval = await session.settings.get('update_interval');
            console.log(`⏱️ Intervalo obtenido: ${updateInterval}`);
            
            await new Promise(resolve => setTimeout(resolve, 50));
            
            const lowAlertSetting = await session.settings.get('low_alert');
            console.log(`🔻 Alerta baja obtenida: ${lowAlertSetting}`);
            
            await new Promise(resolve => setTimeout(resolve, 50));
            
            const highAlertSetting = await session.settings.get('high_alert');
            console.log(`🔺 Alerta alta obtenida: ${highAlertSetting}`);
            
            await new Promise(resolve => setTimeout(resolve, 50));
            
            const alertsEnabled = await session.settings.get('alerts_enabled');
            console.log(`🚨 Alertas habilitadas: ${alertsEnabled}`);
            
            await new Promise(resolve => setTimeout(resolve, 50));
            
            const language = await session.settings.get('language');
            console.log(`🌍 Idioma obtenido: ${language}`);
            
            await new Promise(resolve => setTimeout(resolve, 50));
            
            const timezone = await session.settings.get('timezone');
            console.log(`🕐 Zona horaria obtenida: ${timezone}`);

            // Procesar todos los settings usando las funciones existentes
            const processedSettings = {
                nightscoutUrl: this.validateToken(nightscoutUrl),
                nightscoutToken: this.validateToken(nightscoutToken),
                updateInterval: this.parseSlicerValue(updateInterval, 5),
                lowAlert: this.parseSlicerValue(lowAlertSetting, 70),
                highAlert: this.parseSlicerValue(highAlertSetting, 180),
                alertsEnabled: alertsEnabled === 'true' || alertsEnabled === true || alertsEnabled === 1,
                language: language || 'en',
                timezone: timezone || 'Europe/Madrid'
            };

            // Verificar compatibilidad con Gluroo
            if (processedSettings.nightscoutUrl && processedSettings.nightscoutUrl.includes('gluroo.com')) {
                console.log('✅ Configuración Gluroo detectada - Tokens largos soportados');
            }

            console.log('✅ Settings procesados secuencialmente:', {
                url: processedSettings.nightscoutUrl ? 'OK' : 'MISSING',
                token: processedSettings.nightscoutToken ? `OK (${processedSettings.nightscoutToken.length} chars)` : 'MISSING',
                updateInterval: processedSettings.updateInterval,
                lowAlert: processedSettings.lowAlert,
                highAlert: processedSettings.highAlert,
                alertsEnabled: processedSettings.alertsEnabled,
                language: processedSettings.language,
                timezone: processedSettings.timezone
            });

            return processedSettings;

        } catch (error) {
            console.error('❌ Error obteniendo settings secuencialmente:', error);
            
            // Devolver configuración por defecto en caso de error
            return {
                nightscoutUrl: null,
                nightscoutToken: null,
                updateInterval: 5,
                lowAlert: 70,
                highAlert: 180,
                alertsEnabled: true,
                language: 'en',
                timezone: 'Europe/Madrid'
            };
        }
    }

    /**
     * Método principal onSession con manejo seguro de eventos y funcionalidades completas
     */
    async onSession(session, sessionId, userId) {
        session.logger.info(`🎯 Nueva sesión Nightscout v2.4.2: ${sessionId} para ${userId}`);
        
        try {
            // Obtener configuración del usuario (método corregido)
            const userSettings = await this.getUserSettings(session);
            
            // Validar configuración esencial
            if (!userSettings.nightscoutUrl || !userSettings.nightscoutToken) {
                await this.showConfigurationNeeded(session, userSettings);
                return;
            }

            // Almacenar sesión con datos completos
            this.activeSessions.set(sessionId, { 
                session, 
                userId, 
                settings: userSettings,
                updateInterval: null,
                autoCleanupTimeout: null,
                lastGlucoseReading: null
            });

            // Configurar eventos de botón para mostrar glucosa
            this.setupButtonEvents(session, sessionId, userSettings);

            // Iniciar operación normal
            await this.startNormalOperation(session, sessionId, userId, userSettings);

            // Configurar event handlers seguros
            this.setupSafeEventHandlers(session, sessionId, userId);

        } catch (error) {
            session.logger.error(`❌ Error en sesión: ${error.message}`);
            session.layouts.showTextWall("Error: Check app settings\nin MentraOS app");
        }
    }

    /**
     * Configurar eventos de botón para interacción
     */
    setupButtonEvents(session, sessionId, userSettings) {
        try {
            if (session.events && typeof session.events.onButtonPress === 'function') {
                session.events.onButtonPress(async (button) => {
                    session.logger.info(`🔘 Botón presionado: ${button}`);
                    
                    try {
                        // Mostrar glucosa temporalmente al presionar botón
                        await this.showGlucoseTemporarily(session, sessionId, userSettings);
                    } catch (error) {
                        session.logger.error(`❌ Error en evento de botón: ${error.message}`);
                    }
                });
                
                session.logger.info(`✅ Eventos de botón configurados para ${sessionId}`);
            }
        } catch (error) {
            session.logger.warn(`⚠️ No se pudieron configurar eventos de botón: ${error.message}`);
        }
    }

    /**
     * Mostrar glucosa temporalmente (5 segundos)
     */
    async showGlucoseTemporarily(session, sessionId, userSettings) {
        try {
            // Limpiar timer previo si existe
            const existingTimer = this.displayTimers.get(sessionId);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            // Obtener y mostrar datos actuales
            const glucoseData = await this.getGlucoseData(userSettings);
            const displayText = await this.formatForG1(glucoseData, userSettings, sessionId);
            
            session.layouts.showTextWall(displayText);
            session.logger.info(`📊 Glucosa mostrada temporalmente: ${displayText.split('\n')[0]}`);

            // Programar ocultación después de 5 segundos
            const hideTimer = setTimeout(() => {
                this.hideDisplay(session, sessionId);
            }, 5000);

            this.displayTimers.set(sessionId, hideTimer);

        } catch (error) {
            session.logger.error(`❌ Error mostrando glucosa temporal: ${error.message}`);
        }
    }

    /**
     * Ocultar display
     */
    hideDisplay(session, sessionId) {
        try {
            session.layouts.showTextWall("");
            this.displayTimers.delete(sessionId);
            session.logger.info(`👻 Display ocultado para sesión ${sessionId}`);
        } catch (error) {
            session.logger.error(`❌ Error ocultando display: ${error.message}`);
        }
    }

    /**
     * Iniciar operación normal con todas las funcionalidades
     */
    async startNormalOperation(session, sessionId, userId, settings) {
        session.logger.info(`🚀 Iniciando operación normal para ${userId}`);
        
        try {
            // Mostrar datos iniciales temporalmente
            await this.showInitialAndHide(session, sessionId, settings);

            // Configurar actualizaciones automáticas
            const intervalMs = settings.updateInterval * 60 * 1000;
            const updateInterval = setInterval(async () => {
                try {
                    if (!this.activeSessions.has(sessionId)) {
                        clearInterval(updateInterval);
                        return;
                    }

                    const currentSettings = await this.getUserSettings(session);
                    const newData = await this.getGlucoseData(currentSettings);
                    
                    // Actualizar caché
                    const sessionData = this.activeSessions.get(sessionId);
                    if (sessionData) {
                        sessionData.lastGlucoseReading = newData;
                    }

                    // Verificar alertas si están habilitadas
                    if (currentSettings.alertsEnabled) {
                        await this.checkAlerts(session, sessionId, newData, currentSettings);
                    }

                } catch (error) {
                    session.logger.error('❌ Error en update automático:', error);
                }
            }, intervalMs);

            // Guardar intervalo para cleanup
            const userSession = this.activeSessions.get(sessionId);
            if (userSession) {
                userSession.updateInterval = updateInterval;
            }

        } catch (error) {
            session.logger.error('❌ Error iniciando operación:', error);
            session.layouts.showTextWall("Error: Check Nightscout\nconnection in settings");
        }
    }

    /**
     * Mostrar datos iniciales y ocultar después de 5 segundos
     */
    async showInitialAndHide(session, sessionId, userSettings) {
        try {
            const glucoseData = await this.getGlucoseData(userSettings);
            const displayText = await this.formatForG1(glucoseData, userSettings, sessionId);
            
            session.layouts.showTextWall(displayText);
            session.logger.info(`📊 Datos iniciales mostrados: ${displayText.split('\n')[0]}`);

            // Programar ocultación después de 5 segundos
            const timer = setTimeout(() => {
                this.hideDisplay(session, sessionId);
            }, 5000);

            this.displayTimers.set(sessionId, timer);

        } catch (error) {
            session.logger.error(`❌ Error mostrando datos iniciales: ${error.message}`);
        }
    }

    /**
     * Configurar event handlers de manera segura
     */
    setupSafeEventHandlers(session, sessionId, userId) {
        try {
            if (session.events && typeof session.events.onDisconnected === 'function') {
                const disconnectHandler = () => {
                    try {
                        session.logger.info(`👋 Sesión ${sessionId} desconectada`);
                        
                        // Limpiar recursos de manera segura
                        const userSession = this.activeSessions.get(sessionId);
                        if (userSession) {
                            if (userSession.updateInterval) {
                                clearInterval(userSession.updateInterval);
                            }
                            if (userSession.autoCleanupTimeout) {
                                clearTimeout(userSession.autoCleanupTimeout);
                            }
                        }
                        
                        // Limpiar timer de display
                        const displayTimer = this.displayTimers.get(sessionId);
                        if (displayTimer) {
                            clearTimeout(displayTimer);
                            this.displayTimers.delete(sessionId);
                        }
                        
                        // Limpiar cachés
                        this.activeSessions.delete(sessionId);
                        this.alertHistory.delete(sessionId);
                        this.userUnitsCache.delete(sessionId);
                        this.sessionData.delete(sessionId);
                        
                    } catch (cleanupError) {
                        console.error(`❌ Error en cleanup de sesión ${sessionId}:`, cleanupError);
                    }
                };

                session.events.onDisconnected(disconnectHandler);
                session.logger.info(`✅ Event handler registrado para sesión ${sessionId}`);
                
            } else {
                session.logger.warn('⚠️ session.events.onDisconnected no disponible, usando cleanup alternativo');
                
                // Cleanup alternativo usando timeout
                const sessionData = this.activeSessions.get(sessionId);
                if (sessionData) {
                    sessionData.autoCleanupTimeout = setTimeout(() => {
                        session.logger.info(`🧹 Auto-cleanup para sesión ${sessionId}`);
                        this.cleanupSession(sessionId);
                    }, 1800000); // 30 minutos
                }
            }
        } catch (error) {
            session.logger.error(`❌ Error configurando event handlers: ${error.message}`);
        }
    }

    /**
     * Obtener datos de glucosa desde Nightscout/Gluroo
     */
    async getGlucoseData(settings) {
        try {
            // Limpiar y validar URL (prevención automática de errores)
            let cleanUrl = settings.nightscoutUrl?.trim();
            if (!cleanUrl) {
                throw new Error('URL de Nightscout no configurada');
            }
            
            // Asegurar protocolo HTTPS
            if (!cleanUrl.startsWith('http')) {
                cleanUrl = 'https://' + cleanUrl;
            }
            
            // Remover barra final si existe (PREVENCIÓN DEL ERROR 404)
            cleanUrl = cleanUrl.replace(/\/$/, '');
            
            // Verificar compatibilidad con Gluroo
            const isGluroo = cleanUrl.includes('gluroo.com');
            if (isGluroo) {
                console.log('🟢 Usando configuración optimizada para Gluroo');
            }
            
            const response = await axios.get(`${cleanUrl}/api/v1/entries/current.json`, {
                params: { token: settings.nightscoutToken },
                timeout: 10000,
                headers: { 'User-Agent': 'MentraOS-Nightscout-v2.4.2' }
            });

            const data = response.data;
            const reading = Array.isArray(data) ? data[0] : data;

            if (!reading || !reading.sgv) {
                throw new Error('No se encontraron datos válidos de glucosa');
            }

            console.log(`📊 Datos obtenidos exitosamente: ${reading.sgv} ${reading.units || 'mg/dL'} (${reading.direction})`);
            return reading;
            
        } catch (error) {
            console.error('❌ Error obteniendo datos de Nightscout:', error.message);
            throw error;
        }
    }

    /**
     * Formatear datos para Even Realities G1 con detección automática de unidades
     */
    async formatForG1(glucoseData, settings, sessionId) {
        try {
            let glucoseValue = glucoseData.sgv;
            const originalUnits = glucoseData.units || 'mg/dL';
            
            // Detección y conversión de unidades
            let displayUnits = UNITS.MGDL;
            let cachedUnits = this.userUnitsCache.get(sessionId);
            
            if (!cachedUnits) {
                // Detectar unidades automáticamente
                if (originalUnits === 'mmol/L' || glucoseValue < 30) {
                    displayUnits = UNITS.MMOL;
                    this.userUnitsCache.set(sessionId, UNITS.MMOL);
                } else {
                    this.userUnitsCache.set(sessionId, UNITS.MGDL);
                }
            } else {
                displayUnits = cachedUnits;
            }

            // Convertir si es necesario
            if (displayUnits === UNITS.MMOL && originalUnits !== 'mmol/L') {
                glucoseValue = Math.round((glucoseValue / CONVERSION_FACTOR) * 10) / 10;
            } else if (displayUnits === UNITS.MGDL && originalUnits === 'mmol/L') {
                glucoseValue = Math.round(glucoseValue * CONVERSION_FACTOR);
            }

            // Obtener flecha de tendencia
            const trend = this.getTrendArrow(glucoseData.direction);
            
            // Formato de tiempo localizado
            const time = new Date().toLocaleTimeString(
                settings.language === 'es' ? 'es-ES' : 'en-US', 
                { 
                    hour: '2-digit', 
                    minute: '2-digit',
                    timeZone: settings.timezone 
                }
            );

            // Determinar símbolo según umbrales personalizados
            let symbol = '*';
            if (displayUnits === UNITS.MMOL) {
                // Convertir umbrales a mmol/L para comparación
                const lowThreshold = settings.lowAlert / CONVERSION_FACTOR;
                const highThreshold = settings.highAlert / CONVERSION_FACTOR;
                
                if (glucoseValue < lowThreshold) symbol = '!';
                else if (glucoseValue > highThreshold) symbol = '^';
            } else {
                if (glucoseValue < settings.lowAlert) symbol = '!';
                else if (glucoseValue > settings.highAlert) symbol = '^';
            }

            // Formato optimizado para Even Realities G1
            return `${symbol} ${glucoseValue} ${displayUnits}\n${time}`;

        } catch (error) {
            console.error('❌ Error formateando para G1:', error);
            return `Error: ${glucoseData.sgv || '---'} mg/dL\n${new Date().toLocaleTimeString()}`;
        }
    }

    /**
     * Obtener flecha de tendencia
     */
    getTrendArrow(direction) {
        const arrows = {
            'DoubleUp': '↑↑',
            'SingleUp': '↑',
            'FortyFiveUp': '↗',
            'Flat': '→',
            'FortyFiveDown': '↘',
            'SingleDown': '↓',
            'DoubleDown': '↓↓',
            'NONE': '→',
            'NOT COMPUTABLE': '?'
        };
        return arrows[direction] || '→';
    }

    /**
     * Verificar y mostrar alertas inteligentes
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
        const messages = {
            en: {
                low: `LOW GLUCOSE!\n${glucoseValue} mg/dL\nCheck now`,
                high: `HIGH GLUCOSE!\n${glucoseValue} mg/dL\nTake action`,
                critical_low: `CRITICAL LOW!\n${glucoseValue} mg/dL\nEMERGENCY`,
                critical_high: `CRITICAL HIGH!\n${glucoseValue} mg/dL\nEMERGENCY`
            },
            es: {
                low: `GLUCOSA BAJA!\n${glucoseValue} mg/dL\nRevisar ahora`,
                high: `GLUCOSA ALTA!\n${glucoseValue} mg/dL\nActuar`,
                critical_low: `CRÍTICO BAJO!\n${glucoseValue} mg/dL\nEMERGENCIA`,
                critical_high: `CRÍTICO ALTO!\n${glucoseValue} mg/dL\nEMERGENCIA`
            },
            fr: {
                low: `GLUCOSE BASSE!\n${glucoseValue} mg/dL\nVérifier`,
                high: `GLUCOSE HAUTE!\n${glucoseValue} mg/dL\nAgir`,
                critical_low: `CRITIQUE BAS!\n${glucoseValue} mg/dL\nURGENCE`,
                critical_high: `CRITIQUE HAUT!\n${glucoseValue} mg/dL\nURGENCE`
            }
        };

        const lang = settings.language || 'en';
        const langMessages = messages[lang] || messages.en;

        // Determinar tipo de alerta
        if (glucoseValue < 50) {
            alertMessage = langMessages.critical_low;
        } else if (glucoseValue > 250) {
            alertMessage = langMessages.critical_high;
        } else if (glucoseValue < settings.lowAlert) {
            alertMessage = langMessages.low;
        } else if (glucoseValue > settings.highAlert) {
            alertMessage = langMessages.high;
        }

        if (alertMessage) {
            // Limpiar timer de display si existe
            const existingTimer = this.displayTimers.get(sessionId);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            session.layouts.showTextWall(alertMessage);
            this.alertHistory.set(sessionId, currentTime);
            session.logger.warn(`🚨 Alerta enviada: ${glucoseValue} mg/dL`);

            // Volver a mostrar datos normales después de 15 segundos
            const normalTimer = setTimeout(async () => {
                if (this.activeSessions.has(sessionId)) {
                    try {
                        const displayText = await this.formatForG1(glucoseData, settings, sessionId);
                        session.layouts.showTextWall(displayText);
                        
                        // Ocultar después de 5 segundos
                        setTimeout(() => {
                            this.hideDisplay(session, sessionId);
                        }, 5000);
                        
                    } catch (error) {
                        session.logger.error('❌ Error volviendo a display normal:', error);
                    }
                }
            }, 15000);

            this.displayTimers.set(sessionId, normalTimer);
        }
    }

    /**
     * Mostrar mensaje de configuración necesaria
     */
    async showConfigurationNeeded(session, settings) {
        const messages = {
            en: "Please configure your\nNightscout URL and token\nin MentraOS app settings",
            es: "Por favor configura tu\nURL y token de Nightscout\nen ajustes de MentraOS",
            fr: "Veuillez configurer votre\nURL et token Nightscout\ndans les paramètres MentraOS"
        };

        const message = messages[settings.language] || messages.en;
        session.layouts.showTextWall(message);
        session.logger.info('⚙️ Configuración requerida mostrada al usuario');
    }

    /**
     * Validar y limpiar tokens/URLs
     */
    validateToken(token) {
        if (!token) return null;
        if (typeof token === 'string') {
            return token.trim() || null;
        }
        return null;
    }

    /**
     * Parsear valores del slicer de MentraOS
     */
    parseSlicerValue(value, defaultValue) {
        if (typeof value === 'object' && value !== null) {
            return value.value || defaultValue;
        }
        return value || defaultValue;
    }

    /**
     * Cleanup manual de sesión
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
        }

        const displayTimer = this.displayTimers.get(sessionId);
        if (displayTimer) {
            clearTimeout(displayTimer);
            this.displayTimers.delete(sessionId);
        }

        this.activeSessions.delete(sessionId);
        this.alertHistory.delete(sessionId);
        this.userUnitsCache.delete(sessionId);
        this.sessionData.delete(sessionId);
        
        console.log(`🧹 Sesión ${sessionId} limpiada completamente`);
    }

    /**
     * Configurar keep-alive para Render
     */
    setupKeepAlive() {
        if (process.env.NODE_ENV === 'production') {
            // Keep-alive cada 5 minutos para evitar que Render duerma la app
            setInterval(async () => {
                try {
                    const response = await axios.get('https://httpbin.org/get', { 
                        timeout: 5000,
                        headers: { 'User-Agent': 'MentraOS-KeepAlive-v2.4.2' }
                    });
                    console.log('💚 Keep-alive ping exitoso');
                } catch (error) {
                    console.log('⚠️ Keep-alive ping falló:', error.message);
                }
            }, 5 * 60 * 1000); // 5 minutos
        }
    }
}

// Crear y iniciar el servidor
const server = new NightscoutMentraApp({
    packageName: PACKAGE_NAME,
    apiKey: MENTRAOS_API_KEY,
    port: PORT
});

// Endpoint de salud con información completa
server.app.get('/health', (req, res) => {
    const health = {
        status: 'alive',
        version: '2.4.2',
        timestamp: new Date().toISOString(),
        features: {
            gluroo_compatible: true,
            multi_units: true,
            multi_language: true,
            button_events: true,
            temporal_display: true,
            smart_alerts: true,
            keep_alive: true
        },
        active_sessions: server.activeSessions?.size || 0,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    };
    
    res.json(health);
});

// Keep-alive endpoint específico
server.app.get('/keep-alive', (req, res) => {
    res.json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        version: '2.4.2',
        keep_alive: true
    });
});

// Iniciar servidor
server.start().catch(err => {
    console.error("❌ Error iniciando servidor:", err);
    process.exit(1);
});

console.log(`🚀 Nightscout MentraOS v2.4.2 - GLUROO COMPATIBLE + SETTINGS ORDER FIX`);
console.log(`📱 Optimizado para Even Realities G1 (640×200, verde monocromático)`);
console.log(`🔧 Características: Multi-unidades, Multi-idioma, Display temporal, Alertas inteligentes`);
console.log(`🔌 Puerto: ${PORT}`);
console.log(`⚙️ Keep-alive: ${process.env.NODE_ENV === 'production' ? 'Activado' : 'Desactivado'}`);
