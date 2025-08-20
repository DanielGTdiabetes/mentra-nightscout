"use strict";

/**
 * Módulo de bitmaps para Mentra G1B
 * - Lee BMPs 8/24/32bpp desde /assets/bitmaps
 * - Valida cabecera "BM" (0x424d)
 * - Ajusta ancho a 576 px si hace falta (padding a derecha)
 * - Devuelve buffers listos para pasar a la función de pintado del SDK
 *
 * Logs esperados (los mismos que vimos cuando funcionaba):
 *  [bitmaps] alert-high-526x100.bmp: head=424dce1a, bytes=6862
 *  [bitmaps] ... cargados y validados
 *  Adding padding to BMP since it isn't 576
 */

const fs = require("fs");
const path = require("path");

// Carpeta por defecto de bitmaps (puedes cambiarla por ENV si quieres)
const DEFAULT_DIR = path.join(process.cwd(), "assets", "bitmaps");

// Anchura “óptima” para G1B (HUD ancho). Si tu app usa otra, ajusta aquí.
const TARGET_WIDTH = 576;

// Cabecera BMP siempre empieza por 'BM' (0x42, 0x4D)
function isBMP(buffer) {
  return buffer && buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4D;
}

function readUInt32LE(buf, off) {
  return buf.readUInt32LE(off);
}
function readInt32LE(buf, off) {
  return buf.readInt32LE(off);
}
function readUInt16LE(buf, off) {
  return buf.readUInt16LE(off);
}

function parseBmpHeader(buffer) {
  // Referencia rápida de offsets BMP
  // File header:  0x00 "BM" (2) | 0x02 size(4) | 0x0A pixelOffset(4)
  // DIB header:   0x0E headerSize(4) => BITMAPINFOHEADER suele ser 40
  //               0x12 width(4) | 0x16 height(4) | 0x1A planes(2) | 0x1C bpp(2)
  //               0x1E compression(4) (0 = BI_RGB)
  if (!isBMP(buffer)) {
    throw new Error("No es un BMP válido (falta firma BM).");
  }

  const fileSize = readUInt32LE(buffer, 0x02);
  const pixelOffset = readUInt32LE(buffer, 0x0A);
  const dibHeaderSize = readUInt32LE(buffer, 0x0E);

  if (dibHeaderSize < 40) {
    throw new Error("DIB header inesperado (<40 bytes).");
  }

  const width = readInt32LE(buffer, 0x12);
  const height = readInt32LE(buffer, 0x16);
  const planes = readUInt16LE(buffer, 0x1A);
  const bpp = readUInt16LE(buffer, 0x1C);
  const compression = readUInt32LE(buffer, 0x1E);

  return {
    fileSize,
    pixelOffset,
    dibHeaderSize,
    width,
    height,
    planes,
    bpp,
    compression,
  };
}

/**
 * Normaliza un BMP al ancho TARGET_WIDTH (576) añadiendo padding a la derecha.
 * Mantiene el mismo alto y el mismo formato (24bpp o 32bpp).
 * Sólo manipula la zona de píxeles, preservando cabeceras.
 */
function ensureWidth(buffer, header, targetWidth = TARGET_WIDTH) {
  const { pixelOffset, width, height, bpp, compression } = header;

  // Sólo soportamos sin compresión (BI_RGB)
  if (compression !== 0) {
    throw new Error("BMP con compresión no soportado (compression != 0).");
  }

  if (width === targetWidth) {
    // Nada que hacer
    return buffer;
  }

  // Sólo soportamos 24 o 32 bits por píxel (8 opcional más abajo)
  if (![24, 32, 8].includes(bpp)) {
    throw new Error(`bpp no soportado: ${bpp}. Usa 8, 24 o 32 bpp.`);
  }

  console.log("Adding padding to BMP since it isn't 576");

  const bytesPerPixel = bpp / 8;

  // Cada fila de pixels en BMP está alineada a múltiplos de 4 bytes
  const srcRowSizeAligned = Math.ceil((width * bytesPerPixel) / 4) * 4;
  const dstRowSizeAligned = Math.ceil((targetWidth * bytesPerPixel) / 4) * 4;

  const src = buffer.subarray(pixelOffset);
  const dstPixels = Buffer.alloc(dstRowSizeAligned * Math.abs(height), 0x00);

  // BMP suele estar en orden de filas invertidas (bottom-up) si height>0
  const rows = Math.abs(height);
  for (let r = 0; r < rows; r++) {
    const srcRowStart = r * srcRowSizeAligned;
    const dstRowStart = r * dstRowSizeAligned;

    const copyBytes = Math.min(srcRowSizeAligned, dstRowSizeAligned);
    src.copy(dstPixels, dstRowStart, srcRowStart, srcRowStart + copyBytes);
    // El resto queda en 0 (padding a la derecha)
  }

  // Rehacer cabecera con nuevo width y tamaños
  const out = Buffer.alloc(pixelOffset + dstPixels.length);
  buffer.copy(out, 0, 0, pixelOffset); // copio cabeceras

  // width (4 bytes LE) en 0x12
  out.writeInt32LE(targetWidth, 0x12);

  // image size: podemos escribir 0 (BI_RGB) o el tamaño real
  const biSizeImage = dstPixels.length;
  out.writeUInt32LE(biSizeImage, 0x22);

  // file size en 0x02
  out.writeUInt32LE(out.length, 0x02);

  // pixel offset se mantiene
  dstPixels.copy(out, pixelOffset);

  return out;
}

function loadSingleBmp(absPath) {
  const buf = fs.readFileSync(absPath);
  if (!isBMP(buf)) {
    throw new Error("Archivo no es BMP válido.");
  }
  const headHex = buf.slice(0, 4).toString("hex"); // para log igual al que viste
  const stats = fs.statSync(absPath);
  console.log(`[bitmaps] ${path.basename(absPath)}: head=${headHex}, bytes=${stats.size}`);

  const header = parseBmpHeader(buf);
  const normalized = ensureWidth(buf, header, TARGET_WIDTH);
  return normalized;
}

function loadBitmapsFromDir(dir = DEFAULT_DIR) {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const result = {};

  for (const f of entries) {
    if (!f.toLowerCase().endsWith(".bmp")) continue;
    const abs = path.join(dir, f);
    try {
      const bmp = loadSingleBmp(abs);
      // Clave sin extensión: p.ej. "alert-high-526x100"
      const key = path.basename(f, path.extname(f));
      result[key] = bmp;
    } catch (err) {
      console.warn(`[bitmaps] WARNING: ${f} ignorado: ${err.message}`);
    }
  }

  const keys = Object.keys(result);
  if (keys.length > 0) {
    console.log("[bitmaps] cargados y validados");
  } else {
    console.log("[bitmaps] (vacío) no se encontraron BMP válidos en", dir);
  }
  return result;
}

module.exports = {
  loadBitmapsFromDir,
  parseBmpHeader,
  ensureWidth,
  TARGET_WIDTH,
};
