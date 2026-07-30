require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// Baileys Import
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');

// Express Setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    maxHttpBufferSize: 1e6
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Sessions folder
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// ==========================================
// SESSION MANAGER
// ==========================================
class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.maxSessions = config.session.maxSessions;
    }

    add(sessionId, data) {
        if (this.sessions.size >= this.maxSessions) {
            const firstKey = this.sessions.keys().next().value;
            this.remove(firstKey);
        }
        this.sessions.set(sessionId, {
            ...data,
            createdAt: Date.now(),
            lastActive: Date.now()
        });
    }

    remove(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session && session.sock) {
            try { session.sock.end(); } catch(e) {}
        }
        this.sessions.delete(sessionId);
        
        const sessionDir = path.join(sessionsDir, sessionId);
        if (fs.existsSync(sessionDir)) {
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(e) {}
        }
    }

    get(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) session.lastActive = Date.now();
        return session;
    }

    getCount() {
        return this.sessions.size;
    }

    cleanup() {
        const now = Date.now();
        const timeout = config.session.inactiveTimeout * 1000;
        
        for (const [id, session] of this.sessions) {
            if (now - session.lastActive > timeout) {
                console.log(`Cleanup: ${id}`);
                this.remove(id);
            }
        }
    }

    getStats() {
        return {
            active: this.sessions.size,
            max: this.maxSessions,
            memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
        };
    }
}

const sessionManager = new SessionManager();

// Cleanup every 30 minutes
setInterval(() => {
    sessionManager.cleanup();
    if (global.gc) global.gc();
}, config.session.cleanupInterval * 1000);

// ==========================================
// COMMANDS
// ==========================================
const commands = {
    menu: async (sock, from) => {
        const text = `🤖 *${config.name}*\n\n` +
            `📋 *Commands:*\n` +
            `${config.prefix}menu - Menu ek\n` +
            `${config.prefix}ping - Check bot\n` +
            `${config.prefix}info - Bot info\n` +
            `${config.prefix}owner - Owner details\n` +
            `${config.prefix}alive - Bot status\n\n` +
            `🌐 Pair: ${process.env.PUBLIC_URL || 'http://localhost:' + config.port}`;
        await sock.sendMessage(from, { text });
    },

    ping: async (sock, from) => {
        const start = Date.now();
        await sock.sendMessage(from, { text: '🏓 Pong!' });
        await sock.sendMessage(from, { text: `⚡ Speed: ${Date.now() - start}ms\n✅ Bot Active` });
    },

    info: async (sock, from) => {
        const stats = sessionManager.getStats();
        const uptime = Math.floor(process.uptime());
        const h = Math.floor(uptime / 3600);
        const m = Math.floor((uptime % 3600) / 60);
        
        const text = `🤖 *${config.name}*\n\n` +
            `👨‍💻 Owner: ${config.owner}\n` +
            `📶 Users: ${stats.active}\n` +
            `💾 RAM: ${stats.memory}MB\n` +
            `⏱️ Uptime: ${h}h ${m}m`;
        await sock.sendMessage(from, { text });
    },

    owner: async (sock, from) => {
        await sock.sendMessage(from, { text: `👑 *Owner:* ${config.owner}\n📱 ${config.number}` });
    },

    alive: async (sock, from) => {
        await sock.sendMessage(from, { text: `✅ *${config.name}* is Alive!\n🟢 Online & Ready` });
    }
};

// Rate Limiter
const rateLimiter = new Map();

function checkRateLimit(userId) {
    const now = Date.now();
    const hits = rateLimiter.get(userId) || [];
    const recent = hits.filter(t => now - t < 60000);
    
    if (recent.length >= config.performance.rateLimit) return false;
    
    recent.push(now);
    rateLimiter.set(userId, recent);
    return true;
}

// ==========================================
// BOT HANDLER
// ==========================================
function setupBot(sock, sessionId, phoneNumber) {
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg?.message || m.type !== 'notify') return;

        const from = msg.key.remoteJid;
        const body = msg.message?.conversation || 
                    msg.message?.extendedTextMessage?.text || 
                    msg.message?.imageMessage?.caption || '';

        if (!body || !body.startsWith(config.prefix)) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        if (!checkRateLimit(sender)) return;

        const session = sessionManager.get(sessionId);
        if (session) session.lastActive = Date.now();

        if (config.features.autoread) {
            await sock.readMessages([msg.key]).catch(() => {});
        }

        const args = body.slice(config.prefix.length).trim().split(/ +/);
        const command = args.shift()?.toLowerCase();

        if (command && commands[command]) {
            try {
                await commands[command](sock, from, msg, args);
            } catch (err) {
                console.error(`Command Error [${command}]:`, err.message);
            }
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'close') {
            sessionManager.remove(sessionId);
        }
    });

    sock.ev.on('creds.update', async () => {
        // Auto saved by Baileys
    });
}

// ==========================================
// PAIRING CODE GENERATOR
// ==========================================
async function generatePairingCode(phoneNumber, socket) {
    const sessionId = `PAIR_${phoneNumber}_${Date.now()}`;
    
    const sessionDir = path.join(sessionsDir, sessionId);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        version: (await fetchLatestBaileysVersion()).version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        browser: ['RIO X MD', 'Chrome', '2.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        printQRInTerminal: false
    });

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            sock.end();
            sessionManager.remove(sessionId);
            reject(new Error('Connection timeout. Try again!'));
        }, 90000);

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;

            if (connection === 'open') {
                socket.emit('log', '✅ Connected! Getting code...');
                
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    
                    if (code && code.length >= 8) {
                        clearTimeout(timeout);
                        
                        sessionManager.add(sessionId, {
                            sock,
                            phoneNumber,
                            state,
                            saveCreds
                        });
                        
                        setupBot(sock, sessionId, phoneNumber);
                        
                        socket.emit('log', '🎉 Code generated!');
                        resolve(code);
                    } else {
                        throw new Error('Invalid code');
                    }
                } catch (err) {
                    clearTimeout(timeout);
                    reject(new Error('Failed to generate code'));
                }
            }

            if (connection === 'close') {
                clearTimeout(timeout);
                reject(new Error('Connection closed'));
            }
        });

        sock.ev.on('creds.update', saveCreds);
    });
}

// ==========================================
// QR CODE GENERATOR
// ==========================================
async function generateQRCode(socket) {
    const sessionId = 'QR_' + Date.now();
    
    const sessionDir = path.join(sessionsDir, sessionId);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        version: (await fetchLatestBaileysVersion()).version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        browser: ['RIO X MD', 'Chrome', '2.0.0'],
        connectTimeoutMs: 60000,
        printQRInTerminal: false
    });

    const timeout = setTimeout(() => {
        sock.end();
        sessionManager.remove(sessionId);
        socket.emit('error', 'QR timeout! Try again.');
    }, 120000);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;

        if (qr) {
            socket.emit('qr', { qr });
            socket.emit('log', '📱 QR Code ready! Scan now.');
        }

        if (connection === 'open') {
            clearTimeout(timeout);
            
            sessionManager.add(sessionId, {
                sock,
                phoneNumber: 'QR_USER',
                state,
                saveCreds
            });
            
            setupBot(sock, sessionId, 'QR_USER');
            socket.emit('qr-connected');
            socket.emit('log', '✅ QR connected!');
        }

        if (connection === 'close') {
            clearTimeout(timeout);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// ==========================================
// SOCKET.IO
// ==========================================
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Send initial stats
    socket.emit('stats', sessionManager.getStats());

    // Pairing Code Request
    socket.on('pair', async (data) => {
        const { phone } = data;
        
        if (!phone || phone.length < 10) {
            socket.emit('error', 'Invalid phone number!');
            return;
        }

        socket.emit('log', 'Connecting...');

        try {
            const code = await generatePairingCode(phone, socket);
            socket.emit('code', { code, phone });
        } catch (err) {
            socket.emit('error', err.message);
        }
    });

    // QR Code Request
    socket.on('request-qr', async () => {
        socket.emit('log', 'Generating QR code...');
        
        try {
            await generateQRCode(socket);
        } catch (err) {
            socket.emit('error', err.message);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// ==========================================
// API ROUTES
// ==========================================
app.get('/api/stats', (req, res) => {
    res.json({
        success: true,
        ...sessionManager.getStats(),
        uptime: Math.floor(process.uptime()),
        bot: config.name
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// ==========================================
// START SERVER
// ==========================================
server.listen(config.port, () => {
    console.log('');
    console.log('╔══════════════════════════════════╗');
    console.log(`║  🤖 ${config.name} Bot          ║`);
    console.log(`║  🌐 http://localhost:${config.port}       ║`);
    console.log(`║  👥 Max Users: ${config.session.maxSessions}            ║`);
    console.log(`║  💾 RAM Limit: ${config.performance.maxMemory}MB         ║`);
    console.log('╚══════════════════════════════════╝');
    console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down...');
    server.close();
    process.exit(0);
});

// RAM monitoring
setInterval(() => {
    const mem = process.memoryUsage().heapUsed / 1024 / 1024;
    if (mem > parseInt(config.performance.maxMemory) * 0.8) {
        console.log(`RAM Warning: ${Math.round(mem)}MB`);
        sessionManager.cleanup();
        if (global.gc) global.gc();
    }
}, 60000);