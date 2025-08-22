"use strict";
/**
 * Nightscout MentraOS — Versión Optimizada
 * - Alertas de texto animadas
 * - HUD con predicción y TIR
 * - Integración con Even Realities G1
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
const RENDER_LAYERS = { ECO: 0, HUD: 1, BOOT: 2, ALERT: 3 };

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
      "alert_cooldown_min", "show_tir_bar", "enable_advanced_mode"
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
      units: settings.units || UNITS.MGDL,
      headUpEnabled: this.toBool(settings.enable_head_up_display),
      displayDuration: Math.max(1000, Math.min(15000, (this.parseNumber(settings.display_duration_s, 5) * 1000))),
      alertDuration: Math.max(2000, Math.min(60000, (this.parseNumber(settings.alert_duration_s, 15) * 1000))),
      alertCooldown: Math.max(60000, Math.min(3600000, (this.parseNumber(settings.alert_cooldown_min, 10) * 60000))),
      showTirBar: this.toBool(settings.show_tir_bar),
      advancedMode: this.toBool(settings.enable_advanced_mode)
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
  updateTir(sessionId, sgv, settings) {
    const low = settings.units === UNITS.MMOL 
      ? Math.round(settings.lowAlertMmol * 18) 
      : settings.lowAlertMg;
    const high = settings.units === UNITS.MMOL 
      ? Math.round(settings.highAlertMmol * 18) 
      : settings.highAlertMg;
    
    let tir = this.tirData.get(sessionId) || { total: 0, inRange: 0 };
    
    tir.total++;
    if (sgv >= low && sgv <= high) {
      tir.inRange++;
    }
    
    this.tirData.set(sessionId, tir);
    
    return tir.total > 0 ? Math.round((tir.inRange / tir.total) * 100) : 0;
  }

  // ========== Alertas ==========
  async checkAlerts(sessionId, data, settings) {
    if (!settings.alertsEnabled) return;
    
    const state = this.alertState.get(sessionId) || { lastAlert: 0, latched: null };
    const now = Date.now();
    
    // Cooldown check
    if (now - state.lastAlert < settings.alertCooldown) return;
    
    const low = settings.units === UNITS.MMOL 
      ? Math.round(settings.lowAlertMmol * 18) 
      : settings.lowAlertMg;
    const high = settings.units === UNITS.MMOL 
      ? Math.round(settings.highAlertMmol * 18) 
      : settings.highAlertMg;
    
    let alertType = null;
    if (data.sgv <= low) alertType = "low";
    else if (data.sgv >= high) alertType = "high";
    
    if (alertType && alertType !== state.latched) {
      state.lastAlert = now;
      state.latched = alertType;
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
      
      if (sessionData.settings.advancedMode) {
        const tirPct = this.updateTir(sessionId, data.sgv, sessionData.settings);
        display += `\nTIR: ${tirPct}%`;
        
        if (sessionData.settings.showTirBar) {
          const blocks = Math.floor(tirPct / 5);
          display += ` ${"¦".repeat(blocks)}`;
        }
      }
      
      this.showText(sessionId, display);
      
      if (duration) {
        setTimeout(() => this.clearDisplay(sessionId), duration);
      }
    } catch (error) {
      const fallback = sessionData.settings.language === "es" 
        ? "Error cargando datos" 
        : "Error loading data";
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

// Health check endpoint
server.app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    sessions: server.sessions.size
  });
});

// Iniciar servidor
server.start()
  .then(() => console.log(`🚀 Nightscout MentraOS running on port ${PORT}`))
  .catch(err => {
    console.error("⛔ Failed to start server:", err);
    process.exit(1);
  });
