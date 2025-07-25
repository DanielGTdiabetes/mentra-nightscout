// src/index.js - Nightscout MentraOS VERSIÓN GLUROO COMPATIBLE
// Fix: Sistema mejorado para cambiar tokens persistentemente

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
        // 🆕 Cache local para settings con timestamp
        this.settingsCache = new Map();
    }

    // 🆕 Sistema mejorado de cache con invalidación
    getCacheKey(sessionId, userId) {
        return `${sessionId}_${userId}`;
    }

    invalidateSettingsCache(sessionId, userId) {
        const cacheKey = this.getCacheKey(sessionId, userId);
        this.settingsCache.delete(cacheKey);
        console.log(`🗑️ Cache invalidated for ${cacheKey}`);
    }

    // 🆕 FIX: Parsear valores de slicer y tokens largos
    parseSlicerValue(value, defaultValue) {
        if (typeof value === 'object' && value !== null) {
            return value.value || defaultValue;
        }
        return value || defaultValue;
    }

    validateToken(token) {
        const cleanToken = String(token || '').trim();
        // Validación específica para tokens de Gluroo (suelen ser largos)
        if (cleanToken.length > 100) {
            console.log('🔐 Token largo detectado (posiblemente Gluroo)');
        }
        return cleanToken;
    }

    // 🆕 FIX PRINCIPAL: Manejo mejorado de updates de settings
    async onSettingsUpdate(updates, sessionId) {
        try {
            console.log(`🔄 Settings update received for ${sessionId}:`, updates);
            
            const sessionData = this.activeSessions.get(sessionId);
            if (!sessionData) {
                console.warn(`⚠️ No active session for settings update`);
                return;
            }

            // Invalidar cache para forzar reload desde MentraOS
            this.invalidateSettingsCache(sessionId, sessionData.userId);
            
            // Limpiar cache de unidades también
            const oldSettings = sessionData.settings;
            if (oldSettings?.nightscoutUrl && oldSettings?.nightscoutToken) {
                const oldCacheKey = `${oldSettings.nightscoutUrl}_${oldSettings.nightscoutToken}`;
                this.userUnitsCache.delete(oldCacheKey);
            }

            // Obtener nuevos settings directamente
            const newSettings = await this.getUserSettings(sessionData.session, sessionId, sessionData.userId, true);
            newSettings.glucoseUnit = await this.getGlucoseUnit(newSettings);
            
            sessionData.settings = newSettings;
            
            console.log(`✅ Settings refreshed - New token: ${newSettings.nightscoutToken?.substring(0,12)}... (length: ${newSettings.nightscoutToken?.length})`);
            
            // Si hay cambios significativos, reiniciar la operación
            if (oldSettings?.nightscoutToken !== newSettings.nightscoutToken || 
                oldSettings?.nightscoutUrl !== newSettings.nightscoutUrl) {
                
                console.log('🔄 Token/URL changed, restarting operation...');
                
                // Limpiar intervalo anterior
                if (sessionData.updateInterval) {
                    clearInterval(sessionData.updateInterval);
                }
                
                // Reiniciar con nuevos settings
                await this.startNormalOperation(sessionData.session, sessionId, sessionData.userId, newSettings);
                
                // Mostrar confirmación al usuario
                await this.showTokenUpdateConfirmation(sessionData.session, newSettings);
            }
            
        } catch (error) {
            console.error(`❌ Settings update failed:`, error);
        }
    }

    // 🆕 Mostrar confirmación de cambio de token
    async showTokenUpdateConfirmation(session, settings) {
        try {
            const messages = {
                en: `Token updated!\nTesting connection...`,
                es: `¡Token actualizado!\nProbando conexión...`,
                fr: `Token mis à jour!\nTest de connexion...`
            };
            
            const message = messages[settings.language] || messages.en;
            session.layouts.showTextWall(message);
            
            // Probar conexión y mostrar resultado
            setTimeout(async () => {
                try {
                    const glucoseData = await this.getGlucoseData(settings);
                    const displayText = await this.formatForG1(glucoseData, settings);
                    session.layouts.showTextWall(`✅ Connected!\n${displayText}`);
                    
                    // Ocultar después de 5 segundos
                    setTimeout(() => {
                        try {
                            session.layouts.showTextWall("");
                        } catch (e) {}
                    }, 5000);
                    
                } catch (error) {
                    const errorMessages = {
                        en: `❌ Connection failed\nCheck token & URL`,
                        es: `❌ Conexión falló\nRevisa token y URL`,
                        fr: `❌ Connexion échouée\nVérifiez token et URL`
                    };
                    const errorMsg = errorMessages[settings.language] || errorMessages.en;
                    session.layouts.showTextWall(errorMsg);
                    
                    setTimeout(() => {
                        try {
                            session.layouts.showTextWall("");
                        } catch (e) {}
                    }, 5000);
                }
            }, 2000);
            
        } catch (error) {
            console.error('Error mostrando confirmación:', error);
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

    convertToMgdl(value, fromUnit) {
        if (fromUnit === UNITS.MMOL) {
            return Math.round(value * 18);
        }
        return value;
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
            const userSettings = await this.getUserSettings(session, sessionId, userId);
            userSettings.glucoseUnit = await this.getGlucoseUnit(userSettings);
            
            console.log('📊 Settings cargados:', {
                lowAlert: userSettings.lowAlert,
                highAlert: userSettings.highAlert,
                unit: userSettings.glucoseUnit,
                tokenLength: userSettings.nightscoutToken?.length,
                hasToken: !!userSettings.nightscoutToken,
                hasUrl: !!userSettings.nightscoutUrl
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
                    this.invalidateSettingsCache(sessionId, userId);
                });
            }

        } catch (error) {
            console.error(`Error configurando event handlers: ${error.message}`);
        }
    }

    async showGlucoseTemporarily(session, sessionId, duration = 10000) {
        try {
            const sessionData = this.activeSessions.get(sessionId);
            if (!sessionData) return;

            // Refrescar settings antes de mostrar
            const currentSettings = await this.getUserSettings(sessionData.session, sessionId, sessionData.userId, true);
            currentSettings.glucoseUnit = await this.getGlucoseUnit(currentSettings);
            
            const glucoseData = await this.getGlucoseData(currentSettings);
            const displayText = await this.formatForG1(glucoseData, currentSettings);
            
            session.layouts.showTextWall(displayText);
            
            const existingTimer = this.displayTimers.get(sessionId);
            if (existingTimer) clearTimeout(existingTimer);
            
            const timer = setTimeout(() => {
                this.hideDisplay(session, sessionId);
                this.displayTimers.delete(sessionId);
            }, duration);
            
            this.displayTimers.set(sessionId, timer);
            
        } catch (error) {
            console.error('Error showing glucose temporarily:', error);
        }
    }

    // 🆕 FIX CRÍTICO: Sistema mejorado de obtención de settings
    async getUserSettings(session, sessionId, userId, forceRefresh = false) {
        try {
            const cacheKey = this.getCacheKey(sessionId, userId);
            
            // Usar cache solo si no es refresh forzado y existe cache reciente (< 30 segundos)
            if (!forceRefresh && this.settingsCache.has(cacheKey)) {
                const cached = this.settingsCache.get(cacheKey);
                if (Date.now() - cached.timestamp < 30000) {
                    console.log('📋 Using cached settings');
                    return cached.settings;
                }
            }

            console.log('🔄 Fetching fresh settings from MentraOS...');

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

            // Cachear settings con timestamp
            this.settingsCache.set(cacheKey, {
                settings: settings,
                timestamp: Date.now()
            });

            console.log('🔧 Settings procesados:', {
                url: settings.nightscoutUrl ? 'SET' : 'EMPTY',
                token: settings.nightscoutToken ? `${settings.nightscoutToken.substring(0,12)}...` : 'EMPTY',
                tokenLength: settings.nightscoutToken?.length || 0,
                isGluroo: settings.nightscoutUrl?.includes('gluroo.com') || false
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
            en: "Please configure Nightscout\nURL and token in settings\n\n📱 For Gluroo users:\nUse your API Secret Token",
            es: "Configura URL y token\nde Nightscout en ajustes\n\n📱 Para usuarios de Gluroo:\nUsa tu API Secret Token",
            fr: "Configurez l'URL et le token\nNightscout dans les paramètres\n\n📱 Pour les utilisateurs de Gluroo:\nUtilisez votre API Secret Token"
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

                // Obtener settings actualizados periódicamente (cada 5 updates)
                const sessionData = this.activeSessions.get(sessionId);
                let currentSettings = sessionData.settings;
                
                // Cada 25 minutos aprox, refrescar settings
                if (Math.random() < 0.2) {
                    currentSettings = await this.getUserSettings(session, sessionId, userId, true);
                    currentSettings.glucoseUnit = await this.getGlucoseUnit(currentSettings);
                    sessionData.settings = currentSettings;
                }
                
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

    async checkAlerts(session, sessionId, glucoseData, settings) {
        try {
            const mgdlValue = glucoseData.sgv;
            const alertKey = `${sessionId}_${mgdlValue}_${Date.now()}`;
            
            if (this.alertHistory.has(sessionId)) {
                const lastAlert = this.alertHistory.get(sessionId);
                if (Date.now() - lastAlert.timestamp < 300000) { // 5 minutos
                    return;
                }
            }

            let shouldAlert = false;
            let alertMessage = '';

            if (mgdlValue < 70) {
                shouldAlert = true;
                const messages = {
                    en: `🚨 CRITICAL LOW\n${this.convertToDisplay(mgdlValue, settings.glucoseUnit)} ${settings.glucoseUnit}`,
                    es: `🚨 CRÍTICO BAJO\n${this.convertToDisplay(mgdlValue, settings.glucoseUnit)} ${settings.glucoseUnit}`,
                    fr: `🚨 CRITIQUE BAS\n${this.convertToDisplay(mgdlValue, settings.glucoseUnit)} ${settings.glucoseUnit}`
                };
                alertMessage = messages[settings.language] || messages.en;
            } else if (mgdlValue < settings.lowAlert) {
                shouldAlert = true;
                const messages = {
                    en: `⚠️ LOW GLUCOSE\n${this.convertToDisplay(mgdlValue, settings.glucoseUnit)} ${settings.glucoseUnit}`,
                    es: `⚠️ GLUCOSA BAJA\n${this.convertToDisplay(mgdlValue, settings.glucoseUnit)} ${settings.glucoseUnit}`,
                    fr: `⚠️ GLUCOSE BASSE\n${this.convertToDisplay(mgdlValue, settings.glucoseUnit)} ${settings.glucoseUnit}`
                };
                alertMessage = messages[settings.language] || messages.en;
            } else if (mgdlValue > 250) {
                shouldAlert = true;
                const messages = {
                    en: `🚨 CRITICAL HIGH\n${this.convertToDisplay(mgdlValue, settings.glucoseUnit)} ${settings.glucoseUnit}`,
                    es: `🚨 CRÍTICO ALTO\n${this.convertToDisplay(mgdlValue, settings.glucoseUnit)} ${settings.glucoseUnit}`,
                    fr: `🚨 CRITIQUE HAUT\n${this.convertToDisplay(mgdlValue, settings.glucoseUnit)} ${settings.glucoseUnit}`
                };
                alertMessage = messages[settings.language] || messages.en;
            } else if (mgdlValue > settings.highAlert) {
                shouldAlert = true;
                const messages = {
                    en: `⚠️ HIGH GLUCOSE\n${this.convertToDisplay(mgdlValue, settings.glucoseUnit)} ${settings.glucoseUnit}`,
                    es: `⚠️ GLUCOSA ALTA\n${this.convertToDisplay(mgdlValue, settings.glucoseUnit)} ${settings.glucoseUnit}`,
                    fr: `⚠️ GLUCOSE HAUTE\n${this.convertToDisplay(mgdlValue, settings.glucoseUnit)} ${settings.glucoseUnit}`
                };
                alertMessage = messages[settings.language] || messages.en;
            }

            if (shouldAlert) {
                session.layouts.showTextWall(alertMessage);
                this.alertHistory.set(sessionId, {
                    value: mgdlValue,
                    timestamp: Date.now()
                });

                setTimeout(() => {
                    try {
                        session.layouts.showTextWall("");
                    } catch (e) {}
                }, 10000);
            }

        } catch (error) {
            console.error('Error checking alerts:', error);
        }
    }

    async getGlucoseData(settings) {
        try {
            let cleanUrl = settings.nightscoutUrl?.trim();
            if (!cleanUrl) throw new Error('URL de Nightscout no configurada');

            // 🆕 Soporte mejorado para URLs de Gluroo
            if (cleanUrl.includes('gluroo.com')) {
                console.log('🌐 Conectando con Gluroo:', cleanUrl.substring(0, 30) + '...');
            }

            if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;
            cleanUrl = cleanUrl.replace(/\/$/, '');
            
            console.log(`🔗 Request to: ${cleanUrl}/api/v1/entries/current.json`);
            console.log(`🔑 Token length: ${settings.nightscoutToken?.length || 0}`);
            
            const response = await axios.get(`${cleanUrl}/api/v1/entries/current.json`, {
                params: { token: settings.nightscoutToken },
                timeout: 15000,
                headers: { 
                    'User-Agent': 'MentraOS-Nightscout/2.5',
                    'Accept': 'application/json'
                }
            });

            const reading = Array.isArray(response.data) ? response.data[0] : response.data;
            if (!reading?.sgv) throw new Error('No hay datos de glucosa válidos');

            console.log(`✅ Datos obtenidos: ${reading.sgv} mg/dL`);
            return reading;
            
        } catch (error) {
            console.error('❌ Error obteniendo datos:', error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response data:', error.response.data);
            }
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

        return `${symbol} ${displayValue} ${unit} ${trend}\n${time}`;
    }

    getTrendArrow(direction) {
        const arrows = {
            'DoubleUp': '⬆⬆', 'SingleUp': '⬆', 'FortyFiveUp': '↗',
            'Flat': '→', 'FortyFiveDown': '↘', 'SingleDown': '⬇',
            'DoubleDown': '⬇⬇', 'NONE': '-', 'NOT COMPUTABLE': '?'
        };
        return arrows[direction] || '→';
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

console.log(`🚀 Nightscout MentraOS v2.5 - ENHANCED TOKEN MANAGEMENT`);
console.log(`📊 Soporte completo para tokens de Gluroo`);
console.log(`🔧 Sistema mejorado de configuración`);

// Health check endpoint mejorado
server.app.get('/health', (req, res) => {
    res.json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        version: '2.5.0',
        gluroo_compatible: true,
        features: ['dynamic_token_update', 'enhanced_cache', 'gluroo_support']
    });
});

// 🆕 Endpoint para debug de settings (opcional)
server.app.get('/debug/settings/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const sessionData = server.activeSessions.get(sessionId);
    
    if (!sessionData) {
        return res.json({ error: 'Session not found' });
    }
    
    res.json({
        hasToken: !!sessionData.settings?.nightscoutToken,
        tokenLength: sessionData.settings?.nightscoutToken?.length || 0,
        hasUrl: !!sessionData.settings?.nightscoutUrl,
        isGluroo: sessionData.settings?.nightscoutUrl?.includes('gluroo.com') || false,
        updateInterval: sessionData.settings?.updateInterval,
        timestamp: new Date().toISOString()
    });
});

const KEEP_ALIVE_URL = process.env.RENDER_URL || `https://mentra-nightscout.onrender.com`;

// Auto-keep-alive
setInterval(() => {
    axios.get(`${KEEP_ALIVE_URL}/health`)
        .then(() => console.log(`🔄 Keep-alive: ${new Date().toLocaleTimeString()}`))
        .catch(() => {}); // Expected on startup
}, 3 * 60 * 1000); // Ping cada 3 minutos
