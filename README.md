🚀 Nightscout for MentraOS – v2.4.5 DUAL-UNITS Advanced
Monitor de Glucosa en Tiempo Real para Even Realities G1 Smart Glasses
✨ Ahora con soporte completo de unidades duales (mg/dL ↔ mmol/L), alarmas configurables independientes y mejoras de timezone

🆕 Novedades en v2.4.5
🔧 Mejoras Críticas y Nuevas Funcionalidades
✅ Sistema de Unidades Dual – Configuración mg/dL ↔ mmol/L con cambio dinámico

✅ Alarmas Independientes – Límites separados para mg/dL y mmol/L con sliders duales

✅ Detección de Cambios en Tiempo Real – Actualización automática al cambiar configuración

✅ Soporte Completo de Sliders – Todos los ajustes numéricos funcionan perfectamente

✅ Gestión Mejorada de Timezone – Corrección de bugs de zona horaria

✅ Internacionalización Completa – Español/Inglés con detección automática

📊 Nuevas Opciones de Configuración
Sistema de Unidades Dual
Configuración	Tipo	Rango	Por Defecto	Descripción
units	select	mg/dL, mmol/L	mg/dL	Unidades de glucosa preferidas
low_alert_mg	slider	40–90 mg/dL	70	Alerta crítica baja (mg/dL)
high_alert_mg	slider	180–400 mg/dL	250	Alerta crítica alta (mg/dL)
low_alert_mmol	slider	2–5 mmol/L	3.9	Alerta crítica baja (mmol/L)
high_alert_mmol	slider	8–30 mmol/L	13.9	Alerta crítica alta (mmol/L)
Configuraciones Adicionales
Setting	Tipo	Opciones	Por Defecto	Descripción
update_interval	select	1, 5, 15 min	5 min	Frecuencia de actualización
alerts_enabled	toggle	true/false	true	Activar/desactivar alertas
language	select	en, es	en	Idioma de la interfaz
timezone	select	Varias zonas	Europe/Madrid	Zona horaria local
🌍 Soporte Internacional Mejorado
🇪🇸 Usuarios en España
Comandos de Voz: "Hey Mira, obtener mi glucosa", "mostrar glucosa actual"

Alertas: 🚨 ¡GLUCOSA BAJA! 3.8 mmol/L / 🚨 ¡GLUCOSA BAJA! 70 mg/dL

Timezone: Europe/Madrid (Península) / Atlantic/Canary (Canarias)

Unidades: Cambio dinámico entre mg/dL y mmol/L sin reiniciar

🇺🇸 Usuarios en Estados Unidos
Comandos de Voz: "Hey Mira, get my glucose", "check blood sugar"

Alertas: 🚨 LOW GLUCOSE! 70 mg/dL / 🚨 LOW GLUCOSE! 3.8 mmol/L

Timezone: America/New_York, America/Chicago, America/Los_Angeles

Unidades: Soporte completo para ambas unidades

🌎 Compatibilidad Global
Unidades Duales: mg/dL y mmol/L con conversión automática (1 mmol/L = 18 mg/dL)

Timezones: 12+ zonas horarias soportadas

Idiomas: Detección automática desde preferencias del usuario

⚙️ Configuración MentraOS Actualizada
JSON de Configuración Completo
json
````
{
  "name": "Nightscout Glucose",
  "description": "Monitor de glucosa en tiempo real desde Nightscout",
  "publicUrl": "https://mentra-nightscout.onrender.com",
  "logoURL": "https://imagedelivery.net/nrc8B2Lk8UIoyW7fY8uHVg/58858985-f97c-40d6-21a3-a8b2514f5a00/square",
  "appType": "background",
  "permissions": [
    {
      "type": "ALL",
      "description": ""
    }
  ],
  "settings": [
    {
      "type": "group",
      "title": "SELECT UNITS"
    },
    {
      "type": "select",
      "key": "units",
      "label": "Units",
      "defaultValue": "mg/dL",
      "options": [
        {"label": "mg/dL", "value": "mg/dL"},
        {"label": "mmol/L", "value": "mmol/L"}
      ]
    },
    {
      "type": "group",
      "title": "ALARMS"
    },
    {
      "type": "slider",
      "key": "low_alert_mg",
      "label": "Critical Low Alert (mg/dL)",
      "defaultValue": 70,
      "min": 40,
      "max": 90
    },
    {
      "type": "slider",
      "key": "high_alert_mg",
      "label": "Critical High Alert (mg/dL)",
      "defaultValue": 250,
      "min": 180,
      "max": 400
    },
    {
      "type": "slider",
      "key": "low_alert_mmol",
      "label": "Critical Low Alert (mmol/L)",
      "defaultValue": 3.9,
      "min": 2,
      "max": 5
    },
    {
      "type": "slider",
      "key": "high_alert_mmol",
      "label": "Critical High Alert (mmol/L)",
      "defaultValue": 13.9,
      "min": 8,
      "max": 30
    },
    {
      "type": "toggle",
      "key": "alerts_enabled",
      "label": "Enable Alerts",
      "defaultValue": true
    },
    {
      "type": "select",
      "key": "update_interval",
      "label": "Update Frequency",
      "defaultValue": "5",
      "options": [
        {"label": "1 min", "value": "1"},
        {"label": "5 min", "value": "5"},
        {"label": "15 min", "value": "15"}
      ]
    },
    {
      "type": "group",
      "title": "SETTING LANGUAGE AND TIME ZONE"
    },
    {
      "type": "select",
      "key": "language",
      "label": "Language",
      "defaultValue": "en",
      "options": [
        {"label": "English", "value": "en"},
        {"label": "Español", "value": "es"}
      ]
    },
    {
      "type": "select",
      "key": "timezone",
      "label": "Time Zone",
      "defaultValue": "Europe/Madrid",
      "options": [
        {"label": "España - Madrid", "value": "Europe/Madrid"},
        {"label": "España - Canarias", "value": "Atlantic/Canary"},
        {"label": "USA - Este (New York)", "value": "America/New_York"},
        {"label": "USA - Centro (Chicago)", "value": "America/Chicago"},
        {"label": "USA - Oeste (Los Angeles)", "value": "America/Los_Angeles"},
        {"label": "México", "value": "America/Mexico_City"},
        {"label": "Argentina", "value": "America/Argentina/Buenos_Aires"},
        {"label": "Brasil", "value": "America/Sao_Paulo"},
        {"label": "Reino Unido", "value": "Europe/London"},
        {"label": "Francia", "value": "Europe/Paris"},
        {"label": "Alemania", "value": "Europe/Berlin"},
        {"label": "Italia", "value": "Europe/Rome"}
      ]
    },
    {
      "type": "group",
      "title": "SETTINGS NIGHTSCOUT"
    },
    {
      "type": "text",
      "key": "nightscout_url",
      "label": "Nightscout URL",
      "defaultValue": "https://ejemplo.nightscout.com"
    },
    {
      "type": "text",
      "key": "nightscout_token",
      "label": "Access Token",
      "defaultValue": "demo-token-12345"
    }
  ],
  "tools": [
    {
      "id": "get_glucose",
      "description": "Get current glucose level from Nightscout CGM",
      "activationPhrases": [
        "get glucose", "check glucose", "glucose level", 
        "blood sugar", "what's my glucose", "show glucose", "current glucose"
      ]
    },
    {
      "id": "obtener_glucosa",
      "description": "Obtener nivel actual de glucosa desde monitor continuo Nightscout",
      "activationPhrases": [
        "obtener glucosa", "revisar glucosa", "nivel glucosa", 
        "mi glucosa", "cuál es mi glucosa", "mostrar glucosa", "glucosa actual"
      ]
    },
    {
      "id": "check_glucose",
      "description": "Check current glucose status with detailed information",
      "activationPhrases": [
        "check glucose", "glucose status", "how's my sugar", 
        "glucose check", "blood sugar level"
      ]
    },
    {
      "id": "revisar_glucosa",
      "description": "Revisar estado actual de glucosa con información detallada",
      "activationPhrases": [
        "revisar glucosa", "estado glucosa", "cómo está mi azúcar", 
        "revisar azúcar", "nivel azúcar"
      ]
    }
  ]
}
````
🎮 Nuevos Métodos de Interacción
Comandos de Voz Mejorados
Español:

"Hey Mira, obtener mi glucosa" → Muestra: 120 mg/dL ↑ o 6.7 mmol/L ↑

"Hey Mira, revisar glucosa" → Muestra estado completo con tendencia

"Hey Mira, mostrar glucosa actual" → Display temporal con hora local

English:

"Hey Mira, get my glucose" → Shows: 120 mg/dL ↑ o 6.7 mmol/L ↑

"Hey Mira, check glucose" → Shows complete status with trend

"Hey Mira, show current glucose" → Temporary display with local time

Integración de Sliders Duales
Cambios en Tiempo Real: Sin necesidad de reiniciar la app

Unidades Duales: Sliders separados para mg/dL y mmol/L

Validación Automática: Rangos apropiados para cada unidad

Actualización Inmediata: Los límites de alerta se aplican al instante

📈 Mejoras de Rendimiento
Gestión de Configuración
✅ Detección de Cambios: Método onSettingsChange() optimizado

✅ Cache Inteligente: Configuración almacenada en sesión activa

✅ Limpieza Automática: Historial de alertas se reinicia con cambios de límites

✅ Validación Robusta: Rangos apropiados para cada tipo de configuración

Compatibilidad SDK
✅ Sin Errores de Compatibilidad: Totalmente compatible con MentraOS SDK

✅ Gestión de Sesiones: Limpieza apropiada de timers e intervalos

✅ Manejo de Errores: Recuperación robusta ante fallos de red

🛠️ Guía de Inicio Rápido
Para Nuevos Usuarios
Deploy a Render/Railway con Node.js 18+

Configura MentraOS:

Selecciona unidades (mg/dL o mmol/L)

Ajusta límites de alerta con sliders duales

Configura tu timezone local

Conecta Nightscout:

URL: https://tu-nightscout.herokuapp.com

Token: Tu token de acceso

¡Disfruta! 🎉

Para Usuarios Existentes (Migración desde v2.4.4)
Actualiza a v2.4.5 sin perder configuración existente

Nuevas funciones disponibles inmediatamente

Sin cambios disruptivos - todo funciona como antes

Configura nuevos sliders duales según tus preferencias

🏆 Logros Técnicos
Problemas Solucionados en v2.4.5
Problema Anterior	Estado	Solución v2.4.5
❌ Sin soporte mmol/L configurables	✅ RESUELTO	Sistema dual completo con sliders
❌ Alarmas con una sola unidad	✅ RESUELTO	Límites independientes mg/dL y mmol/L
❌ Cambios de config requieren reinicio	✅ RESUELTO	Actualización en tiempo real
❌ Timezone bugs en formateo	✅ RESUELTO	Validación mejorada
❌ Configuración no se actualiza	✅ RESUELTO	Método onSettingsChange()
Nuevas Capacidades
🔄 Cambio Dinámico de Unidades: Sin reinicio de app

🚨 Alarmas Duales: Límites específicos para mg/dL y mmol/L

⚙️ Configuración en Tiempo Real: Cambios instantáneos

🌍 Soporte Global: 12+ timezones y 2 idiomas

📊 Validación Automática: Rangos apropiados para cada unidad

💡 Casos de Uso Reales
Usuario Español en Valencia
text
Configuración:
- Units: mmol/L
- Low Alert: 3.9 mmol/L
- High Alert: 13.9 mmol/L
- Language: Español
- Timezone: Europe/Madrid

Comando: "Hey Mira, obtener mi glucosa"
Respuesta: "Tu glucosa está en 6.8 mmol/L ↗. Estado: Normal."
Display: "6.8 mmol/L ↗
         14:30 (hace 2m)"
Usuario Americano en California
text
Configuración:
- Units: mg/dL
- Low Alert: 70 mg/dL
- High Alert: 250 mg/dL
- Language: English
- Timezone: America/Los_Angeles

Comando: "Hey Mira, check glucose"
Respuesta: "Your glucose is 125 mg/dL ↑. Status: Normal."
Display: "125 mg/dL ↑
         2:30 PM (2m ago)"
🔧 Estructura de Archivos
text
nightscout-mentraos/
├── src/
│   └── index.js          # Código principal v2.4.5
├── package.json          # Dependencias Node.js
├── README.md             # Este archivo
├── .env.example          # Variables de entorno
└── render.yaml           # Configuración de despliegue
🔗 Enlaces y Recursos
📱 MentraOS Console: console.mentra.glass

🚀 Deploy a Render: Deploy en un clic disponible

📚 Documentación Completa: En este README

🤝 Soporte Comunitario: GitHub Discussions

🌐 Demo Live: mentra-nightscout.onrender.com

📋 Checklist de Configuración
✅ Configuración Básica
 URL de Nightscout configurada

 Token de acceso válido

 Unidades seleccionadas (mg/dL o mmol/L)

 Idioma configurado (español/inglés)

 Timezone de tu ubicación

✅ Alarmas Duales
 Límites de alerta mg/dL ajustados (si usas mg/dL)

 Límites de alerta mmol/L ajustados (si usas mmol/L)

 Alertas habilitadas

 Frecuencia de actualización configurada

✅ Pruebas de Funcionamiento
 Comando de voz funciona correctamente

 Display muestra datos en unidades correctas

 Cambio de unidades funciona sin reinicio

 Alertas se muestran en unidades configuradas

📄 Variables de Entorno
bash
# .env
MENTRAOS_API_KEY=tu_api_key_mentraos
PORT=3000
RENDER_URL=https://tu-app.onrender.com
PACKAGE_NAME=com.tucompania.nightscout-glucose
🆕 Changelog v2.4.5
Añadido
Sistema de unidades dual completo (mg/dL ↔ mmol/L)

Sliders separados para alarmas mg/dL y mmol/L

Detección de cambios de configuración en tiempo real

Método onSettingsChange() mejorado

Validación robusta de configuraciones

Conversión automática de unidades (1 mmol/L = 18 mg/dL)

Corregido
Bugs de timezone en formateo de tiempo

Gestión de memoria en cambios de configuración

Limpieza de historial de alertas al cambiar límites

Compatibilidad completa con MentraOS SDK

Errores de validación de rangos de sliders

Mejorado
Rendimiento en cambios de configuración instantáneos

Experiencia de usuario con unidades configurables

Logs de debugging más informativos

Gestión de errores de red y conectividad

Manejo de sesiones múltiples

📄 Licencia y Descargo de Responsabilidad
Licencia MIT – ¡Libre para fork y contribuir!

Descargo Médico: Solo para fines informativos. Siempre verifica lecturas con dispositivos médicos aprobados.

⭐ ¡Dale una estrella a este repo si te resulta útil!
Desarrollado con ❤️ para la comunidad global de diabetes.

Versión: 2.4.5 | Fecha: Julio 2025 | Compatibilidad: MentraOS SDK Latest
