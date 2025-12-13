import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pidusage from 'pidusage';
import checkDiskSpace from 'check-disk-space';
import session from 'express-session'; // [MỚI] Thư viện session

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// --- CẤU HÌNH BẢO MẬT ---
const PASSWORD = 'admin123'; // <--- ĐỔI MẬT KHẨU TẠI ĐÂY
const SESSION_SECRET = 'owo_secret_key_change_me'; // Mã bí mật session (gõ gì cũng được)

// Đường dẫn config
const CONFIG_PATH = path.join(__dirname, '..', 'b2ki-ados', 'data.json');
const BOT_COMMAND = 'node';
const BOT_ARGS = ['dest/index.js']; 

let botProcess = null;
let botStatus = 'stopped';
const MAX_LOG_HISTORY = 2000;
let logHistory = [];

// Cấu hình Middleware
app.use(express.urlencoded({ extended: true })); // Để đọc data từ form login
app.use(express.json());
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // Lưu đăng nhập 24h
}));

// --- MIDDLEWARE KIỂM TRA ĐĂNG NHẬP ---
// Hàm này chặn mọi truy cập nếu chưa login
function requireLogin(req, res, next) {
    if (req.session.loggedin) {
        next(); // Đã đăng nhập -> Cho qua
    } else {
        // Nếu là gọi API mà chưa login -> Báo lỗi 401
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        // Nếu truy cập web -> Đá về trang login
        res.redirect('/login');
    }
}

// --- ROUTES ---

// 1. Trang Login (Công khai)
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 2. Xử lý Đăng nhập
app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === PASSWORD) {
        req.session.loggedin = true;
        res.redirect('/');
    } else {
        res.redirect('/login?error=1');
    }
});

// 3. Đăng xuất
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// 4. Các file tĩnh (CSS/JS) trong public
// Lưu ý: Chúng ta không dùng express.static cho toàn bộ public nữa để bảo vệ dashboard.html
app.use('/socket.io', express.static(path.join(__dirname, 'node_modules/socket.io/client-dist'))); 
// Cho phép tải file tĩnh (trừ .html)
app.use(express.static('public', { index: false, extensions: ['css', 'js', 'png', 'jpg'] }));

// 5. Trang chủ (Đã bảo vệ) -> Load file dashboard.html
app.get('/', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// --- API & SYSTEM (Đã bảo vệ bằng requireLogin) ---

// Monitoring
setInterval(async () => {
    let stats = { cpu: 0, ram: 0, disk: '0 GB', uptime: 0 };
    if (botProcess && botProcess.pid) {
        try {
            const usage = await pidusage(botProcess.pid);
            stats.cpu = usage.cpu.toFixed(1);
            stats.ram = (usage.memory / 1024 / 1024).toFixed(1);
        } catch (e) {}
    }
    try {
        const disk = await checkDiskSpace(__dirname);
        stats.disk = `${(disk.free/1024/1024/1024).toFixed(1)} / ${(disk.size/1024/1024/1024).toFixed(1)} GB`;
    } catch (e) { stats.disk = 'N/A'; }
    io.emit('stats_update', stats);
}, 2000);

// Socket Connection
io.on('connection', (socket) => {
    // (Nâng cao: Có thể check cookie session ở đây, nhưng tạm thời bỏ qua cho đơn giản)
    socket.emit('status', botStatus);
    if (logHistory.length > 0) socket.emit('history', logHistory.join(''));
});

function addLog(data) {
    const msg = data.toString();
    logHistory.push(msg);
    if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift();
    io.emit('log', msg);
}

// Các API API
app.get('/api/data', requireLogin, (req, res) => {
    let config = {};
    if (fs.existsSync(CONFIG_PATH)) {
        try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
    }
    res.json({ config: config, status: botStatus });
});

app.post('/api/config', requireLogin, (req, res) => {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 4));
        res.json({ success: true, message: 'Đã lưu cấu hình!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/input', requireLogin, (req, res) => {
    const { command } = req.body;
    if (botProcess && botProcess.stdin) {
        try { botProcess.stdin.write(command + "\n"); res.json({ success: true }); } 
        catch (err) { res.status(500).json({ success: false, error: err.message }); }
    } else { res.status(400).json({ success: false, message: 'Bot chưa chạy' }); }
});

app.post('/api/control', requireLogin, (req, res) => {
    const action = req.body.action;
    if (action === 'start') { startBot(); res.json({ success: true }); }
    else if (action === 'stop') { stopBot(); res.json({ success: true }); }
});

function startBot() {
    if (botProcess) return;
    addLog(`\x1b[36m[SYSTEM] Starting...\x1b[0m\r\n`);
    botProcess = spawn(BOT_COMMAND, BOT_ARGS, { stdio: 'pipe' });
    botProcess.stdout.on('data', (data) => addLog(data));
    botProcess.stderr.on('data', (data) => addLog(data));
    botProcess.on('close', (code) => {
        addLog(`\x1b[33m[SYSTEM] Stopped. Code: ${code}\x1b[0m\r\n`);
        botProcess = null; botStatus = 'stopped'; io.emit('status', botStatus);
    });
    botStatus = 'running'; io.emit('status', botStatus);
}

function stopBot() {
    if (botProcess) {
        addLog(`\x1b[33m[SYSTEM] Stopping...\x1b[0m\r\n`);
        botProcess.kill('SIGINT');
    }
}

httpServer.listen(3000, () => { console.log('Web Interface running at: http://localhost:3000'); });
