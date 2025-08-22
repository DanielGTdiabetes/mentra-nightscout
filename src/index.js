"use strict";
/**
 * Nightscout MentraOS — Versión Optimizada 2.0
 * - Alertas de texto animadas con histéresis
 * - HUD con predicción IOB/COB y TIR
 * - Tracking de tratamientos (carbohidratos/insulina)
 * - Integración con Even Realities G1
 * - Soporte MIRA Tools
 * - i18n completo (ES/EN)
 */

require("dotenv").config();
const { AppServer } = require("@mentra/sdk");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

// Configuración
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.tucompania.nightscout-glucose";
const PORT = parseInt(process.env.PORT || "3000", 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

if (!MENTRAOS_API_KEY) {
  console.error("⛔ MENTRAOS_API_KEY environment variable is required");
  process.exit(1);
}

const UNITS = { MGDL: "mg/dL", MMOL: "mmol/L" };

class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.sessions = new Map();
    this.httpClients = new Map();
    this.alertState = new Map();
    this.tirData = new Map();
    this.lastReadings = new Map();
  }

  // ========== Utilidades Base ==========
  delay(ms) { 
    return new Promise(resolve => setTimeout(resolve, ms)); 
  }

  parseNumber(value, fallback = null) {
    const num = typeof value === "object" && value !== null ? parseFloat(value.value) : parseFloat(value);
    return Number.isFinite(num) ? num : fallback;
  }

  toBool(value) { 
    return value === true || value === "true" || value === 1 || value === "1"; 
  }

  // ========== Utilidades de Animación ==========
  clamp01(x) { 
    return x < 0 ? 0 : x > 1 ? 1 : x; 
  }

  easeInOutCubic(t) { 
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; 
  }

  getEasingFunction(type) {
    if (type === "smooth") return (t) => t * t * (3 - 2 * t);
    if (type === "linear") return (t) => t;
    return (t) => this.easeInOutCubic(t);
  }

  barFromRatio(ratio, slots = 20) {
    const filled = Math.round(this.clamp01(ratio) * slots);
    return `[${"¦".repeat(filled)}${"·".repeat(Math.max(0, slots - filled))}]`;
  }

  // ========== Conversión de Unidades ==========
  toDisplay(mgdl, units) {
    return units === UNITS.MMOL ? (mgdl / 18).toFixed(1) : Math.round(mgdl).toString();
  }

  getTrendArrow(direction) {
    const arrows = {
      DoubleUp: "↑↑", SingleUp: "↑", FortyFiveUp: "↗",
      Flat: "→", FortyFiveDown: "↘", SingleDown: "↓", 
      DoubleDown: "↓↓", NONE: "-"
    };
    return arrows[direction] || "?";
  }

  // ========== Display Management ==========
  showText(sessionId, text, maxLines = 5) {
    const session = this.sessions.get(sessionId);
    if (!session?.session) return;
    
    const lines = String(text || "").split("\n").slice(0, maxLines);
    session.session.layouts?.showTextWall?.(lines.join("\n"));
  }

  clearDisplay(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.session) return;
    
    // Limpieza sin usar clearView para evitar errores
    session.session.layouts?.showTextWall?.("");
    session.session.layouts?.showTextWall?.("\u200B");
  }

  // ========== Settings Management ==========
  async getSettings(session) {
    const keys = [
      "nightscout_url", "nightscout_token", "update_interval",
      "low_alert_mg", "high_alert_mg", "low_alert_mmol", "high_alert_mmol",
      "alerts_enabled", "language", "timezone", "units",
      "enable_head_up_display", "display_duration_s", "alert_duration_s",
      "alert_cooldown_min", "show_tir_bar", "enable_advanced_mode",
      "alert_hysteresis_mg", "alert_hysteresis_mmol",
      "prediction_horizon_min"
    ];

    const values = await Promise.all(keys.map(k => session.settings.get(k)));
    const settings = Object.fromEntries(keys.map((k, i) => [k, values[i]]));

    return {
      url: String(settings.nightscout_url || "").trim(),
      token: String(settings.nightscout_token || "").trim(),
      updateInterval: parseInt(settings.update_interval) || 5,
      lowAlertMg: this.parseNumber(settings.low_alert_mg, 70),
      highAlertMg: this.parseNumber(settings.high_alert_mg, 250),
      lowAlertMmol: this.parseNumber(settings.low_alert_mmol, 3.9),
      highAlertMmol: this.parseNumber(settings.high_alert_mmol, 13.9),
      alertsEnabled: this.toBool(settings.alerts_enabled),
      language: settings.language || "en",
      timezone: settings.timezone || "UTC",
      units: settings.units || UNITS.MGDL,
      headUpEnabled: this.toBool(settings.enable_head_up_display),
      displayDuration: Math.max(1000, Math.min(15000, (this.parseNumber(settings.display_duration_s, 5) * 1000))),
      alertDuration: Math.max(2000, Math.min(60000, (this.parseNumber(settings.alert_duration_s, 15) * 1000))),
      alertCooldown: Math.max(60000, Math.min(3600000, (this.parseNumber(settings.alert_cooldown_min, 10) * 60000))),
      showTirBar: this.toBool(settings.show_tir_bar),
      advancedMode: this.toBool(settings.enable_advanced_mode),
      alertHysteresisMg: this.parseNumber(settings.alert_hysteresis_mg, 5),
      alertHysteresisMmol: this.parseNumber(settings.alert_hysteresis_mmol, 0.3),
      predictionHorizon: this.parseNumber(settings.prediction_horizon_min, 30)
    };
  }

  // ========== HTTP Client ==========
  getHttpClient(sessionId, settings) {
    if (!settings.url) return null;

    let client = this.httpClients.get(sessionId);
    const baseURL = settings.url.startsWith("http") ? settings.url : `https://${settings.url}`;
    
    if (!client || client.defaults.baseURL !== baseURL) {
      client = axios.create({
        baseURL: baseURL.replace(/\/$/, ""),
        timeout: 10000,
        params: settings.token ? { token: settings.token } : {},
        headers: { "User-Agent": "MentraOS-Nightscout/2.0" }
      });
      this.httpClients.set(sessionId, client);
    }
    
    return client;
  }

  // ========== Nightscout Data ==========
  async getGlucoseData(sessionId, settings) {
    const http = this.getHttpClient(sessionId, settings);
    if (!http) throw new Error("Nightscout URL not configured");

    try {
      const { data } = await http.get("/api/v1/entries/sgv.json?count=1");
      const entry = Array.isArray(data) ? data[0] : data;
      
      if (!entry) throw new Error("No data");
      
      const sgv = Number(entry.sgv || entry.glucose);
      if (!Number.isFinite(sgv)) throw new Error("Invalid glucose value");
      
      const date = entry.date || entry.dateString;
      const timestamp = typeof date === "string" ? new Date(date).getTime() : date;
      
      return {
        sgv,
        date: timestamp,
        direction: entry.direction || entry.trend || "NONE"
      };
    } catch (error) {
      // Intentar usar caché si existe
      const cached = this.lastReadings.get(sessionId);
      if (cached) return cached;
      throw error;
    }
  }

  // ========== Formateo de Datos ==========
  formatGlucose(data, settings) {
    const value = this.toDisplay(data.sgv, settings.units);
    const arrow = this.getTrendArrow(data.direction);
    const time = new Date(data.date).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    const minutesAgo = Math.floor((Date.now() - data.date) / 60000);
    const ago = minutesAgo <= 1 ? "now" : `${minutesAgo}m ago`;
    
    return `${value} ${settings.units} ${arrow}\n${time} (${ago})`;
  }

  // ========== TIR (Time in Range) ==========
  updateTir(sessionId, sgv, settings, timestamp) {
    const low = settings.units === UNITS.MMOL 
      ? Math.round(settings.lowAlertMmol * 18) 
      : settings.lowAlertMg;
    const high = settings.units === UNITS.MMOL 
      ? Math.round(settings.highAlertMmol * 18) 
      : settings.highAlertMg;
    
    // Reset TIR daily
    const today = new Date(timestamp).toDateString();
    let tir = this.tirData.get(sessionId) || { date: today, total: 0, inRange: 0 };
    
    if (tir.date !== today) {
      tir = { date: today, total: 0, inRange: 0 };
    }
    
    tir.total++;
    if (sgv >= low && sgv <= high) {
      tir.inRange++;
    }
    
    this.tirData.set(sessionId, tir);
    
    return tir.total > 0 ? Math.round((tir.inRange / tir.total) * 100) : 0;
  }

  // ========== Treatments Tracking ==========
  async getTreatments(sessionId, settings) {
    const http = this.getHttpClient(sessionId, settings);
    if (!http) return null;
    
    try {
      const { data } = await http.get("/api/v1/treatments.json?count=100");
      const treatments = Array.isArray(data) ? data : [];
      const today = new Date().toDateString();
      
      let totalCarbs = 0;
      let totalInsulin = 0;
      let lastTreatment = null;
      
      treatments.forEach(t => {
        const date = new Date(t.created_at || t.timestamp || t.date);
        if (date.toDateString() === today) {
          if (Number.isFinite(t.carbs)) totalCarbs += t.carbs;
          if (Number.isFinite(t.insulin)) totalInsulin += t.insulin;
          
          if (!lastTreatment || date > new Date(lastTreatment.date)) {
            lastTreatment = { date, carbs: t.carbs, insulin: t.insulin };
          }
        }
      });
      
      return { totalCarbs, totalInsulin, lastTreatment };
    } catch (error) {
      return null;
    }
  }

  // ========== Predictions ==========
  async getPrediction(sessionId, settings) {
    const http = this.getHttpClient(sessionId, settings);
    if (!http) return null;
    
    try {
      // Check devicestatus for IOB/COB predictions
      const { data } = await http.get("/api/v1/devicestatus.json?count=1");
      const status = Array.isArray(data) ? data[0] : data;
      
      if (status?.predBGs) {
        const predictions = status.predBGs.IOB || status.predBGs.COB || status.predBGs.UAM;
        if (Array.isArray(predictions) && predictions.length > 1) {
          const low = settings.units === UNITS.MMOL 
            ? Math.round(settings.lowAlertMmol * 18) 
            : settings.lowAlertMg;
          const high = settings.units === UNITS.MMOL 
            ? Math.round(settings.highAlertMmol * 18) 
            : settings.highAlertMg;
          
          // Check for crossing thresholds
          for (let i = 1; i < Math.min(predictions.length, 12); i++) {
            const value = Number(predictions[i]);
            if (value <= low) {
              return `↓${this.toDisplay(low, settings.units)} @${i*5}m`;
            }
            if (value >= high) {
              return `↑${this.toDisplay(high, settings.units)} @${i*5}m`;
            }
          }
        }
      }
      
      // Fallback to linear prediction
      const { data: entries } = await http.get("/api/v1/entries.json?count=2");
      if (entries && entries.length >= 2) {
        const [current, previous] = entries;
        const rate = (current.sgv - previous.sgv) / ((current.date - previous.date) / 60000);
        
        if (Math.abs(rate) > 0.5) {
          const low = settings.lowAlertMg;
          const high = settings.highAlertMg;
          
          if (rate < 0 && current.sgv > low) {
            const mins = (low - current.sgv) / rate;
            if (mins > 0 && mins <= 30) {
              return `↓${this.toDisplay(low, settings.units)} @${Math.round(mins)}m`;
            }
          }
          if (rate > 0 && current.sgv < high) {
            const mins = (high - current.sgv) / rate;
            if (mins > 0 && mins <= 30) {
              return `↑${this.toDisplay(high, settings.units)} @${Math.round(mins)}m`;
            }
          }
        }
      }
    } catch (error) {
      // Silent fail for predictions
    }
    
    return null;
  }

  // ========== Alertas con Histéresis ==========
  async checkAlerts(sessionId, data, settings) {
    if (!settings.alertsEnabled) return;
    
    const state = this.alertState.get(sessionId) || { 
      lastAlert: 0, 
      latched: null,
      lastValue: null 
    };
    
    const now = Date.now();
    
    // Cooldown check
    if (now - state.lastAlert < settings.alertCooldown) return;
    
    const low = settings.units === UNITS.MMOL 
      ? Math.round(settings.lowAlertMmol * 18) 
      : settings.lowAlertMg;
    const high = settings.units === UNITS.MMOL 
      ? Math.round(settings.highAlertMmol * 18) 
      : settings.highAlertMg;
    
    // Hysteresis support
    const hysteresis = this.parseNumber(settings.alertHysteresisMg, 5);
    
    // Clear latch if recovered with hysteresis
    if (state.latched === "low" && data.sgv >= (low + hysteresis)) {
      state.latched = null;
    } else if (state.latched === "high" && data.sgv <= (high - hysteresis)) {
      state.latched = null;
    }
    
    // Check for new alerts
    let alertType = null;
    if (!state.latched) {
      if (data.sgv <= low) alertType = "low";
      else if (data.sgv >= high) alertType = "high";
    }
    
    if (alertType) {
      state.lastAlert = now;
      state.latched = alertType;
      state.lastValue = data.sgv;
      this.alertState.set(sessionId, state);
      
      await this.showAlert(sessionId, data, settings, alertType);
    }
  }

  async showAlert(sessionId, data, settings, type) {
    const value = this.toDisplay(data.sgv, settings.units);
    const message = type === "low" ? "LOW GLUCOSE!" : "HIGH GLUCOSE!";
    const text = `${message}\n${value} ${settings.units}`;
    
    // Animación de parpadeo
    const duration = settings.alertDuration;
    const blinkInterval = 650;
    const startTime = Date.now();
    
    const blink = setInterval(() => {
      if (Date.now() - startTime > duration) {
        clearInterval(blink);
        this.clearDisplay(sessionId);
        return;
      }
      
      const visible = Math.floor((Date.now() - startTime) / blinkInterval) % 2 === 0;
      this.showText(sessionId, visible ? `[!!] ${text}` : `[  ] ${text}`);
    }, blinkInterval);
  }

  // ========== Actualización Periódica ==========
  startUpdateLoop(sessionId) {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return;
    
    const interval = sessionData.settings.updateInterval * 60000;
    
    if (sessionData.updateTimer) {
      clearInterval(sessionData.updateTimer);
    }
    
    sessionData.updateTimer = setInterval(async () => {
      try {
        const data = await this.getGlucoseData(sessionId, sessionData.settings);
        this.lastReadings.set(sessionId, data);
        await this.checkAlerts(sessionId, data, sessionData.settings);
      } catch (error) {
        console.error(`Update failed for ${sessionId}:`, error.message);
      }
    }, interval);
  }

  // ========== Mostrar Datos ==========
  async displayGlucose(sessionId, duration = null) {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return;
    
    try {
      const data = await this.getGlucoseData(sessionId, sessionData.settings);
      this.lastReadings.set(sessionId, data);
      
      let display = this.formatGlucose(data, sessionData.settings);
      
      // Add prediction if available
      const prediction = await this.getPrediction(sessionId, sessionData.settings);
      if (prediction) {
        const lines = display.split("\n");
        lines[1] += ` · ${prediction}`;
        display = lines.join("\n");
      }
      
      if (sessionData.settings.advancedMode) {
        // Add TIR
        const tirPct = this.updateTir(sessionId, data.sgv, sessionData.settings, data.date);
        const tirLabel = sessionData.settings.language === "es" 
          ? `TIR hoy: ${tirPct}%`
          : `TIR today: ${tirPct}%`;
        
        if (sessionData.settings.showTirBar) {
          const blocks = Math.floor(tirPct / 5);
          display += `\n${tirLabel} ${"¦".repeat(blocks)}`;
        } else {
          display += `\n${tirLabel}`;
        }
        
        // Add treatments
        const treatments = await this.getTreatments(sessionId, sessionData.settings);
        if (treatments) {
          const { totalCarbs, totalInsulin } = treatments;
          const treatmentLabel = sessionData.settings.language === "es"
            ? `CH/Ins hoy: ${totalCarbs.toFixed(1)}g / ${totalInsulin.toFixed(1)}U`
            : `Carbs/Ins today: ${totalCarbs.toFixed(1)}g / ${totalInsulin.toFixed(1)}U`;
          display += `\n${treatmentLabel}`;
        }
      }
      
      this.showText(sessionId, display);
      
      if (duration) {
        setTimeout(() => this.clearDisplay(sessionId), duration);
      }
    } catch (error) {
      const fallback = sessionData.settings.language === "es" 
        ? "Error cargando datos\nVerifica configuración" 
        : "Error loading data\nCheck settings";
      this.showText(sessionId, fallback);
    }
  }

  // ========== Lifecycle ==========
  async onSession(session, sessionId, userId) {
    try {
      const settings = await this.getSettings(session);
      
      if (!settings.url) {
        const msg = settings.language === "es"
          ? "Configura Nightscout\nen ajustes"
          : "Configure Nightscout\nin settings";
        this.showText(sessionId, msg);
        return;
      }
      
      // Guardar sesión
      this.sessions.set(sessionId, {
        session,
        userId,
        settings,
        updateTimer: null
      });
      
      // Event handlers
      this.setupEventHandlers(session, sessionId);
      
      // Mostrar datos iniciales
      await this.displayGlucose(sessionId, settings.displayDuration);
      
      // Iniciar actualizaciones
      this.startUpdateLoop(sessionId);
      
    } catch (error) {
      console.error(`Session error for ${sessionId}:`, error);
      this.showText(sessionId, "Error: check settings");
    }
  }

  // ========== MIRA Tools Integration ==========
  async onToolCall(data) {
    const toolId = data.toolId || data.toolName;
    const userId = data.userId;
    const activeSession = data.activeSession;
    
    // Detect language from tool name
    const isSpanish = ["obtener_glucosa", "revisar_glucosa", "nivel_glucosa", "mi_glucosa"].includes(toolId);
    const lang = isSpanish ? "es" : "en";
    
    try {
      // Find user's session and settings
      let settings = null;
      let sessionId = null;
      
      // Try to get settings from active session first
      if (activeSession?.settings?.settings) {
        settings = this.parseSettingsArray(activeSession.settings.settings);
        sessionId = activeSession.sessionId;
      } else {
        // Search in active sessions
        for (const [id, sessionData] of this.sessions) {
          if (sessionData.userId === userId) {
            settings = sessionData.settings;
            sessionId = id;
            break;
          }
        }
      }
      
      if (!settings?.url || !settings?.token) {
        throw new Error(lang === "es" ? "Nightscout no configurado" : "Nightscout not configured");
      }
      
      // Get current glucose data
      const data = await this.getGlucoseData(sessionId || "tool", settings);
      const display = this.toDisplay(data.sgv, settings.units);
      const trend = this.getTrendArrow(data.direction);
      const status = this.getGlucoseStatus(data.sgv, settings, lang);
      
      // Get TIR if advanced mode enabled
      let tirPct = null;
      if (settings.advancedMode) {
        tirPct = this.updateTir(sessionId || "tool", data.sgv, settings, data.date);
      }
      
      // Build response message
      let message = lang === "es" 
        ? `Tu glucosa está en ${display} ${settings.units} ${trend}. Estado: ${status}.`
        : `Your glucose is ${display} ${settings.units} ${trend}. Status: ${status}.`;
      
      if (tirPct !== null) {
        message += lang === "es" ? ` TIR hoy: ${tirPct}%` : ` TIR today: ${tirPct}%`;
      }
      
      return {
        success: true,
        data: {
          glucose: display,
          unit: settings.units,
          trend,
          status,
          tirPct
        },
        message
      };
    } catch (error) {
      return {
        success: false,
        error: lang === "es" ? `Error: ${error.message}` : `Error: ${error.message}`
      };
    }
  }
  
  getGlucoseStatus(value, settings, lang) {
    const low = settings.units === UNITS.MMOL 
      ? Math.round(settings.lowAlertMmol * 18) 
      : settings.lowAlertMg;
    const high = settings.units === UNITS.MMOL 
      ? Math.round(settings.highAlertMmol * 18) 
      : settings.highAlertMg;
    
    if (value < 54) return lang === "es" ? "Crítico Bajo" : "Critical Low";
    if (value <= low) return lang === "es" ? "Bajo" : "Low";
    if (value > 250) return lang === "es" ? "Crítico Alto" : "Critical High";
    if (value >= high) return lang === "es" ? "Alto" : "High";
    return lang === "es" ? "Normal" : "Normal";
  }
  
  parseSettingsArray(settingsArray) {
    if (!Array.isArray(settingsArray)) return null;
    
    const settings = {};
    settingsArray.forEach(item => {
      if (item.key) settings[item.key] = item.value;
    });
    
    return {
      url: String(settings.nightscout_url || "").trim(),
      token: String(settings.nightscout_token || "").trim(),
      units: settings.units || UNITS.MGDL,
      lowAlertMg: this.parseNumber(settings.low_alert_mg, 70),
      highAlertMg: this.parseNumber(settings.high_alert_mg, 250),
      lowAlertMmol: this.parseNumber(settings.low_alert_mmol, 3.9),
      highAlertMmol: this.parseNumber(settings.high_alert_mmol, 13.9),
      advancedMode: this.toBool(settings.enable_advanced_mode),
      language: settings.language || "en"
    };
  }

  setupEventHandlers(session, sessionId) {
    // Botón para mostrar glucosa
    session.events?.onButtonPress?.(async () => {
      const sessionData = this.sessions.get(sessionId);
      if (sessionData) {
        await this.displayGlucose(sessionId, sessionData.settings.displayDuration);
      }
    });
    
    // Head-up display
    session.events?.onHeadPosition?.(async (data) => {
      if (data?.position === "up") {
        const sessionData = this.sessions.get(sessionId);
        if (sessionData?.settings.headUpEnabled) {
          await this.displayGlucose(sessionId, sessionData.settings.displayDuration);
        }
      }
    });
    
    // Actualización de settings
    session.events?.onSettingsUpdate?.(async (newSettings) => {
      const sessionData = this.sessions.get(sessionId);
      if (sessionData) {
        sessionData.settings = await this.getSettings(session);
        this.startUpdateLoop(sessionId); // Reiniciar con nuevo intervalo
      }
    });
    
    // Desconexión
    session.events?.onDisconnected?.(() => {
      const sessionData = this.sessions.get(sessionId);
      if (sessionData?.updateTimer) {
        clearInterval(sessionData.updateTimer);
      }
      this.sessions.delete(sessionId);
      this.httpClients.delete(sessionId);
      this.alertState.delete(sessionId);
      this.tirData.delete(sessionId);
      this.lastReadings.delete(sessionId);
    });
  }
}

// ========== Inicialización ==========
const server = new NightscoutMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT
});

// Startup boot image support (optional)
server.showBootImage = async function(session, sessionId) {
  const bootImagePath = path.join(process.cwd(), "assets", "bitmaps", "syringes_shield_526x100.bmp");
  if (fs.existsSync(bootImagePath)) {
    try {
      const bitmap = fs.readFileSync(bootImagePath).toString("base64");
      if (session.layouts?.showBitmapView) {
        session.layouts.showBitmapView(bitmap, { durationMs: 3000 });
      } else if (session.showBitmap) {
        session.showBitmap(bitmap, { durationMs: 3000 });
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (error) {
      console.log("Boot image not shown:", error.message);
    }
  }
};

// Override onSession to add boot image
const originalOnSession = server.onSession.bind(server);
server.onSession = async function(session, sessionId, userId) {
  // Show boot image first if available
  await this.showBootImage(session, sessionId);
  // Continue with normal session setup
  return originalOnSession(session, sessionId, userId);
};

// Health check endpoint
server.app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    sessions: server.sessions.size,
    version: "optimized-2.0"
  });
});

// Lifecycle event handlers
server.on?.("stop", (info) => console.log("[LIFECYCLE] Server stopped", info));
server.on?.("start", (info) => console.log("[LIFECYCLE] Server started", info));
server.on?.("sessionClosed", (info) => console.log("[LIFECYCLE] Session closed", info));

// Global error handlers
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err?.stack || err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});

// Iniciar servidor
server.start()
  .then(() => console.log(`🚀 Nightscout MentraOS running on port ${PORT}`))
  .catch(err => {
    console.error("⛔ Failed to start server:", err);
    process.exit(1);
  });
