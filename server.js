import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Cấu hình đường dẫn ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// --- CẤU HÌNH ĐƯỜNG DẪN MỚI (QUAN TRỌNG) ---
// Dùng '..' để lùi ra khỏi thư mục hiện tại, sau đó vào b2ki-ados
const CONFIG_PATH = path.join(__dirname, '..', 'b2ki-ados', 'data.json');

const BOT_COMMAND = 'node';
const BOT_ARGS = ['dest/index.js']; 

let botProcess = null;
let botStatus = 'stopped';
const MAX_LOG_HISTORY = 2000;
let logHistory = [];

app.use(express.static('public')); 
app.use(express.json());

// --- XỬ LÝ SOCKET ---
io.on('connection', (socket) => {
    socket.emit('status', botStatus);
    if (logHistory.length > 0) {
        socket.emit('history', logHistory.join(''));
    }
});

function addLog(data) {
    const msg = data.toString();
    logHistory.push(msg);
    if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift();
    io.emit('log', msg);
}

// 1. API lấy cấu hình (Debug Path)
app.get('/api/data', (req, res) => {
    let config = {};
    
    // In ra đường dẫn tuyệt đối để bạn kiểm tra
    console.log(`[DEBUG] Server đang tìm config tại: ${CONFIG_PATH}`);

    if (fs.existsSync(CONFIG_PATH)) {
        try { 
            const fileContent = fs.readFileSync(CONFIG_PATH, 'utf8');
            config = JSON.parse(fileContent);
            console.log(`[OK] Đã đọc thành công file data.json!`);
        } catch (e) {
            console.error(`[LỖI] File tồn tại nhưng nội dung lỗi:`, e.message);
            config = { "ERROR": "File JSON lỗi cú pháp." };
        }
    } else {
        console.error(`[LỖI] Không tìm thấy file tại đường dẫn trên!`);
        config = { "ERROR": `Không tìm thấy file: ${CONFIG_PATH}` };
    }
    
    res.json({ config: config, status: botStatus });
});

// 2. API lưu cấu hình
app.post('/api/config', (req, res) => {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 4));
        console.log(`[INFO] Đã lưu config vào ${CONFIG_PATH}`);
        res.json({ success: true, message: 'Đã lưu cấu hình thành công!' });
    } catch (error) {
        console.error(`[LỖI GHI FILE]`, error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. API gửi lệnh
app.post('/api/input', (req, res) => {
    const { command } = req.body;
    if (botProcess && botProcess.stdin) {
        try {
            botProcess.stdin.write(command + "\n");
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    } else {
        res.status(400).json({ success: false, message: 'Bot chưa chạy' });
    }
});

// 4. Start Bot
function startBot() {
    if (botProcess) return;
    addLog(`\x1b[36m[SYSTEM] Đang khởi động...\x1b[0m\r\n`);
    botProcess = spawn(BOT_COMMAND, BOT_ARGS, { stdio: 'pipe' });

    botProcess.stdout.on('data', (data) => addLog(data));
    botProcess.stderr.on('data', (data) => addLog(data));

    botProcess.on('close', (code) => {
        addLog(`\x1b[33m[SYSTEM] Bot đã dừng. Code: ${code}\x1b[0m\r\n`);
        botProcess = null;
        botStatus = 'stopped';
        io.emit('status', botStatus);
    });
    
    botStatus = 'running';
    io.emit('status', botStatus);
}

// 5. Stop Bot
function stopBot() {
    if (botProcess) {
        addLog(`\x1b[33m[SYSTEM] Đang dừng...\x1b[0m\r\n`);
        botProcess.kill('SIGINT');
    }
}

app.post('/api/control', (req, res) => {
    const action = req.body.action;
    if (action === 'start') { startBot(); res.json({ success: true }); }
    else if (action === 'stop') { stopBot(); res.json({ success: true }); }
});

httpServer.listen(3000, () => {
    console.log('Web Interface: http://localhost:3000');
});

