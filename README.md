# Nightscout for MentraOS – Advanced Glucose Monitoring on G1 Smart Glasses

**Real-Time Glucose Monitoring for Even Realities G1 Smart Glasses with Intelligent Display & Voice Control**

A native MentraOS application that enables discrete, intelligent glucose monitoring directly on Even Realities G1 smart glasses by connecting to personal Nightscout servers.

## 🎯 Features

### Core Functionality
- 🩸 **Direct Nightscout Integration** - Connects to any personal Nightscout server
- 👓 **AR Display Optimized** - Designed for Even Realities G1 green monochrome display (640×200px)
- ⏰ **Automatic Updates** - Configurable refresh intervals (default: 5 minutes)
- 🚨 **Smart Critical Alerts** - Only shows urgent notifications (< 70 or > 250 mg/dL)
- ⚙️ **User Configuration** - Individual settings via MentraOS official Settings system

### 🆕 New Advanced Features

#### 👁️ **Intelligent Display System**
- **Smart Display Management** - Shows glucose for 5 seconds on startup, then hides automatically
- **On-Demand Display** - Voice commands like "show glucose" or "glucosa" trigger temporary display
- **Button Activation** - Press glasses button to show glucose temporarily
- **Clean Interface** - No permanent screen overlay to avoid distraction

#### 🌍 **Global Timezone Support**
- **Automatic Detection** - Intelligently detects user's timezone
- **Manual Configuration** - Support for major timezones worldwide:
  - 🇪🇸 Spain: Madrid, Canary Islands
  - 🇺🇸 USA: Eastern, Central, Pacific timezones
  - 🇲🇽 Mexico, 🇦🇷 Argentina, 🇧🇷 Brazil
  - 🇪🇺 Europe: UK, France, Germany, Italy
  - 🌏 Asia & Oceania: Japan, Australia
- **Server Compatibility** - Works correctly on cloud servers (Render, Railway, etc.)

#### 🤖 **Advanced Mira AI Integration**
- **Bilingual Voice Control** - Works in English and Spanish seamlessly
- **Smart Language Detection** - Responds in user's preferred language automatically
- **Multiple Command Support**:
  - 🇺🇸 English: *"Hey Mira, get my glucose"*, *"check my blood sugar"*
  - 🇪🇸 Spanish: *"Hey Mira, obtener mi glucosa"*, *"revisar mi azúcar"* 
- **Visual + Audio Response** - Shows glucose on glasses AND provides voice response
- **Context-Aware** - Adapts response based on glucose levels and trends

#### 🔄 **Enhanced Alert System**
- **Critical-Only Alerts** - Reduces notification fatigue with only urgent alerts
- **Auto-Hide Alerts** - Alerts disappear automatically after 15-20 seconds
- **Bilingual Alerts** - Emergency notifications in user's language
- **Smart Timing** - Prevents alert spam with intelligent cooldown periods

#### 🌐 **Multi-language Support**
- **Full Localization** - English, Spanish, and French support
- **Smart Detection** - Automatically uses user's language preference
- **Consistent Experience** - All features work seamlessly in any language

## 📱 User Experience

### Visual Display
Users see their glucose data discretely:
```
* 142 mg/dL ->
  10:15
```

**Visual Indicators:**
- `*` Normal glucose (70-180 mg/dL)
- `!` Low glucose (<70 mg/dL) 
- `^` High glucose (>180 mg/dL)

**Trend Arrows:**
- `^^` Rising rapidly
- `^` Rising
- `/` Rising slowly
- `->` Stable
- `\` Falling slowly
- `v` Falling
- `vv` Falling rapidly

### 🎮 Interaction Methods

1. **Voice Commands** (with Mira):
   - *"Hey Mira, get my glucose"*
   - *"Hey Mira, obtener mi glucosa"*
   - *"Hey Mira, check my blood sugar"*

2. **Direct Voice** (without Mira):
   - *"show glucose"* / *"mostrar glucosa"*
   - *"glucose"* / *"glucosa"*
   - *"sugar"* / *"azúcar"*

3. **Button Press**: Physical button on glasses (if available)

4. **Auto Display**: Brief show on app startup, then intelligent hiding

## 🛠️ Technology Stack

- **Node.js 18+**
- **@mentra/sdk** (Official MentraOS SDK)
- **Axios** for HTTP requests
- **CommonJS** for maximum compatibility
- **Intelligent Timezone Detection** using Intl.DateTimeFormat
- **Advanced Event Handling** with proper cleanup and memory management

## 🚀 Installation

### Prerequisites
- Even Realities G1 smart glasses
- MentraOS installed
- Personal Nightscout server
- Node.js 18+ (for development)

### Setup
1. Clone this repository
2. Install dependencies: `npm install`
3. Configure environment variables
4. Deploy to cloud service (Render, Railway, Ubuntu server, etc.)
5. Register app in MentraOS Developer Console
6. Configure AI Tools for Mira integration

## ⚙️ Configuration

### Required Settings (via MentraOS Settings)
- **Nightscout URL** - Your personal Nightscout server
- **API Token** - Nightscout authentication token
- **Update Interval** - Data refresh frequency
- **Alert Thresholds** - Custom high/low glucose limits
- **Language** - Display language preference (en/es/fr)

### 🆕 New Optional Settings
- **Timezone** - Manual timezone selection (auto-detected if not set)
- **Display Mode** - Smart display behavior configuration

### 🤖 AI Tools Configuration
Configure these AI Tools in MentraOS Developer Console:

**English Tools:**
- `get_glucose` - "Get current glucose level"
- `check_glucose` - "Check glucose status"

**Spanish Tools:**
- `obtener_glucosa` - "Obtener nivel de glucosa"
- `revisar_glucosa` - "Revisar estado de glucosa"

## 🎯 Use Cases

### Professional & Social
- **Meetings** - Discrete monitoring without device interaction
- **Presentations** - Quick checks without breaking flow
- **Social Events** - Private health monitoring

### Active Lifestyle
- **Sports & Exercise** - Hands-free tracking during activities
- **Driving** - Safe status checks without looking away
- **Travel** - Automatic timezone adjustment worldwide

### Daily Management
- **Always Available** - Instant glucose information on demand
- **Smart Alerts** - Only notified when action is needed
- **Voice Control** - Hands-free operation in any language

## 📊 Benefits

### Medical-Grade Features
- **Reliability** - Robust error handling and automatic recovery
- **Accuracy** - Direct connection to personal Nightscout server
- **Privacy-First** - No data stored or transmitted to third parties

### User Experience
- **Battery Optimized** - Intelligent display management preserves battery
- **Global Compatibility** - Works worldwide with automatic timezone detection
- **Distraction-Free** - Smart display prevents constant screen overlay
- **Universal Access** - Voice control in multiple languages

### Technical Excellence
- **Cloud Server Compatible** - Properly handles server timezone differences
- **Memory Efficient** - Advanced cleanup prevents memory leaks
- **Event-Driven** - Responsive to user actions and system events
- **Error Resilient** - Graceful handling of network and API issues

## 🔧 Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Deploy to production
npm start
```

### Development Features
- **Hot Reload** - Automatic restarts on code changes
- **Comprehensive Logging** - Detailed debug information
- **Error Tracking** - Advanced error reporting and recovery
- **Memory Management** - Proper cleanup of intervals and timeouts

## 📚 Documentation

- [MentraOS SDK Documentation](https://docs.mentra.glass)
- [Nightscout API Reference](https://nightscout.github.io)
- [Even Realities G1 Specifications](https://evenrealities.com)

## 🤝 Contributing

Contributions are welcome! Please read our contributing guidelines and submit pull requests for any improvements.

### Recent Major Updates
- **v2.0**: Intelligent display system with auto-hide functionality
- **v2.1**: Global timezone support with automatic detection
- **v2.2**: Advanced Mira AI integration with bilingual support
- **v2.3**: Enhanced alert system with critical-only notifications

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## ⚠️ Medical Disclaimer

This application is for informational purposes only. Always consult healthcare professionals for medical decisions and verify glucose readings with approved medical devices.

---

**Built with ❤️ for the diabetes community using MentraOS technology**

*Enabling discrete, intelligent glucose monitoring for a better quality of life*
