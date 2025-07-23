// src/index.js - Aplicación Nightscout MentraOS Completa con Correcciones
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

            session.logger.info('=== FIN DIAGNÓSTICO ===');

            // PASO 1: Obtener configuración del usuario
            const userSettings = await this.getUserSettings(session);
            
            session.logger.info('Settings finales obtenidos:', {
                hasUrl: !!userSettings.nightscoutUrl,
                hasToken: !!userSettings.nightscoutToken,
                language: userSettings.language
            });

            // PASO 2: Validar configuración esencial
            if (!userSettings.nightscoutUrl || !userSettings.nightscoutToken) {
                await this.showConfigurationNeeded(session, userSettings);
                return;
            }

            // PASO 3: Iniciar operación normal con settings oficiales
            await this.startNormalOperation(session, sessionId, userId, userSettings);

            // PASO 4: MANEJO SEGURO DE EVENTOS (NUEVA IMPLEMENTACIÓN)
            this.setupSafeEventHandlers(session, sessionId, userId);

            // PASO 5: Escuchar cambios de configuración EN TIEMPO REAL
            this.setupSettingsListener(session, sessionId, userId);

        } catch (error) {
            session.logger.error(`Error en sesión: ${error.message}`);
            session.layouts.showTextWall("Error: Check app settings\nin MentraOS app");
        }
    }

    /**
     * NUEVO MÉTODO: Configurar event handlers de manera segura
     */
    setupSafeEventHandlers(session, sessionId, userId) {
        try {
            // Verificar que session.events existe y tiene el método necesario
            if (session.events && typeof session.events.onDisconnected === 'function') {
                // Definir el callback explícitamente antes de pasarlo
                const disconnectHandler = () => {
                    try {
                        session.logger.info(`👋 Sesión ${sessionId} desconectada`);
                        
                        // Limpiar recursos de manera segura
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
                
                // Cleanup alternativo usando timeout
                const sessionData = this.activeSessions.get(sessionId);
                if (sessionData) {
                    sessionData.autoCleanupTimeout = setTimeout(() => {
                        session.logger.info(`🧹 Auto-cleanup para sesión ${sessionId}`);
                        
                        const userSession = this.activeSessions.get(sessionId);
                        if (userSession && userSession.updateInterval) {
                            clearInterval(userSession.updateInterval);
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
     * Obtener configuración del usuario usando el sistema oficial de Settings
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
                language
            ] = await Promise.all([
                session.settings.get('nightscout_url'),
                session.settings.get('nightscout_token'),
                session.settings.get('update_interval'),
                session.settings.get('low_alert'),
                session.settings.get('high_alert'),
                session.settings.get('alerts_enabled'),
                session.settings.get('language')
            ]);

            return {
                nightscoutUrl: nightscoutUrl?.trim(),
                nightscoutToken: nightscoutToken?.trim(),
                updateInterval: parseInt(updateInterval) || 5,
                lowAlert: parseInt(lowAlert) || 70,
                highAlert: parseInt(highAlert) || 180,
                alertsEnabled: alertsEnabled === 'true' || alertsEnabled === true,
                language: language || 'en'
            };
        } catch (error) {
            session.logger.error('Error obteniendo settings del usuario:', error);
            return {
                nightscoutUrl: null,
                nightscoutToken: null,
                updateInterval: 5,
                lowAlert: 70,
                highAlert: 180,
                alertsEnabled: true,
                language: 'en'
            };
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
        session.logger.info('Configuración requerida mostrada al usuario');
    }

    /**
     * Iniciar operación normal con settings oficiales (CORREGIDO)
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
            // Mostrar datos iniciales
            const glucoseData = await this.getGlucoseData(settings);
            const displayText = this.formatForG1(glucoseData, settings);
            session.layouts.showTextWall(displayText);

            // Configurar updates automáticos basados en settings
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
                    const newDisplay = this.formatForG1(newData, currentSettings);
                    
                    session.layouts.showTextWall(newDisplay);

                    if (currentSettings.alertsEnabled) {
                        await this.checkAlerts(session, sessionId, newData, currentSettings);
                    }
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
     * Configurar listener para cambios de settings en tiempo real
     */
    setupSettingsListener(session, sessionId, userId) {
        // Si el SDK soporta listeners de settings, configurar aquí
        // De momento, los cambios se detectan en cada update automático
        session.logger.info(`Settings listener configurado para ${sessionId}`);
    }

   /**
 * Obtener datos de glucosa desde Nightscout
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
     * Formatear datos para Even Realities G1
     */
    formatForG1(glucoseData, settings) {
        const glucoseValue = glucoseData.sgv;
        const trend = this.getTrendArrow(glucoseData.direction);
        const time = new Date().toLocaleTimeString(settings.language === 'es' ? 'es-ES' : 'en-US', { 
            hour: '2-digit', minute: '2-digit' 
        });

        // Símbolos según configuración del usuario
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
     * Verificar y mostrar alertas
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
                low: `LOW GLUCOSE ALERT!\n${glucoseValue} mg/dL\nCheck immediately`,
                high: `HIGH GLUCOSE ALERT!\n${glucoseValue} mg/dL\nTake action`
            },
            es: {
                low: `ALERTA GLUCOSA BAJA!\n${glucoseValue} mg/dL\nRevisar inmediatamente`,
                high: `ALERTA GLUCOSA ALTA!\n${glucoseValue} mg/dL\nTomar medidas`
            }
        };

        const lang = settings.language || 'en';
        const langMessages = messages[lang] || messages.en;

        if (glucoseValue < settings.lowAlert) {
            alertMessage = langMessages.low;
        } else if (glucoseValue > settings.highAlert) {
            alertMessage = langMessages.high;
        }

        if (alertMessage) {
            session.layouts.showTextWall(alertMessage);
            this.alertHistory.set(sessionId, currentTime);
            session.logger.warn(`🚨 Alerta enviada: ${glucoseValue} mg/dL`);

            // Volver a mostrar datos normales después de 10 segundos
            setTimeout(() => {
                if (this.activeSessions.has(sessionId)) {
                    const displayText = this.formatForG1(glucoseData, settings);
                    session.layouts.showTextWall(displayText);
                }
            }, 10000);
        }
    }

    /**
     * Método adicional para cleanup manual si es necesario
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
            this.activeSessions.delete(sessionId);
            this.alertHistory.delete(sessionId);
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
console.log(`⚙️  Sistema de Settings oficial habilitado`);
