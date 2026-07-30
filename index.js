const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Session Manager
const sessions = new Map();
const MAX_SESSIONS = config.maxSessions;

function addSession(id, data) {
    if (sessions.size >= MAX_SESSIONS) {
        const first = sessions.keys().next().value;
        removeSession(first);
    }
    sessions.set(id, { ...data, created: Date.now() });
}

function removeSession(id) {
    const s = sessions.get(id);
    if (s?.sock) try { s.sock.end(); } catch(e) {}
    sessions.delete(id);
    const dir = path.join(__dirname, 'sessions', id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function getStats() {
    return {
        active: sessions.size,
        max: MAX_SESSIONS,
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        uptime: Math.floor(process.uptime())
    };
}

// Cleanup every 15 min
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
        if (now - s.created > 3600000) removeSession(id);
    }
}, 900000);

// ==========================================
// API ROUTES
// ==========================================
app.get('/api/stats', (req, res) => {
    res.json({ success: true, ...getStats(), bot: config.name });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// SOCKET.IO
// ==========================================
io.on('connection', (socket) => {
    console.log('✅ Connected:', socket.id);
    socket.emit('stats', getStats());

    // Pair Code
    socket.on('pair', async (phone) => {
        console.log('📱 Pair:', phone);
        
        if (!phone || String(phone).length < 10) {
            return socket.emit('error', 'Invalid number!');
        }

        socket.emit('log', '⏳ Connecting...');

        try {
            const code = await createPairing(phone, socket);
            socket.emit('code', code);
        } catch(e) {
            console.error('Pair error:', e.message);
            socket.emit('error', e.message);
        }
    });

    // QR Code
    socket.on('qrcode', async () => {
        console.log('📱 QR Request');
        socket.emit('log', '⏳ Generating QR...');
        
        try {
            await createQR(socket);
        } catch(e) {
            console.error('QR error:', e.message);
            socket.emit('error', e.message);
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ Disconnected:', socket.id);
    });
});

// ==========================================
// PAIRING CODE
// ==========================================
async function createPairing(phone, socket) {
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
    
    const id = 'P_' + Date.now();
    const dir = path.join(__dirname, 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: require('pino')({ level: 'silent' }),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, require('pino')({ level: 'silent' })) },
        browser: ['Ubuntu', 'Chrome', '20.0.0'],
        printQRInTerminal: false,
        connectTimeoutMs: 30000
    });

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try { sock.end(); } catch(e) {}
            reject(new Error('Timeout! Try again.'));
        }, 45000);

        sock.ev.on('connection.update', async (up) => {
            if (up.connection === 'open') {
                clearTimeout(timer);
                socket.emit('log', '✅ Getting code...');
                
                try {
                    const code = await sock.requestPairingCode(String(phone));
                    if (code) {
                        addSession(id, { sock, phone });
                        setupBot(sock, id);
                        resolve(code);
                    }
                } catch(e) {
                    clearTimeout(timer);
                    reject(new Error('Code failed!'));
                }
            }
            
            if (up.connection === 'close') {
                clearTimeout(timer);
                reject(new Error('Connection closed!'));
            }
        });

        sock.ev.on('creds.update', saveCreds);
    });
}

// ==========================================
// QR CODE
// ==========================================
async function createQR(socket) {
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
    
    const id = 'Q_' + Date.now();
    const dir = path.join(__dirname, 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: require('pino')({ level: 'silent' }),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, require('pino')({ level: 'silent' })) },
        browser: ['Ubuntu', 'Chrome', '20.0.0'],
        printQRInTerminal: true,
        connectTimeoutMs: 30000
    });

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try { sock.end(); } catch(e) {}
            reject(new Error('QR timeout!'));
        }, 60000);

        sock.ev.on('connection.update', (up) => {
            if (up.qr) {
                socket.emit('qr', up.qr);
                socket.emit('log', '📱 Scan QR!');
            }

            if (up.connection === 'open') {
                clearTimeout(timer);
                addSession(id, { sock, phone: 'QR' });
                setupBot(sock, id);
                socket.emit('done');
                resolve('ok');
            }

            if (up.connection === 'close') {
                clearTimeout(timer);
                reject(new Error('Closed!'));
            }
        });

        sock.ev.on('creds.update', saveCreds);
    });
}

// ==========================================
// BOT HANDLER
// ==========================================
function setupBot(sock, id) {
    const cmds = {
        menu: '🤖 *RIO X MD*\n\n.menu .ping .info .owner',
        ping: '🏓 Pong!',
        info: '👥 Users: ' + sessions.size + '\n💾 RAM: ' + Math.round(process.memoryUsage().heapUsed/1024/1024) + 'MB',
        owner: '👑 ' + config.owner + '\n📱 ' + config.number,
        alive: '✅ Bot Active!'
    };

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg?.message || m.type !== 'notify') return;

        const from = msg.key.remoteJid;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

        if (!text.startsWith(config.prefix)) return;

        await sock.readMessages([msg.key]).catch(() => {});

        const cmd = text.slice(1).split(' ')[0].toLowerCase();
        
        if (cmds[cmd]) {
            await sock.sendMessage(from, { text: cmds[cmd] }).catch(() => {});
        }
    });

    sock.ev.on('connection.update', (up) => {
        if (up.connection === 'close') removeSession(id);
    });
}

// ==========================================
// START
// ==========================================
const PORT = config.port;
server.listen(PORT, () => {
    console.log(`
╔══════════════════════════╗
║  🤖 RIO X MD - Railway ║
║  🌐 Port: ${PORT}          ║
║  👥 Max: ${MAX_SESSIONS} users     ║
╚══════════════════════════╝
    `);
});

// Keep alive
setInterval(() => {
    const mem = process.memoryUsage().heapUsed / 1024 / 1024;
    if (mem > config.ramLimit) {
        console.log('⚠️ RAM:', Math.round(mem), 'MB');
        if (global.gc) global.gc();
    }
}, 30000);

// Health check
app.get('/health', (req, res) => res.send('OK'));
