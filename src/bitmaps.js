"use strict";
/**
 * bitmaps.js — Cargador y gestor de BMPs 1bpp/8bpp para G1B (576x100).
 * - Carga desde assets/bitmaps/*.bmp
 * - Normaliza ancho=576 px (padding o recorte centrado), alto=100 px (centrado vertical si >100)
 * - Cache en memoria por nombre lógico
 * - API minimalista: loadAll(), get(name), has(name)
 *
 * NOTA: Este módulo NO conoce @mentra/sdk. Solo prepara buffers listos para showBitmap()
 *       Si showBitmap() no está disponible, el llamador debe hacer fallback a texto.
 */

const fs = require("fs");
const path = require("path");

/** Ruta base de bitmaps en el proyecto */
const BITMAPS_DIR = path.join(__dirname, "..", "assets", "bitmaps");

/** Nombres lógicos permitidos (ignoramos weather-*) */
const ALLOWED = new Set([
  "alert-low-526x100.bmp",
  "alert-high-526x100.bmp",
  "alert-bell-526x100.bmp",
  "arrow-up-526x100.bmp",
  "arrow-down-526x100.bmp"
]);

/**
 * Lee un BMP y devuelve un objeto { width, height, dataRGBA }
 * Acepta BMP de 24bpp/32bpp. Si otra profundidad → lanza error.
 */
function readBmpToRgba(fullPath) {
  const buf = fs.readFileSync(fullPath);
  // Cabecera BMP mínima
  if (buf.readUInt16LE(0) !== 0x4D42) throw new Error("No es BMP");
  const offBits = buf.readUInt32LE(10);
  const dibSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const planes = buf.readUInt16LE(26);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);

  if (planes !== 1) throw new Error("Planes != 1");
  if (![24, 32].includes(bpp)) throw new Error(`BPP no soportado: ${bpp}`);
  if (compression !== 0) throw new Error("BMP comprimido no soportado");

  const rowStride = Math.floor((bpp * width + 31) / 32) * 4;
  const rgba = Buffer.alloc(width * Math.abs(height) * 4);

  const isBottomUp = height > 0;
  const absH = Math.abs(height);

  for (let y = 0; y < absH; y++) {
    const srcY = isBottomUp ? (absH - 1 - y) : y;
    const rowStart = offBits + srcY * rowStride;
    for (let x = 0; x < width; x++) {
      const src = rowStart + x * (bpp / 8);
      const dst = (y * width + x) * 4;
      // BMP: BGR(A)
      const B = buf[src + 0];
      const G = buf[src + 1];
      const R = buf[src + 2];
      const A = (bpp === 32) ? buf[src + 3] : 255;
      rgba[dst + 0] = R;
      rgba[dst + 1] = G;
      rgba[dst + 2] = B;
      rgba[dst + 3] = A;
    }
  }
  return { width, height: absH, dataRGBA: rgba };
}

/**
 * Normaliza a 576x100:
 * - Si width < 576: añade padding a izquierda/derecha (centrado)
 * - Si width > 576: recorta centrado
 * - Si height < 100: centra verticalmente con bandas
 * - Si height > 100: recorta centrado
 * Salida: { width: 576, height: 100, dataRGBA }
 */
function normalizeToG1B(img) {
  const TARGET_W = 576, TARGET_H = 100;
  const out = Buffer.alloc(TARGET_W * TARGET_H * 4, 0xFF); // blanco opaco
  const scaleW = Math.min(img.width, TARGET_W);
  const scaleH = Math.min(img.height, TARGET_H);

  const srcX0 = Math.max(0, Math.floor((img.width - scaleW) / 2));
  const srcY0 = Math.max(0, Math.floor((img.height - scaleH) / 2));
  const dstX0 = Math.max(0, Math.floor((TARGET_W - scaleW) / 2));
  const dstY0 = Math.max(0, Math.floor((TARGET_H - scaleH) / 2));

  for (let y = 0; y < scaleH; y++) {
    for (let x = 0; x < scaleW; x++) {
      const sIdx = ((y + srcY0) * img.width + (x + srcX0)) * 4;
      const dIdx = ((y + dstY0) * TARGET_W + (x + dstX0)) * 4;
      out[dIdx + 0] = img.dataRGBA[sIdx + 0];
      out[dIdx + 1] = img.dataRGBA[sIdx + 1];
      out[dIdx + 2] = img.dataRGBA[sIdx + 2];
      out[dIdx + 3] = img.dataRGBA[sIdx + 3];
    }
  }
  return { width: TARGET_W, height: TARGET_H, dataRGBA: out };
}

/** Cache interno */
const CACHE = new Map();

/** Carga todos los bitmaps permitidos en cache (los que existan) */
function loadAllBitmaps() {
  if (!fs.existsSync(BITMAPS_DIR)) return;
  const files = fs.readdirSync(BITMAPS_DIR);
  for (const f of files) {
    if (!ALLOWED.has(f)) continue; // ignorar weather-*
    const full = path.join(BITMAPS_DIR, f);
    try {
      const bmp = readBmpToRgba(full);
      const norm = normalizeToG1B(bmp);
      const key = path.basename(f, ".bmp"); // p.ej. "alert-low-526x100"
      CACHE.set(key, norm);
      // console.log(`[bitmaps] loaded ${key}`);
    } catch (e) {
      // console.warn(`[bitmaps] failed ${f}: ${e.message}`);
    }
  }
}

/** Devuelve {width,height,dataRGBA} o null */
function getBitmap(name) {
  return CACHE.get(name) || null;
}

function hasBitmap(name) {
  return CACHE.has(name);
}

module.exports = {
  loadAllBitmaps,
  getBitmap,
  hasBitmap,
  BITMAPS_DIR
};
