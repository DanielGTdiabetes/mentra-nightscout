"use strict";

/**
 * Cargador de bitmaps para MentraOS (G1B)
 * - Lee PNGs desde /assets/bitmaps
 * - Devuelve { dataRGBA, width, height } para session.layouts.showBitmap(...)
 *
 * Requiere: npm i pngjs
 *
 * Claves expuestas:
 *  - 'alert-low-526x100'  -> assets/bitmaps/alert-low-526x100.png
 *  - 'alert-high-526x100' -> assets/bitmaps/alert-high-526x100.png
 */

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

// Mapa clave->archivo (puedes cambiar a .bmp si más tarde usas 'bmp-js')
const BITMAP_FILES = {
  "alert-low-526x100":  "alert-low-526x100.png",
  "alert-high-526x100": "alert-high-526x100.png",
};

// Cache en memoria
const _cache = new Map();
let _loaded = false;

function loadPNGFull(filePath) {
  const buf = fs.readFileSync(filePath);
  const png = PNG.sync.read(buf); // { width, height, data<RGBA> }
  if (!png || !png.data || !png.width || !png.height) {
    throw new Error("PNG invalido: " + filePath);
  }
  return {
    dataRGBA: png.data,           // Uint8Array RGBA
    width: png.width,
    height: png.height,
  };
}

function assetsDir() {
  // Ruta relativa a este archivo: ../assets/bitmaps
  return path.join(__dirname, "..", "assets", "bitmaps");
}

function loadAllBitmaps() {
  if (_loaded) return;
  const base = assetsDir();
  for (const [key, filename] of Object.entries(BITMAP_FILES)) {
    const full = path.join(base, filename);
    if (!fs.existsSync(full)) {
      // No abortamos: simplemente no estará disponible ese bitmap
      continue;
    }
    try {
      const bmp = loadPNGFull(full);
      _cache.set(key, bmp);
    } catch (err) {
      // Si un archivo falla, lo saltamos
      // console.error("No se pudo cargar", filename, err.message);
    }
  }
  _loaded = true;
}

function hasBitmap(key) {
  if (!_loaded) loadAllBitmaps();
  return _cache.has(key);
}

function getBitmap(key) {
  if (!_loaded) loadAllBitmaps();
  return _cache.get(key) || null;
}

module.exports = {
  loadAllBitmaps,
  hasBitmap,
  getBitmap,
};
