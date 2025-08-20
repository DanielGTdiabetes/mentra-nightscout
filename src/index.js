"use strict";
/**
 * Nightscout MentraOS v2.13.1 (Hysteresis + ECO con estado de alarma + Pred no-avanzado)
 * HUD texto + TIR-bar ¦ CH/Ins día + Min/Max sólo gesto ¦ reset diario
 * ES/EN + mg/dL/mmol ¦ 5 líneas max ¦ cache last-good-entry
 * Settings en segundos/minutos + toggle barra TIR
 * Mejora: cliente axios por sesión, debounce de settings, animación reforzada
 * NUEVO:
 *  - Histeresis de alarmas (alert_hysteresis_mg / alert_hysteresis_mmol) con latch
 *  - En NO avanzado, predicción sólo si cruza ≤60 o ≥180 mg/dL (fijos)
 *  - ECO al guardar ajustes incluye estado de alarmas (BAJA/ALTA/Sin) en ES/EN, compacto
 *  - Soporte opcional para bitmaps (si están disponibles) - CORREGIDO para SDK
 */

require('dotenv').config();
const { AppServer } = require('@mentra/sdk');
const axios = require('axios');

// Bitmaps externos (no tocar servidor si faltan; fallback a texto)
let loadAllBitmaps = null, getBitmap = null, hasBitmap = null;
try {
  ({ loadAllBitmaps, getBitmap, hasBitmap } = require('./bitmaps'));
  try { if (typeof loadAllBitmaps === 'function') loadAllBitmaps(); } catch (_) {}
} catch (_) {
  // Si no hay módulo de bitmaps, crear funciones vacías
  loadAllBitmaps = () => {};
  getBitmap = () => null;
  hasBitmap = () => false;
}

/* ---------- SHIM: compatibilidad SDK ---------- */
if (typeof Object.prototype.updateSettingsForTesting !== 'function') {
  Object.defineProperty(Object.prototype, 'updateSettingsForTesting', {
    value: async () => {},
    writable: true,
    configurable: true,
    enumerable: false
  });
}

/* ---------- CONFIG ---------- */
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.tucompania.nightscout-glucose';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

if (!MENTRAOS_API_KEY) {
  console.error('⛔ MENTRAOS_API_KEY environment variable is required');
  process.exit(1);
}

const UNITS = { MGDL: 'mg/dL', MMOL: 'mmol/L' };

class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.activeSessions = new Map();
    this.alertHistory = new Map();
    this.alertLatch = new Map();       // latch 'low' | 'high' | null
    this.displayTimers = new Map();
    this.headUpLastShown = new Map();
    this.dailyTirState = new Map();
    this.dayWatchTimers = new Map();
    this.lastGoodEntry = new Map();
    this._renderToken = new Map();
    this._lastShownText = new Map();
    this._http = new Map();             // cliente axios por sesión
    this._settingsDebounce = new Map(); // debounce settings
    this._sessionLocale = new Map();    // cache locale/tz por sesión
  }

  /* ---------- helpers ---------- */
  __delay(ms) { return new Promise(res => setTimeout(res, ms)); }
  __clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
  __easeInOutCubic(t){ return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }
  __getEasingFunction(type = 'cubic'){
    if (type === 'smooth') return (t)=> t*t*(3 - 2*t);
    if (type === 'linear') return (t)=> t;
    return (t)=> this.__easeInOutCubic(t);
  }
  __barFromRatio(ratio, slots){
    const n = Math.round(this.__clamp01(ratio) * slots);
    const filled = '¦'.repeat(n);
    const empty  = '·'.repeat(Math.max(0, slots - n));
    return `[${filled}${empty}]`;
  }
  _scheduleHide(sessionId, ms){
    if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));
    const t = setTimeout(() => this.hideDisplay(this.activeSessions.get(sessionId)?.session, sessionId), ms);
    this.displayTimers.set(sessionId, t);
  }

  parseSlicerValue(val, fallback) {
    const n = (typeof val === 'object' && val !== null) ? parseFloat(val.value) : parseFloat(val);
    return Number.isFinite(n) ? n : fallback;
  }
  validateSlicerValue(val, min, max, fallback) {
    const v = this.parseSlicerValue(val, fallback);
    return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
  }
  toBool(x) { return (x === true || x === 'true' || x === 1 || x === '1'); }
  normalizeMmol(x) {
    const v = this.parseSlicerValue(x, null);
    // UI mmol a veces viene x10 (p.ej. 39 = 3.9)
    return (v !== null && Number.isFinite(v)) ? (v >= 30 ? v / 10 : v) : null;
  }

  /* ---------- alertas / límites ---------- */
  getAlertLimits(settings) {
    const units = String(settings.units || '').toLowerCase();

    // Candidatos en mg/dL (tal cual)
    const lowMgRaw  = this.parseSlicerValue(settings.low_alert_mg,  NaN);
    const highMgRaw = this.parseSlicerValue(settings.high_alert_mg, NaN);
    const lowMgOK   = Number.isFinite(lowMgRaw)  ? Math.round(lowMgRaw)  : NaN;
    const highMgOK  = Number.isFinite(highMgRaw) ? Math.round(highMgRaw) : NaN;

    // Candidatos en mmol (pueden venir como 39=>3.9). normalizeMmol ya maneja x10.
    const lowMmol   = this.normalizeMmol(settings.low_alert_mmol);
    const highMmol  = this.normalizeMmol(settings.high_alert_mmol);
    const lowFromMmolMg  = Number.isFinite(lowMmol)  ? Math.round(lowMmol  * 18) : NaN;
    const highFromMmolMg = Number.isFinite(highMmol) ? Math.round(highMmol * 18) : NaN;

    if (units.includes('mmol')) {
      // mmol/L tiene prioridad
      if (Number.isFinite(lowFromMmolMg) && Number.isFinite(highFromMmolMg)) {
        return { low: lowFromMmolMg, high: highFromMmolMg };
      }
      if (Number.isFinite(lowMgOK) && Number.isFinite(highMgOK)) {
        return { low: lowMgOK, high: highMgOK };
      }
      // Fallback por defecto típico mmol (3.9/13.9)
      return { low: Math.round(3.9 * 18), high: Math.round(13.9 * 18) };
    } else {
      // mg/dL tiene prioridad (o unidad desconocida)
      if (Number.isFinite(lowMgOK) && Number.isFinite(highMgOK)) {
        return { low: lowMgOK, high: highMgOK };
      }
      if (Number.isFinite(lowFromMmolMg) && Number.isFinite(highFromMmolMg)) {
        return { low: lowFromMmolMg, high: highFromMmolMg };
      }
      // Fallback por defecto típico mg/dL
      return { low: 70, high: 250 };
    }
  }

  getHysteresisMg(settings) {
    // Lee candidatos
    const mg = this.validateSlicerValue(settings.alert_hysteresis_mg, 0, 50, NaN);

    // mmol puede venir sin decimales (x10) o con decimales según UI
    const raw = this.parseSlicerValue(settings.alert_hysteresis_mmol, NaN);
    let mmol = NaN;
    if (Number.isFinite(raw)) {
      if (Number.isInteger(raw)) {
        // Consola sin decimales: 0..10 => 0.0..1.0  (p.ej. 3 => 0.3 mmol)
        if (raw >= 0 && raw <= 10) mmol = raw / 10;
        // Compatibilidad con "x10 grande" (39 => 3.9) si alguien lo usa aquí
        else if (raw >= 30) mmol = raw / 10;
        else mmol = raw; // enteros raros: tratamos como mmol real
      } else {
        mmol = raw; // ya decimal (si alguna UI lo permite)
      }
    }
    const mmolAsMg = Number.isFinite(mmol) ? Math.round(mmol * 18) : NaN;

    const units = String(settings.units || '').toLowerCase();

    // PRIORIDAD POR UNIDAD SELECCIONADA
    if (units.includes('mmol')) {        // mmol/L => usa mmol primero
      if (Number.isFinite(mmolAsMg)) return mmolAsMg;
      if (Number.isFinite(mg))        return mg;
      return 5; // fallback
    } else {                            // mg/dL (o desconocida) => usa mg primero
      if (Number.isFinite(mg))        return mg;
      if (Number.isFinite(mmolAsMg))  return mmolAsMg;
      return 5; // fallback
    }
  }

  /* ---------- lectura de settings ---------- */
  async getUserSettings(session) {
    try {
      const keys = [
        'nightscout_url','nightscout_token','update_interval',
        'low_alert_mg','high_alert_mg','low_alert_mmol','high_alert_mmol',
        'alerts_enabled','language','timezone','units',
        'enable_head_up_display',
        'display_duration_s','alert_duration_s','alert_cooldown_min',
        'show_tir_bar','show_range_bar',
        'display_duration_ms','alert_duration_ms','alert_cooldown_ms',
        'enable_advanced_mode','advanced_mode_enabled',
        // NUEVO:
        'alert_hysteresis_mg','alert_hysteresis_mmol',
        // legacy tolerados
        'tir_low_mg','tir_high_mg','tir_low_mmol','tir_high_mmol',
        'time_in_range_low_mg','time_in_range_high_mg','time_in_range_low_mmol','time_in_range_high_mmol',
        'prediction_horizon_min','prediction_horizon_mins',
        'debug_force_alert'
      ];
      const vals = await Promise.all(keys.map(k => session.settings.get(k)));
      const kv = Object.fromEntries(keys.map((k,i)=>[k,vals[i]]));

      const uiMin = parseInt(kv.update_interval, 10);
      const ui = Number.isFinite(uiMin) ? uiMin : 5;

      const displayMs = Number.isFinite(this.parseSlicerValue(kv.display_duration_s, NaN))
        ? Math.min(15, Math.max(1, this.parseSlicerValue(kv.display_duration_s))) * 1000
        : this.validateSlicerValue(kv.display_duration_ms, 1000, 15000, 5000);

      const alertMs = Number.isFinite(this.parseSlicerValue(kv.alert_duration_s, NaN))
        ? Math.min(60, Math.max(2, this.parseSlicerValue(kv.alert_duration_s))) * 1000
        : this.validateSlicerValue(kv.alert_duration_ms, 2000, 60000, 15000);

      const coolMs = Number.isFinite(this.parseSlicerValue(kv.alert_cooldown_min, NaN))
        ? Math.min(60, Math.max(1, this.parseSlicerValue(kv.alert_cooldown_min))) * 60 * 1000
        : this.validateSlicerValue(kv.alert_cooldown_ms, 60000, 3600000, 600000);

      const showTirBar = (kv.show_tir_bar == null && kv.show_range_bar == null)
        ? true
        : (this.toBool(kv.show_tir_bar) || this.toBool(kv.show_range_bar));

      return {
        nightscoutUrl: String(kv.nightscout_url || '').trim() || '',
        nightscoutToken: String(kv.nightscout_token || '').trim() || '',
        updateInterval: ui,
        low_alert_mg: this.validateSlicerValue(kv.low_alert_mg, 50, 120, 70),
        high_alert_mg: this.validateSlicerValue(kv.high_alert_mg, 180, 400, 250),
        low_alert_mmol: this.normalizeMmol(kv.low_alert_mmol) ?? 3.9,
        high_alert_mmol: this.normalizeMmol(kv.high_alert_mmol) ?? 13.9,
        alertsEnabled: this.toBool(kv.alerts_enabled),
        language: kv.language || 'en',
        timezone: kv.timezone || null,
        units: kv.units || UNITS.MGDL,
        enable_head_up_display: this.toBool(kv.enable_head_up_display),
        display_duration_ms: displayMs,
        alert_duration_ms: alertMs,
        alert_cooldown_ms: coolMs,
        show_tir_bar: showTirBar,
        enable_advanced_mode: this.toBool(kv.enable_advanced_mode) || this.toBool(kv.advanced_mode_enabled),
        // NEW: histeresis (defaults)
        alert_hysteresis_mg: this.validateSlicerValue(kv.alert_hysteresis_mg, 0, 50, 5),
        alert_hysteresis_mmol: this.normalizeMmol(kv.alert_hysteresis_mmol) ?? 0.3,
        // legacy tolerados
        tir_low_mg: this.parseSlicerValue(kv.tir_low_mg, null),
        tir_high_mg: this.parseSlicerValue(kv.tir_high_mg, null),
        tir_low_mmol: this.normalizeMmol(kv.tir_low_mmol),
        tir_high_mmol: this.normalizeMmol(kv.tir_high_mmol),
        time_in_range_low_mg: this.parseSlicerValue(kv.time_in_range_low_mg, null),
        time_in_range_high_mg: this.parseSlicerValue(kv.time_in_range_high_mg, null),
        time_in_range_low_mmol: this.normalizeMmol(kv.time_in_range_low_mmol),
        time_in_range_high_mmol: this.normalizeMmol(kv.time_in_range_high_mmol),
        prediction_horizon_min: [15,30,60].includes(Number(kv.prediction_horizon_min || kv.prediction_horizon_mins))
          ? Number(kv.prediction_horizon_min || kv.prediction_horizon_mins) : 30,
        debug_force_alert: (typeof kv.debug_force_alert === 'string' ? kv.debug_force_alert : null),
      };
    } catch (e) {
      console.error('Error leyendo settings:', e);
      return {
        nightscoutUrl: '', nightscoutToken: '',
        updateInterval: 5,
        low_alert_mg: 70, high_alert_mg: 250,
        low_alert_mmol: 3.9, high_alert_mmol: 13.9,
        alertsEnabled: true, language: 'en', timezone: null, units: UNITS.MGDL,
        enable_head_up_display: false,
        display_duration_ms: 5000, alert_duration_ms: 15000, alert_cooldown_ms: 600000,
        show_tir_bar: true,
        enable_advanced_mode: false,
        alert_hysteresis_mg: 5, alert_hysteresis_mmol: 0.3,
        prediction_horizon_min: 30,
        debug_force_alert: null
      };
    }
  }
  this._http.delete(sessionId);
        this._sessionLocale.delete(sessionId);
        this.activeSessions.delete(sessionId); this.alertHistory.delete(sessionId);
        this.alertLatch.delete(sessionId);
        this.headUpLastShown.delete(sessionId); this.dailyTirState.delete(sessionId); this.lastGoodEntry.delete(sessionId);
        session.logger?.info('Session disconnected');
      });
    } catch (error) {
      console.error('⚠️ Error setting up event handlers:', error);
      session.logger?.error(error, 'Failed to setup event handlers');
    }
  }

  async showGlucoseTemporarily(session, sessionId, ms, providedSettings) {
    try {
      const sd = this.activeSessions.get(sessionId);
      if (!sd) return;
      const settings = providedSettings || sd.settings || await this.getUserSettings(sd.session);
      const data = await this.getGlucoseData(settings, sessionId);
      this.lastGoodEntry.set(sessionId, data);
      const { tirPct } = this.updateDailyTirState(sessionId, data.sgv, data.date, settings);
      if (settings.enable_advanced_mode) {
        const header = await this.formatForG1WithPrediction(data, settings, sessionId);
        let tLine = '';
        try { const sum = await this.getRecentTreatments(settings, 'day', sessionId); tLine = this.formatTreatmentsLine(sum, settings, sessionId); } catch {}
        await this.animateTIRFill(session, sessionId, settings, header, tirPct, tLine);
      } else {
        this.showClamped(session, sessionId, await this.formatForG1WithPrediction(data, settings, sessionId));
      }
      this._scheduleHide(sessionId, ms);
    } catch (error) {
      try {
        const cached = this.lastGoodEntry.get(sessionId);
        if (cached) {
          const s = this.activeSessions.get(sessionId)?.settings || {};
          const txt = await this.formatForG1WithPrediction(cached, s, sessionId);
          this.showClamped(session, sessionId, txt);
          this._scheduleHide(sessionId, ms);
          return;
        }
      } catch (_) {}
      session.logger?.error(error, 'Failed to show glucose temporarily');
    }
  }

  async startNormalOperation(session, sessionId, userId, initialSettings) {
    const ms = (initialSettings.updateInterval || 5) * 60 * 1000;
    const iv = setInterval(async () => {
      if (!this.activeSessions.has(sessionId)) return clearInterval(iv);
      try {
        const sd = this.activeSessions.get(sessionId);
        const s = (sd && sd.settings) ? sd.settings : await this.getUserSettings(session);
        const d = await this.getGlucoseData(s, sessionId);
        this.lastGoodEntry.set(sessionId, d);
        this.updateDailyTirState(sessionId, d.sgv, d.date, s);
        if (s.alertsEnabled) await this.checkAlerts(session, sessionId, d, s);
      } catch (error) {
        session.logger?.debug('Normal operation cycle failed', { error: error.message });
      }
    }, ms);
    const sd = this.activeSessions.get(sessionId);
    if (sd) {
      if (sd.updateInterval) clearInterval(sd.updateInterval);
      sd.updateInterval = iv;
      this.activeSessions.set(sessionId, sd);
    }
  }

  async checkAlerts(session, sessionId, data, settings) {
    const limits = this.getAlertLimits(settings);
    const mgdl = data.sgv;
    const cooldown = settings.alert_cooldown_ms || 600000;
    const lastAlertTs = this.alertHistory.get(sessionId);
    const latch = this.alertLatch.get(sessionId) || null;
    const h = this.getHysteresisMg(settings);

    // Rearme por histeresis
    if (latch === 'low' && mgdl >= (limits.low + h)) {
      this.alertLatch.set(sessionId, null);
    } else if (latch === 'high' && mgdl <= (limits.high - h)) {
      this.alertLatch.set(sessionId, null);
    }

    // Si sigue latcheado, no relanzar
    if (this.alertLatch.get(sessionId)) return;

    // Cooldown general
    if (lastAlertTs && Date.now() - lastAlertTs < cooldown) return;

    // Forzado debug
    const dbg = (settings.debug_force_alert || '').toLowerCase();
    let alertType = null;

    if (mgdl <= limits.low || dbg === 'low') {
      alertType = 'low';
    } else if (mgdl >= limits.high || dbg === 'high') {
      alertType = 'high';
    }

    if (alertType) {
      this.alertHistory.set(sessionId, Date.now());
      this.alertLatch.set(sessionId, alertType);
      await this.triggerAnimatedAlert(session, sessionId, data, settings, alertType);
      session.logger?.warn('Alert sent', { type: alertType, value: mgdl });
    }
  }

  async triggerAnimatedAlert(session, sessionId, data, settings, type) {
    const displayValue = this.convertToDisplay(data.sgv, settings.units || UNITS.MGDL);
    const unit = settings.units || UNITS.MGDL;
    const lang = settings.language || 'en';
    const msgs = {
      en: { low: `LOW GLUCOSE!`, high: `HIGH GLUCOSE!` },
      es: { low: `¡GLUCOSA BAJA!`, high: `¡GLUCOSA ALTA!` }
    };
    const baseText = `${msgs[lang][type]}\n${displayValue} ${unit}`;
    const alertDuration = settings.alert_duration_ms || 15000;
    const blinkInterval = 600;

    if (this.displayTimers.has(sessionId)) clearTimeout(this.displayTimers.get(sessionId));

    // Intentar mostrar bitmap si está disponible - CORREGIDO PARA SDK
    let bitmapShown = false;
    try {
      const bmpKey = type === 'low' ? 'alert-low-526x100' : 'alert-high-526x100';
      if (hasBitmap && hasBitmap(bmpKey) && getBitmap) {
        const bmp = getBitmap(bmpKey);
        if (bmp && session && session.layouts && typeof session.layouts.showBitmapView === 'function') {
          // El bitmap debe estar en formato hex BMP, no RGBA
          if (bmp.hexData) {
            // Usar el método correcto del SDK con duración
            session.layouts.showBitmapView(bmp.hexData, { durationMs: alertDuration });
            bitmapShown = true;
          } else if (bmp.dataRGBA && bmp.width && bmp.height) {
            // Si solo tenemos datos RGBA, intentar convertir
            const hexData = this.convertRGBAToBMPHex(bmp.dataRGBA, bmp.width, bmp.height);
            if (hexData) {
              session.layouts.showBitmapView(hexData, { durationMs: alertDuration });
              bitmapShown = true;
            }
          }
        }
      }
    } catch (e) {
      console.error('Error mostrando bitmap:', e);
    }

    // Si no se pudo mostrar bitmap, usar texto parpadeante normal
    if (!bitmapShown) {
      const startTime = Date.now();
      let isVisible = true;
      const blinker = setInterval(() => {
        if (Date.now() - startTime > alertDuration) {
          clearInterval(blinker);
          this.hideDisplay(session, sessionId);
          return;
        }
        const symbol = isVisible ? '[!]' : '[ ]';
        this.showClamped(session, sessionId, `${symbol} ${baseText}`);
        isVisible = !isVisible;
      }, blinkInterval);

      this.displayTimers.set(sessionId, setTimeout(() => {
        clearInterval(blinker);
        this.hideDisplay(session, sessionId);
      }, alertDuration + 120));
    } else {
      // Si se mostró bitmap, programar ocultado después de la duración de alerta
      this.displayTimers.set(sessionId, setTimeout(() => {
        this.hideDisplay(session, sessionId);
      }, alertDuration));
    }
  }

  alertLimitsChanged(oldSettings, newSettings) {
    if (!oldSettings) return false;
    return (
      oldSettings.low_alert_mg !== newSettings.low_alert_mg ||
      oldSettings.high_alert_mg !== newSettings.high_alert_mg ||
      oldSettings.low_alert_mmol !== newSettings.low_alert_mmol ||
      oldSettings.high_alert_mmol !== newSettings.high_alert_mmol ||
      oldSettings.units !== newSettings.units ||
      oldSettings.alert_hysteresis_mg !== newSettings.alert_hysteresis_mg ||
      oldSettings.alert_hysteresis_mmol !== newSettings.alert_hysteresis_mmol
    );
  }

  /* ---------- MIRA tool ---------- */
  async onToolCall(data) {
    const toolId = data.toolId || data.toolName;
    const userId = data.userId;
    const activeSession = data.activeSession;
    const isSpanish = ['obtener_glucosa', 'revisar_glucosa', 'nivel_glucosa', 'mi_glucosa'].includes(toolId);
    const lang = isSpanish ? 'es' : 'en';

    let settings = null;
    try {
      if (activeSession?.settings?.settings) {
        settings = this.parseSettingsFromArray(activeSession.settings.settings);
      } else {
        for (const [, sData] of this.activeSessions) {
          if (sData.userId === userId) { settings = sData.settings || await this.getUserSettings(sData.session); break; }
        }
      }
      if (!settings?.nightscoutUrl || !settings?.nightscoutToken) {
        throw new Error(lang === 'es' ? 'Nightscout no configurado' : 'Nightscout not configured');
        }
      const reading = await this.getGlucoseData(settings);
      const display = this.convertToDisplay(reading.sgv, settings.units || UNITS.MGDL);
      const trend = this.getTrendArrow(reading.direction);
      const status = this.getGlucoseStatusText(reading.sgv, settings, lang);
      const { tirPct } = this.updateDailyTirState(activeSession?.sessionId || 'tool', reading.sgv, reading.date, settings);
      let extra = '';
      if (settings.enable_advanced_mode && Number.isFinite(tirPct)) {
        extra = lang === 'es' ? ` TIR hoy: ${tirPct}%` : ` TIR: ${tirPct}%`;
      }
      const msg = lang === 'es'
        ? `Tu glucosa está en ${display} ${settings.units || UNITS.MGDL} ${trend}. Estado: ${status}.${extra}`
        : `Your glucose is ${display} ${settings.units || UNITS.MGDL} ${trend}. Status: ${status}.${extra}`;
      return { success: true, data: { glucose: display, unit: settings.units || UNITS.MGDL, trend, status, tirPct: Number.isFinite(tirPct) ? tirPct : null }, message: msg };
    } catch (e) {
      return { success: false, error: lang === 'es' ? `Error: ${e.message}` : `Error: ${e.message}` };
    }
  }

  getGlucoseStatusText(value, settings, lang) {
    const limits = this.getAlertLimits(settings);
    if (value < 70) return lang === 'es' ? 'Crítico Bajo' : 'Critical Low';
    if (value <= limits.low) return lang === 'es' ? 'Bajo' : 'Low';
    if (value > 250) return lang === 'es' ? 'Crítico Alto' : 'Critical High';
    if (value >= limits.high) return lang === 'es' ? 'Alto' : 'High';
    return lang === 'es' ? 'Normal' : 'Normal';
  }
}

/* ---------- init ---------- */
const server = new NightscoutMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT,
});
server.start().catch(err => {
  console.error('⛔ Error iniciando servidor:', err);
  process.exit(1);
});
console.log('🚀 Nightscout MentraOS v2.13.1 — Hysteresis + ECO + Pred no-avanzado + Bitmaps corregidos para SDK');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_, res) => res.json({
  status: 'alive',
  timestamp: new Date().toISOString(),
  version: '2.13.1',
  activeSessions: server.activeSessions.size
}));
setInterval(() => axios.get(`${KEEP_ALIVE_URL}/health`).catch(() => {}), 3 * 60 * 1000);
