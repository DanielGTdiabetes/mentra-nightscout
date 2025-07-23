Nightscout for MentraOS – Glucose Viewer on G1 Smart Glasses
Real-Time Glucose Monitoring for Even Realities G1 Smart Glasses

A native MentraOS application that enables discrete glucose monitoring directly on Even Realities G1 smart glasses by connecting to personal Nightscout servers.

🎯 Features
🩸 Direct Nightscout Integration - Connects to any personal Nightscout server

👓 AR Display Optimized - Designed for Even Realities G1 green monochrome display (640×200px)

⏰ Automatic Updates - Configurable refresh intervals (default: 5 minutes)

🚨 Smart Alerts - Customizable high/low glucose notifications

⚙️ User Configuration - Individual settings via MentraOS official Settings system

🌍 Multi-language - English, Spanish, and French support

🤖 Mira AI Compatible - Works seamlessly with MentraOS voice assistant

🛠️ Technology Stack
Node.js 18+

@mentra/sdk (Official MentraOS SDK)

Axios for HTTP requests

CommonJS for maximum compatibility

📱 User Experience
Users see their glucose data discretely by tilting their head up:

text
* 142 mg/dL ->
10:15
Visual Indicators:

* Normal glucose (70-180 mg/dL)

! Low glucose (<70 mg/dL)

^ High glucose (>180 mg/dL)

🚀 Installation
Prerequisites
Even Realities G1 smart glasses

MentraOS installed

Personal Nightscout server

Node.js 18+ (for development)

Setup
Clone this repository

Install dependencies: npm install

Configure environment variables

Deploy to cloud service (Railway, Ubuntu server, etc.)

Register app in MentraOS Developer Console

⚙️ Configuration
Users configure the app through MentraOS Settings:

Nightscout URL - Your personal Nightscout server

API Token - Nightscout authentication token

Update Interval - Data refresh frequency

Alert Thresholds - Custom high/low glucose limits

Language - Display language preference

🎯 Use Cases
Professional Meetings - Discrete monitoring without device interaction

Sports & Exercise - Hands-free tracking during activities

Daily Life - Always-available glucose information

Driving - Quick status checks without looking away

📊 Benefits
Medical-Grade Reliability - Robust error handling and automatic recovery

Privacy-First - Direct connection to personal Nightscout server

Battery Optimized - Efficient updates to preserve glasses battery life

Universal Compatibility - Works with any Nightscout server setup

🔧 Development
bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Deploy to production
npm start
📚 Documentation
MentraOS SDK Documentation

Nightscout API Reference

Even Realities G1 Specifications

🤝 Contributing
Contributions are welcome! Please read our contributing guidelines and submit pull requests for any improvements.

📄 License
This project is licensed under the MIT License - see the LICENSE file for details.

⚠️ Medical Disclaimer
This application is for informational purposes only. Always consult healthcare professionals for medical decisions and verify glucose readings with approved medical devices.

Built with ❤️ for the diabetes community using MentraOS technology
