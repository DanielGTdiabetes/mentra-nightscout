"use strict";
/**
 * Nightscout MentraOS — v2.10.4-gesture-only
 * - Display SOLO por gesto (head-up) o botón manual
 * - Bucle normal: solo fetch + alertas (NO muestra)
 * - Combined view (text + sparkline) 526x128 con márgenes seguros
 * - Fallback robusto a texto
 * - Echos de ajustes + auto-limpieza + candado por sesión
 */

require("dotenv").config();
const { AppServer } = require("@mentra/sdk");
const axios = require("axios");

/* ---------- SHIM de compatibilidad ---------- */
if (typeof Object.prototype.updateSettingsForTesting !== "function") {
  Object.defineProperty(Object.prototype, "updateSettingsForTesting", {
    value: async function () {},
    writable: true, configurable: true, enumerable: false,
  });
}
/* ------------------------------------------- */

const PACKAGE_NAME     = process.env.PACKAGE_NAME || "com.tucompania.nightscout-glucose";
const PORT             = parseInt(process.env.PORT || "3000", 10);
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;

if (!MENTRAOS_API_KEY) {
  console.error("❌ MENTRAOS_API_KEY is required");
  process.exit(1);
}

const UNITS = { MGDL: "mg/dL", MMOL: "mmol/L" };
const CRITICAL_THRESHOLDS = { LOW_MGDL: 70, HIGH_MGDL: 250 };

/* ------ Dimensiones seguras y layout ------ */
const BMP_WIDTH  = 576;
const BMP_HEIGHT = 135;

const SAFE_TOP = 17, SAFE_BOTTOM = 12, SAFE_LEFT = 10, SAFE_RIGHT = 10;

const LAYOUT = {
  text:  { x: SAFE_LEFT, y: SAFE_TOP + 10, scale: 2 },  // antes: +2
  spark: {
    x: Math.floor(BMP_WIDTH * 0.50),
    y: SAFE_TOP + 6,                                     // un poco más bajo
    width: BMP_WIDTH - Math.floor(BMP_WIDTH * 0.50) - SAFE_RIGHT,
    height: BMP_HEIGHT - (SAFE_TOP + 6) - SAFE_BOTTOM - 1
  }
};

// Durante la prueba, baja el umbral para ver la sparkline enseguida:
const MIN_HISTORY_FOR_SPARKLINE = 2; // luego vuelve a 6 si quieres

/* ===================================================== */
class NightscoutMentraApp extends AppServer {
  constructor(opts) {
    super(opts);
    this.sessions = new Map();
    this.alertHistory = new Map();
    this.glucoseHistory = new Map();
    this.lastHeadUp = new Map();
    this.headUpLastShown = new Map();

    // Auto-limpieza y candado de pantalla
    this.displayCleanupTimers = new Map(); // sessionId -> timeoutId
    this.displayLocks = new Map();        // sessionId -> boolean
  }

  /* ---------- Helpers de settings/validación ---------- */
  parseSlicerValue(v, fb) {
    const n = (typeof v === "object" && v) ? parseFloat(v.value) : parseFloat(v);
    return Number.isFinite(n) ? n : fb;
  }
  validateSlicerValue(v, min, max, fb) {
    const n = this.parseSlicerValue(v, fb);
    if (!Number.isFinite(n)) return fb;
    return Math.max(min, Math.min(max, n));
  }
  toBool(x){ return (x===true||x==='true'||x===1||x==='1'); }

  syncFromMmolToMg(mmol, min = 40, max = 400) {
    const mg = Math.round((Number(mmol) || 0) * 18);
    return Math.max(min, Math.min(max, mg));
  }
  syncFromMgToMmol(mg, min = 2, max = 30) {
    const mmol = Number(((Number(mg) || 0) / 18).toFixed(1));
    return Math.max(min, Math.min(max, mmol));
  }
  isDifferent(a,b,t=0.1){return Math.abs(Number(a)-Number(b))>t;}

  getAlertLimits(s) {
    if (s.units === UNITS.MMOL) return { low: Math.round(s.low_alert_mmol*18), high: Math.round(s.high_alert_mmol*18) };
    return { low: Math.round(s.low_alert_mg), high: Math.round(s.high_alert_mg) };
  }
  alertLimitsChanged(a,b){
    if(!a) return true;
    return a.low_alert_mg!==b.low_alert_mg || a.high_alert_mg!==b.high_alert_mg ||
           a.low_alert_mmol!==b.low_alert_mmol || a.high_alert_mmol!==b.high_alert_mmol ||
           a.units!==b.units;
  }

  /* ----------------- Motor BMP 1-bit ----------------- */
  createBitmapCanvas(w,h){const bpr=Math.ceil(w/8);return new Uint8Array(bpr*h).fill(0);}
  setPixel(b,w,h,x,y,on=true){
    if(x<0||x>=w||y<0||y>=h) return;
    const bpr=Math.ceil(w/8), i=y*bpr+Math.floor(x/8), bit=7-(x%8);
    if(on) b[i]|=(1<<bit); else b[i]&=~(1<<bit);
  }
  drawLine(b,w,h,x1,y1,x2,y2){
    let dx=Math.abs(x2-x1), sx=x1<x2?1:-1;
    let dy=-Math.abs(y2-y1), sy=y1<y2?1:-1;
    let err=dx+dy;
    while(true){
      this.setPixel(b,w,h,x1,y1,true);
      if(x1===x2&&y1===y2) break;
      const e2=2*err;
      if(e2>=dy){err+=dy; x1+=sx;}
      if(e2<=dx){err+=dx; y1+=sy;}
    }
  }
  drawRect(b,w,h,x,y,W,H){
    this.drawLine(b,w,h,x,y,x+W,y);
    this.drawLine(b,w,h,x,y+H,x+W,y+H);
    this.drawLine(b,w,h,x,y,x,y+H);
    this.drawLine(b,w,h,x+W,y,x+W,y+H);
  }
  drawCircle(b,w,h,cx,cy,r){
    for(let x=-r;x<=r;x++) for(let y=-r;y<=r;y++)
      if(x*x+y*y<=r*r) this.setPixel(b,w,h,cx+x,cy+y,true);
  }

  /* ------- Fuente 5x7 compacta (subset útil) ------- */
  FONT5x7 = (()=>{const m={},d={
    "0":[30,33,35,37,41,49,30],"1":[0,33,63,1,0,0,0],"2":[35,37,41,41,41,41,49],
    "3":[34,65,73,73,73,73,54],"4":[12,20,36,36,63,4,4],"5":[114,81,81,81,81,81,78],
    "6":[30,41,73,73,73,73,6],"7":[64,71,72,80,96,64,64],"8":[54,73,73,73,73,73,54],
    "9":[48,73,73,73,73,74,60],"A":[63,72,72,72,72,72,63],"B":[63,73,73,73,73,73,54],
    "C":[30,33,65,65,65,65,34],"D":[63,65,65,65,65,34,28],"E":[63,73,73,73,73,65,65],
    "F":[63,72,72,72,72,64,64],"G":[30,33,65,73,73,47,14],"H":[63,8,8,8,8,8,63],
    "I":[0,65,65,63,65,65,0],"J":[2,1,1,1,1,62,0],"L":[63,1,1,1,1,1,1],
    "N":[63,32,16,8,4,2,63],"O":[30,33,65,65,65,33,30],
    "P":[63,72,72,72,72,48,0],"R":[63,72,76,74,73,49,0],
    "S":[50,73,73,73,73,73,38],"T":[64,64,64,63,64,64,64],
    "U":[62,1,1,1,1,1,62],"V":[60,2,1,1,1,2,60],
    "W":[62,1,6,24,6,1,62],"X":[34,20,8,8,20,34,0],
    "Y":[32,16,8,7,8,16,32],"Z":[35,37,41,49,33,33,33],
    " ":[0,0,0,0,0,0,0],":":[0,0,36,0,36,0,0],"/":[1,2,4,8,16,32,0],"-":[0,0,4,4,4,0,0],
    ".":[0,0,0,32,0,0,0],
    "m":[0,31,16,15,16,15,0],"g":[0,12,18,18,14,1,30],"d":[0,15,16,16,16,15,0],
    "h":[0,63,8,8,8,7,0],"a":[0,12,18,18,18,30,0],"c":[0,12,18,18,18,0,0],
    "e":[0,12,26,26,18,4,0],"s":[0,20,26,26,18,0,0],
    "(": [0,0,30,33,0,0,0], ")":[0,0,33,30,0,0,0],
    "↑":[4,6,5,28,5,6,4],"↓":[16,48,80,15,80,48,16],
    "→":[0,8,12,126,12,8,0],"↗":[0,6,5,120,0,0,0],"↘":[0,0,0,120,5,6,0],
    "⇈":[4,6,5,28,5,6,4],"⇊":[16,48,80,15,80,48,16]
     "o": [0,12,18,18,18,12,0],
     "l": [0,8,8,8,8,8,0],
  }; Object.keys(d).forEach(k=>m[k]=d[k]); return m; })();

  drawChar5x7(b,w,h,x,y,ch,scale=1){
    const g=this.FONT5x7[ch]||this.FONT5x7[" "];
    for(let r=0;r<7;r++){
      const row=g[r]||0;
      for(let c=0;c<5;c++){
        const on=(row>>(4-c))&1;
        if(on) for(let dy=0;dy<scale;dy++) for(let dx=0;dx<scale;dx++)
          this.setPixel(b,w,h,x+c*scale+dx,y+r*scale+dy,true);
      }
    }
    return 5*scale;
  }
  drawString5x7(b,w,h,x,y,txt,scale=1,ls=1){
    let cur=x; for(const ch of String(txt)){ cur+=this.drawChar5x7(b,w,h,cur,y,ch,scale)+ls; } return cur-x;
  }
 bitmapToBase64(bitmap, w, h) {
  // 1-bit BMP con paleta (2 colores). Fondo = blanco (idx 0), trazos = negro (idx 1)
  const bytesPerRowNoPad = Math.ceil(w / 8);
  const rowSize = Math.ceil(w / 32) * 4;           // filas alineadas a 4 bytes
  const imageSize = rowSize * h;
  const headerSize = 14 + 40 + 8;                  // File(14) + Info(40) + Palette(8)
  const fileSize = headerSize + imageSize;

  const buf = new Uint8Array(fileSize);
  const dv = new DataView(buf.buffer);

  // --- BITMAPFILEHEADER ---
  buf[0] = 0x42; // 'B'
  buf[1] = 0x4D; // 'M'
  dv.setUint32(2, fileSize, true);                 // bfSize
  dv.setUint32(10, headerSize, true);              // bfOffBits

  // --- BITMAPINFOHEADER ---
  dv.setUint32(14, 40, true);                      // biSize
  dv.setInt32(18, w, true);                        // biWidth
  dv.setInt32(22, h, true);                        // biHeight (positivo = bottom-up)
  dv.setUint16(26, 1, true);                       // biPlanes
  dv.setUint16(28, 1, true);                       // biBitCount = 1
  dv.setUint32(30, 0, true);                       // biCompression = BI_RGB
  dv.setUint32(34, imageSize, true);               // biSizeImage
  dv.setInt32(38, 2835, true);                     // biXPelsPerMeter (~72 DPI)
  dv.setInt32(42, 2835, true);                     // biYPelsPerMeter
  dv.setUint32(46, 2, true);                       // biClrUsed = 2
  dv.setUint32(50, 2, true);                       // biClrImportant = 2

  // --- Palette (2 entradas RGBQUAD: B,G,R,0) ---
  // idx 0 = blanco
  buf[54] = 0xFF; buf[55] = 0xFF; buf[56] = 0xFF; buf[57] = 0x00;
  // idx 1 = negro
  buf[58] = 0x00; buf[59] = 0x00; buf[60] = 0x00; buf[61] = 0x00;

  // --- Datos de imagen (bottom-up) con padding por fila ---
  for (let y = 0; y < h; y++) {
    const src = y * bytesPerRowNoPad;
    const dst = headerSize + (h - 1 - y) * rowSize;
    buf.set(bitmap.subarray(src, src + bytesPerRowNoPad), dst);
    // el padding queda a 0 (blanco)
  }

  return Buffer.from(buf.buffer).toString("base64");
}

  /* ---------------- Sparkline ---------------- */
  downsample(points,maxPoints){
    if(!points||points.length<=maxPoints) return points||[];
    const out=[], step=(points.length-1)/(maxPoints-1);
    for(let i=0;i<maxPoints;i++) out.push(points[Math.round(i*step)]);
    return out;
  }
  drawAlertZones(b,w,h,rect,limits,min,max){
    const {x,y,W,H}=rect, range=max-min||1;
    if(limits.low>min){
      const lowY=y+H-Math.round(((limits.low-min)/range)*H);
      for(let yy=lowY; yy<y+H; yy+=3) for(let xx=x; xx<x+W; xx+=6) this.setPixel(b,w,h,xx,yy,true);
    }
    if(limits.high<max){
      const highY=y+H-Math.round(((limits.high-min)/range)*H);
      for(let yy=y; yy<highY; yy+=3) for(let xx=x; xx<x+W; xx+=6) this.setPixel(b,w,h,xx,yy,true);
    }
  }
  generateSparklineInto(bitmap, history, settings){
    const w=BMP_WIDTH,h=BMP_HEIGHT;
    const sx=LAYOUT.spark.x, sy=LAYOUT.spark.y, sw=LAYOUT.spark.width, sh=LAYOUT.spark.height;

    const pts = this.downsample((history||[]).map(p=>({sgv:p.sgv})), 64);
    if(pts.length<2) return;

    const vals=pts.map(p=>p.sgv), min=Math.min(...vals), max=Math.max(...vals), range=max-min||1;

    this.drawRect(bitmap,w,h,sx,sy,sw-1,sh-1);
    const limits=this.getAlertLimits(settings);
    this.drawAlertZones(bitmap,w,h,{x:sx+1,y:sy+1,W:sw-2,H:sh-2},limits,min,max);

    const n=pts.length;
    for(let i=0;i<n-1;i++){
      const x1=sx+1+Math.round(i*(sw-3)/(n-1));
      const y1=sy+1+(sh-3)-Math.round(((pts[i].sgv-min)/range)*(sh-3));
      const x2=sx+1+Math.round((i+1)*(sw-3)/(n-1));
      const y2=sy+1+(sh-3)-Math.round(((pts[i+1].sgv-min)/range)*(sh-3));
      this.drawLine(bitmap,w,h,x1,y1,x2,y2);
    }
    const lastX=sx+1+Math.round((n-1)*(sw-3)/(n-1));
    const lastY=sy+1+(sh-3)-Math.round(((pts[n-1].sgv-min)/range)*(sh-3));
    this.drawCircle(bitmap,w,h,lastX,lastY,2);
  }

  /* --------------- Texto + utilidades --------------- */
  getTrendArrow(d){const m={'DoubleUp':'⇈','SingleUp':'↑','FortyFiveUp':'↗','Flat':'→','FortyFiveDown':'↘','SingleDown':'↓','DoubleDown':'⇊','NONE':'-','NOT COMPUTABLE':'→'}; return m[d]||'→';}
  convertToDisplay(mg,unit){return unit===UNITS.MMOL? (mg/18).toFixed(1) : Math.round(mg);}
  getLanguageSettings(s){return (s.language==='es')?{locale:'es-ES',timezone:'Europe/Madrid'}:{locale:'en-US',timezone:'America/New_York'};}
  validateTimezone(tz){const ok=['Europe/Madrid','Atlantic/Canary','Europe/London','Europe/Paris','Europe/Berlin','Europe/Rome','America/New_York','America/Chicago','America/Los_Angeles','America/Mexico_City','UTC']; return ok.includes(tz)?tz:'UTC';}

  async formatLines(reading, settings){
  const display=this.convertToDisplay(reading.sgv, settings.units);
  const trend=this.getTrendArrow(reading.direction);

  const lang = (settings.language==='es') ? 'es-ES' : 'en-US';
  const tz = settings.timezone || ((settings.language==='es') ? 'Europe/Madrid' : 'America/New_York');

  const hhmm = new Date(reading.date).toLocaleTimeString(lang, { timeZone: tz, hour:'2-digit', minute:'2-digit' });
  const mins = Math.max(0, Math.floor((Date.now()-reading.date)/60000));

  // Línea 1: valor + unidad + flecha  (todo soportado por la fuente)
  const line1 = `${display} ${settings.units} ${trend}`;

  // Línea 2: "HH:MM (Xm)"  -> solo dígitos, :, (, ), m   => todos soportados
  const line2 = `${hhmm} (${mins}m)`;

  return [line1, line2];
}

  generateCombinedBitmap(history, reading, settings){
    const b=this.createBitmapCanvas(BMP_WIDTH,BMP_HEIGHT);

    // Texto
    const [l1,l2] = (()=>{ // sync formatter
      const disp=this.convertToDisplay(reading.sgv, settings.units);
      const tr=this.getTrendArrow(reading.direction);
      const lang=this.getLanguageSettings(settings);
      const tz=settings.timezone?this.validateTimezone(settings.timezone):lang.timezone;
      const t=new Date(reading.date).toLocaleTimeString(lang.locale,{timeZone:tz,hour:'2-digit',minute:'2-digit'});
      const mins=Math.floor((Date.now()-reading.date)/60000);
      const ago=mins<=1?(settings.language==='es'?'ahora':'now'):(settings.language==='es'?`hace ${mins}m`:`${mins}m ago`);
      return [`${disp} ${settings.units} ${tr}`, `${t} (${ago})`];
    })();

    const s2=LAYOUT.text.scale;
    this.drawString5x7(b,BMP_WIDTH,BMP_HEIGHT,LAYOUT.text.x,LAYOUT.text.y,l1,s2,1);
    this.drawString5x7(b,BMP_WIDTH,BMP_HEIGHT,LAYOUT.text.x,LAYOUT.text.y+9*s2+6,l2,1,1);

    // Sparkline si hay historial suficiente
    if ((history||[]).length >= 2) this.generateSparklineInto(b, history, settings);

    return this.bitmapToBase64(b,BMP_WIDTH,BMP_HEIGHT);
  }

  /* --------------- Candado/Limpieza/Mostrar --------------- */
  setDisplayLock(sessionId, locked) { this.displayLocks.set(sessionId, !!locked); }
  isDisplayLocked(sessionId) { return !!this.displayLocks.get(sessionId); }
  clearCleanupTimer(sessionId) {
    const t = this.displayCleanupTimers.get(sessionId);
    if (t) { clearTimeout(t); this.displayCleanupTimers.delete(sessionId); }
  }
  async showWithAutoClear(session, sessionId, showFn, durationMs) {
    try {
      this.setDisplayLock(sessionId, true);
      this.clearCleanupTimer(sessionId);
      await showFn();
    } finally {
      const t = setTimeout(() => {
        this.showBlank(session, 220).catch(()=>{});
        this.setDisplayLock(sessionId, false);
        this.displayCleanupTimers.delete(sessionId);
      }, Math.max(0, (durationMs || 0) + 60));
      this.displayCleanupTimers.set(sessionId, t);
    }
  }
  async safeShowText(session, text, ms = 3000, sessionId = null) {
    const sid = sessionId || ([...this.sessions.entries()].find(([k,v]) => v.session === session)?.[0] || 'solo');
    try {
      await this.showWithAutoClear(session, sid, async () => {
        await session.layouts?.showTextWall?.(text, { durationMs: ms });
      }, ms);
    } catch (e) {
      console.error('[safeShowText]', e?.stack || e);
      this.setDisplayLock(sid, false);
    }
  }
  async safeShowBitmap(session, base64, ms = 3000, sessionId = null) {
    const sid = sessionId || ([...this.sessions.entries()].find(([k,v]) => v.session === session)?.[0] || 'solo');
    try {
      await this.showWithAutoClear(session, sid, async () => {
        await session.layouts?.showBitmapView?.(base64, { durationMs: ms });
      }, ms);
    } catch (e) {
      console.error('[safeShowBitmap]', e?.stack || e);
      this.setDisplayLock(sid, false);
    }
  }
  async showBlank(session, ms=220){
    try {
      const b=this.createBitmapCanvas(BMP_WIDTH,BMP_HEIGHT);
      const base64=this.bitmapToBase64(b,BMP_WIDTH,BMP_HEIGHT);
      await session.layouts?.showBitmapView?.(base64, { durationMs: ms });
    } catch(_) {}
  }

  /* -------------------- Settings -------------------- */
  async getUserSettings(session){
    try{
      const [
        url, token, updateInterval,
        lowMg, highMg, lowMmol, highMmol,
        alertsEnabled, language, timezone, units,
        enable_head_up_display, enable_sparkline_display,
        display_duration_ms, dashboard_duration_ms, alert_duration_ms
      ] = await Promise.all([
        session.settings.get('nightscout_url'),
        session.settings.get('nightscout_token'),
        session.settings.get('update_interval'),
        session.settings.get('low_alert_mg'),
        session.settings.get('high_alert_mg'),
        session.settings.get('low_alert_mmol'),
        session.settings.get('high_alert_mmol'),
        session.settings.get('alerts_enabled'),
        session.settings.get('language'),
        session.settings.get('timezone'),
        session.settings.get('units'),
        session.settings.get('enable_head_up_display'),
        session.settings.get('enable_sparkline_display'),
        session.settings.get('display_duration_ms'),
        session.settings.get('dashboard_duration_ms'),
        session.settings.get('alert_duration_ms'),
      ]);

      const res = {
        nightscoutUrl: String(url||'').trim(),
        nightscoutToken: String(token||'').trim(),
        updateInterval: this.parseSlicerValue(updateInterval, 5),
        low_alert_mg: this.validateSlicerValue(lowMg, 40, 90, 70),
        high_alert_mg: this.validateSlicerValue(highMg, 180, 400, 250),
        low_alert_mmol: this.validateSlicerValue(lowMmol, 2, 5, 3.9),
        high_alert_mmol: this.validateSlicerValue(highMmol, 8, 30, 13.9),
        alertsEnabled: this.toBool(alertsEnabled),
        language: language || 'es',
        timezone: timezone || null,
        units: units || UNITS.MGDL,
        enable_head_up_display: this.toBool(enable_head_up_display),
        enable_sparkline_display: this.toBool(enable_sparkline_display),
        display_duration_ms: this.validateSlicerValue(display_duration_ms, 1000, 30000, 5000),
        dashboard_duration_ms: this.validateSlicerValue(dashboard_duration_ms, 1000, 30000, 10000),
        alert_duration_ms: this.validateSlicerValue(alert_duration_ms, 5000, 60000, 15000),
      };

      // Sincroniza límites entre unidades
      try {
        if (res.units===UNITS.MMOL){
          const mgL=this.syncFromMmolToMg(res.low_alert_mmol);
          const mgH=this.syncFromMmolToMg(res.high_alert_mmol);
          if (this.isDifferent(res.low_alert_mg,mgL)||this.isDifferent(res.high_alert_mg,mgH)){
            await session.settings.set('low_alert_mg', mgL);
            await session.settings.set('high_alert_mg', mgH);
            res.low_alert_mg=mgL; res.high_alert_mg=mgH;
          }
        } else {
          const mmolL=this.syncFromMgToMmol(res.low_alert_mg);
          const mmolH=this.syncFromMgToMmol(res.high_alert_mg);
          if (this.isDifferent(res.low_alert_mmol,mmolL)||this.isDifferent(res.high_alert_mmol,mmolH)){
            await session.settings.set('low_alert_mmol', mmolL);
            await session.settings.set('high_alert_mmol', mmolH);
            res.low_alert_mmol=mmolL; res.high_alert_mmol=mmolH;
          }
        }
      } catch(e){ session.logger?.debug?.('sync fail', {e:e?.message}); }

      return res;
    }catch(e){
      console.error('getUserSettings error', e?.stack||e);
      return {
        nightscoutUrl:'', nightscoutToken:'',
        updateInterval:5, low_alert_mg:70, high_alert_mg:250,
        low_alert_mmol:3.9, high_alert_mmol:13.9,
        alertsEnabled:true, language:'es', timezone:null, units:UNITS.MGDL,
        enable_head_up_display:false, enable_sparkline_display:false,
        display_duration_ms:5000, dashboard_duration_ms:10000, alert_duration_ms:15000
      };
    }
  }

  parseSettingsFromArray(arr){
    const o={}; (arr||[]).forEach(s=>o[s.key]=s.value);
    return {
      nightscoutUrl: String(o.nightscout_url||'').trim(),
      nightscoutToken: String(o.nightscout_token||'').trim(),
      updateInterval: this.parseSlicerValue(o.update_interval,5),
      low_alert_mg: this.validateSlicerValue(o.low_alert_mg,40,90,70),
      high_alert_mg: this.validateSlicerValue(o.high_alert_mg,180,400,250),
      low_alert_mmol: this.validateSlicerValue(o.low_alert_mmol,2,5,3.9),
      high_alert_mmol: this.validateSlicerValue(o.high_alert_mmol,8,30,13.9),
      alertsEnabled: this.toBool(o.alerts_enabled),
      language: o.language||'es',
      timezone: o.timezone||null,
      units: o.units||UNITS.MGDL,
      enable_head_up_display: this.toBool(o.enable_head_up_display),
      enable_sparkline_display: this.toBool(o.enable_sparkline_display),
      display_duration_ms:this.validateSlicerValue(o.display_duration_ms,1000,30000,5000),
      dashboard_duration_ms:this.validateSlicerValue(o.dashboard_duration_ms,1000,30000,10000),
      alert_duration_ms:this.validateSlicerValue(o.alert_duration_ms,5000,60000,15000)
    };
  }

  /* ----------------- Data Nightscout ----------------- */
  async getGlucoseData(s, count=1){
    let u=s.nightscoutUrl; if(!u) throw new Error('URL no configurada');
    if(!u.startsWith('http')) u='https://'+u;
    u=u.replace(/\/$/,'');
    const endpoints=[
      `${u}/api/v1/entries/sgv.json?count=${count}`,
      `${u}/api/v1/entries.json?count=${count}`,
      count===1?`${u}/api/v1/entries/current.json`:null
    ].filter(Boolean);
    let lastErr;
    for(const ep of endpoints){
      try{
        const params=s.nightscoutToken?{token:s.nightscoutToken}:{};
        const {data}=await axios.get(ep,{params,timeout:10000,headers:{'User-Agent':'MentraOS-Nightscout/2.10.4'}});
        const arr=Array.isArray(data)?data:(data?[data]:[]);
        if(arr.length===0) throw new Error('Empty response');
        return arr.map(r=>({ sgv:Number(r.sgv??r.glucose), date:typeof r.date==='string'?new Date(r.date).getTime():r.date, direction:r.direction||r.trend||'NONE' }))
                  .filter(r=>Number.isFinite(r.sgv)&&r.date);
      }catch(e){ lastErr=e; continue; }
    }
    throw new Error(`All endpoints failed. Last error: ${lastErr?.message||'unknown'}`);
  }

  /* ----------------- Gestión historial ----------------- */
  addToGlucoseHistory(sessionId, r){
    if(!this.glucoseHistory.has(sessionId)) this.glucoseHistory.set(sessionId,[]);
    const h=this.glucoseHistory.get(sessionId); h.push({sgv:r.sgv,date:r.date});
    if(h.length>120) h.splice(0,h.length-120);
  }
  async preloadHistory(sessionId, s, points=24){
    try{ const arr=await this.getGlucoseData(s,points); arr.reverse().forEach(r=>this.addToGlucoseHistory(sessionId,r)); }
    catch(e){ this.sessions.get(sessionId)?.session?.logger?.debug?.('preload fail',{e:e?.message}); }
  }

  /* ----------------- Pantallas / errores ----------------- */
  handleDisplayError(session, error, settings, duration, isAlert=false){
    const msg =
      error.message.includes('URL no configurada') ? {es:'URL de Nightscout no configurada\nRevisa ajustes',en:'Nightscout URL not set\nCheck settings'} :
      (error.message.includes('Empty')||error.message.includes('Sin datos')) ? {es:'No hay datos de glucosa\nRevisa ajustes',en:'No glucose data available\nCheck settings'} :
      (error.message.includes('timeout')||error.code==='ECONNABORTED'||error.message.includes('connect')||error.message.includes('ECONNREFUSED')) ? {es:'No se puede conectar\nRevisa URL/token',en:'Cannot connect\nCheck URL/token'} :
      (error.message.includes('401')||error.message.includes('403')||error.message.includes('Auth')) ? {es:'Token o permisos inválidos\nRevisa ajustes',en:'Invalid token or permissions\nCheck settings'} :
      {es:'Error cargando datos\nRevisa configuración',en:'Error loading data\nCheck configuration'};
    const sid = [...this.sessions.entries()].find(([k,v])=>v.session===session)?.[0];
    this.safeShowText(session, msg[settings.language]||msg.en, duration, sid);
    session.logger?.error(error, isAlert?'alert display fail':'display fail');
  }

  async showGlucoseDisplay(session, sessionId, settings, opts={}){
    const { duration=null, isAlert=false, mode='auto' } = opts;
    const ms = duration || (isAlert ? settings.alert_duration_ms : settings.display_duration_ms);
    try{
      const r=(await this.getGlucoseData(settings,1))[0];
      this.addToGlucoseHistory(sessionId,r);
      const hist=this.glucoseHistory.get(sessionId)||[];

      if(!isAlert && settings.enable_sparkline_display && hist.length>=MIN_HISTORY_FOR_SPARKLINE && mode!=='textOnly'){
        try{
          const bmp=this.generateCombinedBitmap(hist,r,settings);
          await this.safeShowBitmap(session,bmp,ms,sessionId);
          return;
        }catch(e){ console.warn('combined fail, fallback text', e?.message); }
      }

      const [l1,l2]=await this.formatLines(r,settings);
      await this.safeShowText(session, `${l1}\n${l2}`, ms, sessionId);
    }catch(e){
      this.handleDisplayError(session,e,settings,ms,false);
    }
  }

  /* ----------------- Arranque sesión ----------------- */
  async showInitialAndStart(session, sessionId, userId){
    let s=null;
    try{ s=await this.getUserSettings(session); }catch(e){ console.error('settings read fail',e); }
    if(!s?.nightscoutUrl){
      await this.safeShowText(session,'URL de Nightscout no configurada\nAbre Ajustes',3500,sessionId); return;
    }
    if(!s?.nightscoutToken){
      await this.safeShowText(session,'Token no configurado\nAbre Ajustes',3500,sessionId); return;
    }
    try{ await this.getGlucoseData(s,1); }
    catch(e){
      await this.safeShowText(session, s.language==='es'?'No se pueden cargar datos\nRevisa URL/token/red':'Cannot load data\nCheck URL/token/network', 4000, sessionId);
      // seguimos igualmente
    }
    this.sessions.set(sessionId,{session,userId,settings:s,updateInterval:null});
    await this.preloadHistory(sessionId,s,24);
    this.setupEventHandlers(session,sessionId);

    // 👇 NO mostramos nada al iniciar (gesto/botón deciden)
    this.startNormalOperation(session,sessionId,s);
  }

  /* ----------------- onSession ----------------- */
  async onSession(session, sessionId, userId){
    console.log(`🚀 Nueva sesión: ${sessionId} para ${userId}`);
    try{
      if(typeof session.updateSettingsForTesting!=='function'){
        session.updateSettingsForTesting=async()=>{session.logger?.debug?.('compat noop');};
      }
      await this.showInitialAndStart(session,sessionId,userId);
    }catch(e){
      console.error('onSession failed:', e?.stack||e);
      await this.safeShowText(session,'Startup error.\nOpen settings.',3000,sessionId);
    }
  }

  /* ----------------- Event handlers ----------------- */
  setupEventHandlers(session, sessionId){
    try{
      // Botón manual → muestra display centralizado (aunque HUD esté OFF)
      session.events?.onButtonPress?.(async ()=>{
        const sd=this.sessions.get(sessionId); if(!sd) return;
        if (this.isDisplayLocked(sessionId)) return;
        await this.showGlucoseDisplay(session,sessionId,sd.settings,{mode:'auto'});
      });

      const handler = async (settingsData)=>{
        try{
          const parsed=this.parseSettingsFromArray(settingsData||[]);
          const sd=this.sessions.get(sessionId); if(!sd) return;
          const old=sd.settings; sd.settings=parsed; this.sessions.set(sessionId,sd);

          // Si el usuario desactiva el HUD en ajustes, ocultamos cualquier vista activa
          if (old.enable_head_up_display && !parsed.enable_head_up_display) {
            this.showBlank(session, 220).catch(()=>{});
            this.setDisplayLock(sessionId, false);
          }

          if(old.updateInterval!==parsed.updateInterval){ this.stopNormalOperation(sessionId); this.startNormalOperation(session,sessionId,parsed); }
          if(this.alertLimitsChanged(old,parsed)){ this.alertHistory.delete(sessionId); }

          await this.persistAndEchoSettings(session, parsed);
        }catch(e){ session.logger?.error(e,'settings handler fail'); }
      };

      session.events?.onAppSettingsUpdate?.(handler);
      session.events?.onSettingsUpdate?.(handler);
      session.events?.onSettingsChange?.(handler);

      // Gesto cabeza arriba→abajo (controla TODO el display)
      session.events?.onHeadPosition?.(async ({position})=>{
        try{
          if(position!=='up' && position!=='down') return;

          // Respeta estrictamente el toggle de HUD
          const sd=this.sessions.get(sessionId); const s=sd?.settings;
          if(!s || !this.toBool(s.enable_head_up_display)) return;

          // Secuencia up->down dentro de ventana
          const now=Date.now();
          if(position==='up'){ this.lastHeadUp.set(sessionId, now); return; }
          const lastUp=this.lastHeadUp.get(sessionId)||0;
          if(now - lastUp > s.display_duration_ms/2) return; // ventana de gesto

          // Cooldown para no spamear
          const lastShown=this.headUpLastShown.get(sessionId)||0;
          if(now - lastShown < 5000) return;
          this.headUpLastShown.set(sessionId, now);

          if (this.isDisplayLocked(sessionId)) return; // no pisar otra vista

          // Mostrar usando la función centralizada
          await this.showGlucoseDisplay(session, sessionId, s, { duration: s.display_duration_ms, isAlert: false, mode: 'auto' });
        }catch(e){
          session.logger?.error(e,'head-up fail');
          await this.safeShowText(session,'Error',2000,sessionId);
        }
      });

      session.events?.onDisconnected?.(()=>{
        this.stopNormalOperation(sessionId);
        this.sessions.delete(sessionId);
        this.alertHistory.delete(sessionId);
        this.glucoseHistory.delete(sessionId);
        this.clearCleanupTimer(sessionId);
        this.displayLocks.delete(sessionId);
      });
    }catch(e){ console.error('setupEventHandlers fail', e?.stack||e); }
  }

  async persistAndEchoSettings(session, s){
    try{
      await Promise.all([
        session.settings.set('low_alert_mg', s.low_alert_mg),
        session.settings.set('high_alert_mg', s.high_alert_mg),
        session.settings.set('low_alert_mmol', s.low_alert_mmol),
        session.settings.set('high_alert_mmol', s.high_alert_mmol),
        session.settings.set('update_interval', s.updateInterval),
        session.settings.set('alerts_enabled', !!s.alertsEnabled),
        session.settings.set('units', s.units),
        session.settings.set('language', s.language),
        session.settings.set('timezone', s.timezone||''),
        session.settings.set('enable_head_up_display', !!s.enable_head_up_display),
        session.settings.set('enable_sparkline_display', !!s.enable_sparkline_display),
        session.settings.set('display_duration_ms', s.display_duration_ms),
        session.settings.set('dashboard_duration_ms', s.dashboard_duration_ms),
        session.settings.set('alert_duration_ms', s.alert_duration_ms),
      ]);

      const lines=['Ajustes guardados'];
      if(s.units===UNITS.MMOL){ lines.push(`Low: ${s.low_alert_mmol} mmol/L`, `High: ${s.high_alert_mmol} mmol/L`); }
      else { lines.push(`Low: ${s.low_alert_mg} mg/dL`, `High: ${s.high_alert_mg} mg/dL`); }
      lines.push(`Units: ${s.units}`);
      lines.push(`HeadUp: ${this.toBool(s.enable_head_up_display)?'ON':'OFF'}`);
      lines.push(`Sparkline: ${this.toBool(s.enable_sparkline_display)?'ON':'OFF'}`);

      // Pausa ciclo, eco y (si HUD se apagó) limpiar
      let sid=null; for(const [k,v] of this.sessions){ if(v.session===session){ sid=k; break; } }
      if(sid) this.stopNormalOperation(sid);

      await this.safeShowText(session, `\n${lines.join('\n')}`, 5000, sid);

      if(sid){
        const sd=this.sessions.get(sid);
        if(sd) this.startNormalOperation(sd.session, sid, sd.settings);
      }
    }catch(e){ session.logger?.debug('persist echo fail',{e:e?.message}); }
  }

  /* ----------------- Bucle normal (SOLO datos/alertas) ----------------- */
  startNormalOperation(session, sessionId, s){
    this.stopNormalOperation(sessionId);
    const ms=(s.updateInterval||5)*60*1000;
    const iv=setInterval(async()=>{
      try{
        const sd=this.sessions.get(sessionId); if(!sd) return clearInterval(iv);
        // SOLO obtención de datos + alertas; NUNCA mostrar aquí
        const d=await this.getGlucoseData(sd.settings,1);
        if(d&&d[0]){
          this.addToGlucoseHistory(sessionId,d[0]);
          if(sd.settings.alertsEnabled) await this.checkAlerts(session, sessionId, d[0], sd.settings);
        }
      }catch(e){ session.logger?.debug('cycle fail',{e:e?.message}); }
    }, ms);
    const sd=this.sessions.get(sessionId); if(sd){ sd.updateInterval=iv; this.sessions.set(sessionId,sd); }
  }
  stopNormalOperation(sessionId){ const sd=this.sessions.get(sessionId); if(sd?.updateInterval){ clearInterval(sd.updateInterval); sd.updateInterval=null; } }

  /* ----------------- Alertas ----------------- */
  async checkAlerts(session, sessionId, data, s){
    const lim=this.getAlertLimits(s), mg=data.sgv;
    const last=this.alertHistory.get(sessionId);
    if(last && Date.now()-last<600000) return; // 10m
    let title=null; if(mg<=lim.low) title=s.language==='es'?'¡GLUCOSA BAJA!':'LOW GLUCOSE!';
    else if(mg>=lim.high) title=s.language==='es'?'¡GLUCOSA ALTA!':'HIGH GLUCOSE!';
    if(!title) return;
    const disp=this.convertToDisplay(mg,s.units);
    await this.safeShowText(session, `${title}\n${disp} ${s.units}`, s.alert_duration_ms, sessionId);
    this.alertHistory.set(sessionId, Date.now());
  }

  /* ----------------- Tool calls (opcional) ----------------- */
  async onToolCall(){ return {success:false,error:'Not implemented in this build'}; }
}
/* ===================== init ===================== */
const server = new NightscoutMentraApp({ packageName: PACKAGE_NAME, apiKey: MENTRAOS_API_KEY, port: PORT });
server.start().catch(err=>{ console.error('❌ start fail:',err); process.exit(1); });

console.log('🚀 Nightscout MentraOS v2.10.4-gesture-only — listo (display solo por gesto/botón)');

const KEEP_ALIVE_URL = process.env.RENDER_URL || 'https://mentra-nightscout.onrender.com';
server.app.get('/health', (_,res)=>res.json({status:'alive',ts:new Date().toISOString(),ver:'2.10.4-gesture-only',sessions:server.sessions.size}));
setInterval(()=>axios.get(`${KEEP_ALIVE_URL}/health`).catch(()=>{}), 180000);

module.exports = server;
