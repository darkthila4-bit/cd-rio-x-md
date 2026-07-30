// RIO X MD - Configuration File
module.exports = {
    // Bot Basic Info
    name: 'RIO X MD',
    owner: 'RIO X',
    number: '947XXXXXXXX', // ඔයාගේ WhatsApp number (country code එක්ක)
    prefix: '.',
    
    // Server Port
    port: process.env.PORT || 3000,
    
    // Session Management
    session: {
        maxSessions: 30,        // Max bot sessions ekata
        inactiveTimeout: 3600,  // 1 hour inactive nam remove (seconds)
        cleanupInterval: 1800,  // 30 min walin cleanup (seconds)
        messageCacheSize: 50    // Cache karana message count
    },
    
    // Features (RAM save karanna off karanna puluwan)
    features: {
        autoread: true,
        autotyping: false,
        welcome: false,
        antispam: true
    },
    
    // Performance Settings
    performance: {
        maxMemory: '512',       // MB (Railway free limit)
        rateLimit: 10,          // Minute ekata messages
        cooldown: 3             // Commands between seconds
    }
};