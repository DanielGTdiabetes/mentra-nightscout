// src/bitmaps.js
// Loader de BMPs sin depender de BitmapUtils.loadBmpAsHex (no existe en tu SDK).
// Lee el BMP con Node y lo convierte a HEX. Valida cabecera: 526x100, 1-bit, BI_RGB.

const path = require("path");
const fs = require("fs/promises");
let BitmapUtils = null;
try {
  // por si tu SDK sí trae validateBmpHex; lo usamos si existe
  ({ BitmapUtils } = require("@mentra/sdk"));
} catch {}

const EXPECT_W = 526;
const EXPECT_H = 100;

// --- lectura como HEX ---
async function readBmpAsHex(absPath) {
  const buf = await fs.readFile(absPath);
  return buf.toString("hex");
}

// --- validador básico de cabecera BMP ---
function validateBmpBasic(hex) {
  try {
    const buf = Buffer.from(hex, "hex");
    if (buf.length < 54) return { isValid: false, errors: ["BMP header too short"] };
    const sig = buf.slice(0, 2).toString("ascii");        // "BM"
    const dib = buf.readUInt32LE(14);                     // DIB header size
    const w   = buf.readInt32LE(18);
    const h   = buf.readInt32LE(22);
    const planes = buf.readUInt16LE(26);
    const bpp    = buf.readUInt16LE(28);
    const comp   = buf.readUInt32LE(30);                  // 0 = BI_RGB

    const ok = (
      sig === "BM" &&
      dib >= 40 &&
      w === EXPECT_W &&
      h === EXPECT_H &&
      planes === 1 &&
      bpp === 1 &&
      comp === 0
    );

    return ok
      ? { isValid: true, errors: [] }
      : { isValid: false, errors: [`sig=${sig} dib=${dib} ${w}x${h} planes=${planes} bpp=${bpp} comp=${comp}`] };
  } catch (e) {
    return { isValid: false, errors: [String(e?.message || e)] };
  }
}

async function loadOne(base, name) {
  const abs = path.join(base, name);
  const hex = await readBmpAsHex(abs);

  // Si el SDK trae validateBmpHex lo usamos; si no, usamos el nuestro
  let res = { isValid: true, errors: [] };
  if (BitmapUtils?.validateBmpHex) {
    res = BitmapUtils.validateBmpHex(hex);
  } else {
    res = validateBmpBasic(hex);
  }
  if (!res.isValid) {
    throw new Error(`Bitmap inválido ${name}: ${res.errors?.join(", ")}`);
  }
  return hex;
}

async function loadBitmaps() {
  // OJO: assets/bitmaps está en la RAÍZ del repo
  const base = path.resolve(__dirname, "../assets/bitmaps");

  return {
    high:  await loadOne(base, "alert-high-526x100.bmp"),
    low:   await loadOne(base, "alert-low-526x100.bmp"),
    sun:   await loadOne(base, "weather-sun-526x100.bmp"),
    cloud: await loadOne(base, "weather-cloud-526x100.bmp"),
    rain:  await loadOne(base, "weather-rain-526x100.bmp"),
  };
}

module.exports = { loadBitmaps };
