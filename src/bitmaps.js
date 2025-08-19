// src/bitmaps.js
// Carga BMPs desde assets/bitmaps y devuelve BASE64 (no hex).
// Valida cabecera BMP: "BM", 526x100, 1-bit, BI_RGB=0.

const path = require("path");
const fs = require("fs/promises");

// Tamaño esperado por Mentra BitmapView
const EXPECT_W = 526;
const EXPECT_H = 100;

function validateBmpBuffer(buf) {
  if (!buf || buf.length < 54) return { isValid: false, errors: ["BMP header too short"] };

  const sig = buf.toString("ascii", 0, 2);      // "BM"
  const dib = buf.readUInt32LE(14);
  const w   = buf.readInt32LE(18);
  const h   = buf.readInt32LE(22);
  const planes = buf.readUInt16LE(26);
  const bpp    = buf.readUInt16LE(28);
  const comp   = buf.readUInt32LE(30);          // 0 = BI_RGB (sin compresión)

  const ok = (sig === "BM" && dib >= 40 && w === EXPECT_W && h === EXPECT_H && planes === 1 && bpp === 1 && comp === 0);
  return ok
    ? { isValid: true, errors: [] }
    : { isValid: false, errors: [`sig=${sig} dib=${dib} size=${w}x${h} planes=${planes} bpp=${bpp} comp=${comp}`] };
}

async function loadOneBase64(base, name) {
  const abs = path.join(base, name);
  const buf = await fs.readFile(abs);

  // Validación fuerte en binario (antes de convertir)
  const v = validateBmpBuffer(buf);
  if (!v.isValid) throw new Error(`Bitmap inválido ${name}: ${v.errors.join(", ")}`);

  // Enviar como BASE64 (algunas versiones del SDK lo prefieren al HEX)
  const b64 = buf.toString("base64");

  // Log corto para depurar (no enorme)
  const headHex = buf.slice(0, 4).toString("hex"); // debería empezar por 424d....
  console.log(`[bitmaps] ${name}: head=${headHex}, bytes=${buf.length}`);

  return b64; // <- devolver base64
}

async function loadBitmaps() {
  // OJO: assets/bitmaps está en la RAÍZ del repo
  const base = path.resolve(__dirname, "../assets/bitmaps");

  return {
    high:  await loadOneBase64(base, "alert-high-526x100.bmp"),
    low:   await loadOneBase64(base, "alert-low-526x100.bmp"),
    sun:   await loadOneBase64(base, "weather-sun-526x100.bmp"),
    cloud: await loadOneBase64(base, "weather-cloud-526x100.bmp"),
    rain:  await loadOneBase64(base, "weather-rain-526x100.bmp"),
  };
}

module.exports = { loadBitmaps };
