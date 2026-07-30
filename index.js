require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Sessions folder
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// Session Manager
class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.maxSessions = 30;
    }

    add(id, data) {
        if (this.sessions.size >= this.maxSessions) {
            const first = this.sessions.keys().next().value;
            this.remove(first);
        }
        this.sessions.set(id, { ...data, createdAt: Date.now(), lastActive: Date.now() });
    }

    remove(id) {
        const session = this.sessions.get(id);
        if (session?.sock) try { session.sock.end(); } catch(e) {}
        this.sessions.delete(id);
        const dir = path.join(sessionsDir, id);
        if (fs.existsSync(dir)) try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
    }

    getStats() {
        return {
            active: this.sessions.size,
            max: this.maxSessions,
            memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            uptime: Math.floor(process.uptime())
        };
    }
}

const sessionManager = new SessionManager();

// Cleanup every 30 min
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessionManager.sessions) {
        if (now - session.lastActive > 3600000) {
            sessionManager.remove(id);
        }
    }
}, 1800000);

// Commands
const commands = {
    menu: async (sock, from) => {
        const text = `🤖 *RIO X MD*\n\n` +
            `📋 Commands:\n.menu\n.ping\n.info\n.owner\n.alive`;
        await sock.sendMessage(from, { text });
    },
    ping: async (sock, from) => {
        const start = Date.now();
        await sock.sendMessage(from, { text: `⚡ ${Date.now() - start}ms` });
    },
    info: async (sock, from) => {
        const s = sessionManager.getStats();
        await sock.sendMessage(from, { text: `👥 Users: ${s.active}\n💾 RAM: ${s.memory}MB` });
    },
    owner: async (sock, from) => {
        await sock.sendMessage(from, { text: `👑 ${config.owner}\n📱 ${config.number}` });
    },
    alive: async (sock, from) => {
        await sock.sendMessage(from, { text: '✅ Bot Alive!' });
    }
};

// Bot Handler
function setupBot(sock, sessionId) {
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg?.message || m.type !== 'notify') return;

        const from = msg.key.remoteJid;
        const body = msg.message?.conversation || 
                    msg.message?.extendedTextMessage?.text || '';

        if (!body.startsWith(config.prefix)) return;

        const session = sessionManager.get(sessionId);
        if (session) session.lastActive = Date.now();

        await sock.readMessages([msg.key]).catch(() => {});

        const args = body.slice(config.prefix.length).trim().split(/ +/);
        const cmd = args.shift()?.toLowerCase();

        if (cmd && commands[cmd]) {
            try {
                await commands[cmd](sock, from);
            } catch(e) {
                console.error('Cmd error:', e.message);
            }
        }
    });

    sock.ev.on('connection.update', (u) => {
        if (u.connection === 'close') sessionManager.remove(sessionId);
    });
}

// ==========================================
// PAIRING CODE GENERATOR (FIXED)
// ==========================================
async function generatePairingCode(phoneNumber, socket) {
    const sessionId = `P_${Date.now()}`;
    
    const sessionDir = path.join(sessionsDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        version: (await fetchLatestBaileysVersion()).version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        browser: ['Chrome (Linux)', '', ''],
        connectTimeoutMs: 30000,
        printQRInTerminal: false
    });

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            try { sock.end(); } catch(e) {}
            reject(new Error('Connection timeout'));
        }, 60000);

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr } = update;

            if (qr) {
                console.log('QR received for pairing');
            }

            if (connection === 'open') {
                clearTimeout(timeout);
                socket.emit('log', 'Getting code...');
                
                try {
                    // Request pairing code
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log('Code generated:', code);
                    
                    if (code) {
                        sessionManager.add(sessionId, { sock, phoneNumber, lastActive: Date.now() });
                        setupBot(sock, sessionId);
                        resolve(code);
                    } else {
                        reject(new Error('No code received'));
                    }
                } catch(e) {
                    console.error('Pairing error:', e.message);
                    reject(new Error(e.message));
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
// QR CODE GENERATOR (FIXED)
// ==========================================
async function generateQRCode(socket) {
    const sessionId = `Q_${Date.now()}`;
    const sessionDir = path.join(sessionsDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        version: (await fetchLatestBaileysVersion()).version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        browser: ['Chrome (Linux)', '', ''],
        connectTimeoutMs: 30000,
        printQRInTerminal: true
    });

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            try { sock.end(); } catch(e) {}
            reject(new Error('QR timeout'));
        }, 90000);

        sock.ev.on('connection.update', (update) => {
            const { connection, qr } = update;

            if (qr) {
                console.log('QR generated');
                socket.emit('qr', { qr });
                socket.emit('log', 'QR ready!');
            }

            if (connection === 'open') {
                clearTimeout(timeout);
                sessionManager.add(sessionId, { sock, phoneNumber: 'QR', lastActive: Date.now() });
                setupBot(sock, sessionId);
                socket.emit('qr-connected');
                resolve('connected');
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
// SOCKET.IO (FIXED)
// ==========================================
io.on('connection', (socket) => {
    console.log('✅ Client connected:', socket.id);
    
    // Send initial stats
    socket.emit('stats', sessionManager.getStats());

    // Pairing Code
    socket.on('pair', async (data) => {
        console.log('Pair request:', data.phone);
        
        if (!data.phone || data.phone.length < 10) {
            socket.emit('error', 'Invalid phone number');
            return;
        }

        socket.emit('log', 'Connecting...');

        try {
            const code = await generatePairingCode(data.phone, socket);
            console.log('Success code:', code);
            socket.emit('code', { code, phone: data.phone });
            socket.emit('log', 'Success!');
        } catch(e) {
            console.error('Pair error:', e.message);
            socket.emit('error', e.message || 'Failed');
        }
    });

    // QR Code
    socket.on('request-qr', async () => {
        console.log('QR request');
        socket.emit('log', 'Generating QR...');
        
        try {
            await generateQRCode(socket);
        } catch(e) {
            console.error('QR error:', e.message);
            socket.emit('error', e.message || 'QR failed');
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// API Routes
app.get('/api/stats', (req, res) => {
    res.json({ success: true, ...sessionManager.getStats() });
});

// Test route
app.get('/test', (req, res) => {
    res.send('Bot is running! ✅');
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🤖 RIO X MD Running on port ${PORT}`);
    console.log(`🌐 http://localhost:${PORT}\n`);
});
