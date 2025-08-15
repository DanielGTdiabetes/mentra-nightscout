// scripts/alias-amentra.js
// Crea un "alias" para que require('amentra/sdk/...') resuelva a @mentra/sdk.
const fs = require('fs');
const path = require('path');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

try {
  const root = path.join(__dirname, '..');
  const nodeModules = path.join(root, 'node_modules');
  const amentraSdk = path.join(nodeModules, 'amentra', 'sdk');   // alias destino
  const realSdk = path.join(nodeModules, '@mentra', 'sdk');      // paquete real

  if (!fs.existsSync(realSdk)) {
    console.warn('[alias-amentra] @mentra/sdk no está instalado aún; nada que aliasar.');
    process.exit(0);
  }

  ensureDir(amentraSdk);

  // 1) index.js que reexporta el paquete real cuando se hace require('amentra/sdk')
  const indexJs = path.join(amentraSdk, 'index.js');
  fs.writeFileSync(indexJs, "module.exports = require('@mentra/sdk');\n");

  // 2) enlazar 'dist' -> real 'dist' para soportar subrutas: require('amentra/sdk/dist/...').
  const linkFrom = path.join(amentraSdk, 'dist');
  const linkTo = path.join(realSdk, 'dist');

  // Si existía un 'dist' previo (carpeta o link), lo eliminamos.
  try { fs.rmSync(linkFrom, { recursive: true, force: true }); } catch {}

  // Crear symlink (Render corre en Linux, por lo que 'dir' funciona).
  fs.symlinkSync(linkTo, linkFrom, 'dir');

  console.log('[alias-amentra] alias creado: amentra/sdk -> @mentra/sdk');
} catch (e) {
  console.warn('[alias-amentra] no se pudo crear el alias (continuo sin romper):', e && e.message);
  // No hacemos process.exit(1); preferimos no romper la instalación.
}
