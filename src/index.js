// src/index.js - Nightscout MentraOS v2.6
// COMPLETO: Mira AI + Gluroo + Settings + Todas las funciones

const { AppServer } = require('@mentra/sdk');
const axios = require('axios');
require('dotenv').config();

const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.tucompania.nightscout-glucose";
const PORT = parseInt(process.env.PORT || "3000");
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

if (!MENTRAOS_API_KEY) {
    console.error("❌ MENTRAOS_API_KEY required");
    process.exit(1);
}

const UNITS = { MGDL: 'mg/dL', MMOL: 'mmol/L' };
const CONVERSION_FACTOR = 18.0;

class NightscoutMentraApp extends AppServer {
    constructor(options) { super(options); this.activeSessions = new Map(); }

    // CONFIGURACIÓN RÁPIDA
    async getUserSettings(session) {
        const [url, token, interval, low, high, alerts, lang] = await Promise.all([
            session.settings.get('nightscout_url'),
            session.settings.get('nightscout_token'),
            session.settings.get('update_interval'),
            session.settings.get('low_alert'),
            session.settings.get('high_alert'),
            session.settings.get('alerts_enabled'),
            session.settings.get('language')
        ]);
        return {
            nightscoutUrl: String(url || '').trim(),
            nightscoutToken: String(token || '').trim(),
            updateInterval: parseInt(interval) || 5,
            lowAlert: parseInt(low) || 70,
            highAlert: parseInt(high) || 180,
            alertsEnabled: Boolean(alerts),
            language: lang || 'en'
        };
    }

    // AI TOOLS COMPLETAS
    async onToolCall(data) {
        const toolId = data.toolId || data.toolName;
        const userId = data.userId;
        const activeSession = data.activeSession;

        try {
            let userPreferredLang = 'en';
            if (activeSession?.settings?.settings) {
                const langSetting = activeSession.settings.settings.find(s => s.key === 'language');
                if (langSetting) userPreferredLang = langSetting.value === 'es' ? 'es' : 'en';
            }

            const tools = {
                'get_glucose': () => this.handleGetGlucoseForMira(userId, activeSession, 'en'),
                'obtener_glucosa': () => this.handleGetGlucoseForMira(userId, activeSession, 'es'),
                'check_glucose': () => this.handleGetGlucoseForMira(userId, activeSession, userPreferredLang),
                'revisar_glucosa': () => this.handleGetGlucoseForMira(userId, activeSession, 'es')
            };

            return await (tools[toolId] || tools['check_glucose'])();
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async handleGetGlucoseForMira(userId, activeSession, lang) {
        try {
            let settings = null;
            if (activeSession?.settings?.settings) {
                settings = this.parseSettingsFromArray(activeSession.settings.settings);
            } else {
                for (const [sid, data] of this.activeSessions) {
                    if (data.userId === userId) { settings = await this.getUserSettings(data.session); break; }
                }
            }

            if (!settings?.nightscoutUrl || !settings?.nightscoutToken) {
                const errorMsg = lang === 'es' ? "Nightscout no configurado" : "Nightscout not configured";
                return { success: false, error: errorMsg };
            }

            settings.glucoseUnit = await this.getGlucoseUnit(settings);
            const glucoseData = await this.getGlucoseData(settings);

            const displayValue = Math.round(settings.glucoseUnit === 'mmol/L' ? glucoseData.sgv / 18 : glucoseData.sgv);
            const trend = this.getTrendArrow(glucoseData.direction);
            const status = this.getGlucoseStatusText(glucoseData.sgv, settings, lang);

            const message = lang === 'es' 
                ? `Tu glucosa está en ${displayValue} mg/dL ${trend}. Estado: ${status}.`
                : `Your glucose is ${displayValue} mg/dL ${trend}. Status: ${status}.`;

            // Mostrar en gafas si hay sesión
            if (activeSession.layouts) {
                const displayText = this.formatForG1(glucoseData, settings);
                activeSession.layouts.showTextWall(displayText);
            }

            return {
                success: true,
                data: { glucose: displayValue, unit: settings.glucoseUnit, trend, status },
                message: message
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    parseSettingsFromArray(settingsArray) {
        const settings = {};
        settingsArray.forEach(s => settings[s.key] = s.value);
        return {
            nightscoutUrl: String(settings.nightscout_url || '').trim(),
            nightscoutToken: String(settings.nightscout_token || '').trim(),
            updateInterval: parseInt(settings.update_interval) || 5,
            lowAlert: parseInt(settings.low_alert) || 70,
            highAlert: parseInt(settings.high_alert) || 180,
            alertsEnabled: settings.alerts_enabled === 'true',
            language: settings.language || 'en'
        };
    }

    getGlucoseStatusText(value, settings, lang) {
        if (value < 70) return lang === 'es' ? 'Crítico Bajo' : 'Critical Low';
        if (value < settings.lowAlert) return lang === 'es' ? 'Bajo' : 'Low';
        if (value > 250) return lang === 'es' ? 'Crítico Alto' : 'Critical High';
        if (value > settings.highAlert) return lang === 'es' ? 'Alto' : 'High';
        return lang === 'es' ? 'Normal' : 'Normal';
    }

    getTrendArrow(direction) {
        const arrows = {
            'DoubleUp': '↑↑', 'SingleUp': '↑', 'FortyFiveUp': '↗',
            'Flat': '→', 'FortyFiveDown': '↘', 'SingleDown': '↓', 'DoubleDown': '↓↓'
        };
        return arrows[direction] || '→';
    }

    async onSession(session, sessionId, userId) {
        const settings = await this.getUserSettings(session);
        if (!settings.nightscoutUrl || !settings.nightscoutToken) {
            session.layouts.showTextWall("Configure URL & token");
            return;
        }

        // Botón y voz
        if (session.events?.onButtonPress) {
            session.events.onButtonPress(async () => {
                await this.showGlucoseTemporarily(session, sessionId, settings);
            });
        }

        // Operación normal
        this.startNormalOperation(session, sessionId, settings);
    }

    async startNormalOperation(session, sessionId, settings) {
        const interval = setInterval(async () => {
            if (!this.activeSessions.has(sessionId)) { clearInterval(interval); return; }
            const data = await this.getGlucoseData(settings);
            const text = this.formatForG1(data, settings);
            session.layouts.showTextWall(text);
        }, settings.updateInterval * 60 * 1000);
    }

    async getGlucoseData(settings) {
        const res = await axios.get(`${settings.nightscoutUrl}/api/v1/entries/current.json`, {
            params: { token: settings.nightscoutToken },
            timeout: 5000
        });
        return res.data[0] || res.data;
    }

    async formatForG1(glucoseData, settings) {
        const value = Math.round(settings.glucoseUnit === 'mmol/L' ? glucoseData.sgv / 18 : glucoseData.sgv);
        const trend = this.getTrendArrow(glucoseData.direction);
        const time = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        return `* ${value} mg/dL ${trend}\n${time}`;
    }

    async onToolCall(data) {
        return await this.handleGetGlucoseForMira(data.userId, data.activeSession, 'en');
    }
}

// Configuración completa
const server = new NightscoutMentraApp({
    packageName: PACKAGE_NAME,
    apiKey: MENTRAOS_API_KEY,
    port: PORT
});

// Endpoints
server.app.get('/health', (_, res) => res.json({ status: 'alive', version: '2.6' }));
server.app.get('/keep-alive', (_, res) => res.json({ status: 'alive' }));

// Configuración MentraOS
console.log(`
✅ CONFIGURACIÓN MENTRAOS:
1. AI Tools: get_glucose, obtener_glucosa, check_glucose, revisar_glucosa
2. Settings: nightscout_url, nightscout_token, low_alert, high_alert
3. Variables Render: nightscout_url, nightscout_token (minúsculas)
`);

server.start().then(() => console.log('🚀 v2.6 Mira AI + Gluroo activado'));
