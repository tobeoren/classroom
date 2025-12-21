const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// --- MEMORY STORAGE ---
// Format: { roomId: { sensei: socketId, users: [], currentQuestion: {}, isAnswerHidden: true, password: '', isPublic: true } }
let rooms = {};

// Helper: Ambil list user di dalam voice room
function getVoiceUsers(roomId) {
    const room = rooms[roomId];
    if (!room) return [];
    // Filter user yang sedang join voice
    return room.users.filter(u => u.isInVoice).map(u => u.id);
}

io.on('connection', (socket) => {
    
    // 1. BUAT KELAS (Sensei)
    socket.on('create_room', ({ name, roomId, password }) => {
        if (rooms[roomId]) {
            return socket.emit('error_msg', '❌ Room ID sudah digunakan!');
        }

        rooms[roomId] = {
            sensei: socket.id,
            senseiName: name,
            users: [],
            password: password || null,
            currentQuestion: { q: '...', a: [], m: '...' },
            isAnswerHidden: true, // Default hidden
            isPublic: !password
        };

        // Masukkan Sensei ke list users juga biar seragam
        rooms[roomId].users.push({ id: socket.id, name: name, role: 'sensei', isInVoice: false });

        socket.join(roomId);
        // Kirim konfirmasi ke pembuat
        socket.emit('room_joined', { 
            role: 'sensei', 
            roomId, 
            name,
            currentQuestion: rooms[roomId].currentQuestion,
            isAnswerHidden: true
        });

        io.emit('update_public_rooms', getPublicRooms());
    });

    // 2. GABUNG KELAS (Siswa)
    socket.on('join_room', ({ name, roomId, password }) => {
        const room = rooms[roomId];

        if (!room) return socket.emit('error_msg', '❌ Room tidak ditemukan.');
        if (room.password && room.password !== password) return socket.emit('error_msg', '🔒 Password salah!');

        room.users.push({ id: socket.id, name: name, role: 'student', isInVoice: false });
        socket.join(roomId);

        // Kirim status terkini ke siswa (Sync)
        socket.emit('room_joined', { 
            role: 'student', 
            roomId, 
            name,
            currentQuestion: room.currentQuestion,
            isAnswerHidden: room.isAnswerHidden
        });

        // Notifikasi ke Room
        io.to(roomId).emit('chat_message', { type: 'sys', text: `👋 ${name} bergabung.` });
        io.to(roomId).emit('update_user_count', room.users.length + 1); // +1 Sensei
    });

    // 3. UPDATE MATERI (Sensei Only)
    socket.on('update_content', ({ roomId, question, hideAnswer }) => {
        const room = rooms[roomId];
        if (!room || room.sensei !== socket.id) return;

        room.currentQuestion = question;
        room.isAnswerHidden = hideAnswer;

        io.to(roomId).emit('content_updated', {
            question: room.currentQuestion,
            isAnswerHidden: room.isAnswerHidden
        });
    });

    // 4. TOGGLE JAWABAN (Sensei Only)
    socket.on('toggle_answer', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.sensei !== socket.id) return;

        room.isAnswerHidden = !room.isAnswerHidden;
        io.to(roomId).emit('answer_toggled', room.isAnswerHidden);
    });

    // 5. CHAT & JAWABAN
    socket.on('send_message', ({ roomId, message, sender, role }) => {
        const room = rooms[roomId];
        if (!room) return;

        // Cek Jawaban
        const cleanMsg = message.trim().toLowerCase();
        const answers = room.currentQuestion.a.map(a => a.toLowerCase());

        if (role === 'student' && answers.includes(cleanMsg)) {
            // Jawaban Benar
            io.to(roomId).emit('chat_message', { 
                type: 'sys-succ', 
                text: `🎉 ${sender} menjawab BENAR!`,
                sender: 'SISTEM'
            });
        } else {
            // Chat Biasa
            io.to(roomId).emit('chat_message', { 
                type: role === 'sensei' ? 'sensei' : 'other', 
                text: message,
                sender: sender,
                role: role
            });
        }
    });

    socket.on('get_public_rooms', () => { socket.emit('update_public_rooms', getPublicRooms()); });


    // --- FITUR BARU: VOICE ROOM (WebRTC Signaling) ---
    
    // 1. User Mengaktifkan Mic (Join Voice)
    socket.on('join_voice', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        // Tandai user ini sedang di voice
        const user = room.users.find(u => u.id === socket.id);
        if (user) user.isInVoice = true;

        // Beritahu user lain di room ini untuk "menelepon" user baru ini
        // Kita kirim list user lain yang SUDAH ada di voice, biar user baru yang initiate call
        const usersInVoice = room.users.filter(u => u.isInVoice && u.id !== socket.id);
        socket.emit('voice_users_list', usersInVoice.map(u => u.id));
    });

    // 2. User Mematikan Mic (Leave Voice)
    socket.on('leave_voice', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const user = room.users.find(u => u.id === socket.id);
        if (user) user.isInVoice = false;
        
        // Beritahu semua orang untuk memutus koneksi dengan user ini
        socket.to(roomId).emit('user_left_voice', socket.id);
    });

    // 3. Relay Signal WebRTC (Offer, Answer, ICE Candidate)
    socket.on('voice_signal', ({ targetId, signalData }) => {
        io.to(targetId).emit('voice_signal', {
            senderId: socket.id,
            signalData: signalData
        });
    });

    // 6. REQUEST PUBLIC LIST
    socket.on('get_public_rooms', () => {
        socket.emit('update_public_rooms', getPublicRooms());
    });

    // 7. DISCONNECT
    socket.on('disconnect', () => {
        // Cari user ada di room mana
        for (const roomId in rooms) {
            const room = rooms[roomId];
            
            // Jika Sensei keluar
            if (room.sensei === socket.id) {
                io.to(roomId).emit('force_leave', 'Sensei telah menutup kelas.');
                delete rooms[roomId];
                io.emit('update_public_rooms', getPublicRooms());
                break;
            }

            // Jika Siswa keluar
            const index = room.users.findIndex(u => u.id === socket.id);
            if (index !== -1) {
                const user = room.users[index];
                room.users.splice(index, 1);
                io.to(roomId).emit('chat_message', { type: 'sys', text: `➖ ${user.name} keluar.` });
                io.to(roomId).emit('update_user_count', room.users.length + 1);
                break;
            }
        }
    });
});

function getPublicRooms() {
    return Object.keys(rooms)
        .filter(id => rooms[id].isPublic)
        .map(id => ({
            id: id,
            name: rooms[id].senseiName + "'s Class",
            users: rooms[id].users.length + 1
        }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
