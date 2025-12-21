const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const xss = require("xss"); // Library sanitasi sederhana

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve file statis (HTML/CSS/JS)
app.use(express.static('public'));

// --- MEMORY STORAGE ---
// Format: { roomId: { sensei: socketId, users: [], currentContent: {}, isAnswerHidden: true, password: null } }
let rooms = {};

io.on('connection', (socket) => {
    
    // 1. CREATE CLASS (Sensei)
    socket.on('create_class', ({ name, roomId, password }) => {
        if (rooms[roomId]) {
            return socket.emit('error_msg', '❌ Room ID sudah digunakan!');
        }

        rooms[roomId] = {
            sensei: socket.id,
            senseiName: xss(name),
            users: [],
            password: password || null, // null = public
            currentContent: { q: '...', a: [], m: '...' },
            isAnswerHidden: true,
            isPrivate: !!password
        };

        socket.join(roomId);
        socket.emit('class_created', { 
            roomId, 
            isPrivate: !!password,
            userCount: 1 
        });

        // Broadcast list public room ke semua orang di lobi
        io.emit('update_public_rooms', getPublicRooms());
    });

    // 2. JOIN CLASS (Siswa)
    socket.on('join_class', ({ name, roomId, password }) => {
        const room = rooms[roomId];

        if (!room) return socket.emit('error_msg', '❌ Room tidak ditemukan.');
        
        // Cek Password
        if (room.isPrivate && room.password !== password) {
            return socket.emit('error_msg', '🔒 Password salah!');
        }

        room.users.push({ id: socket.id, name: xss(name), score: 0 });
        socket.join(roomId);

        // Kirim state saat ini ke siswa yang baru join (Sync)
        socket.emit('class_joined', {
            roomId,
            senseiName: room.senseiName,
            currentContent: room.currentContent,
            isAnswerHidden: room.isAnswerHidden
        });

        // Notifikasi ke Room
        io.to(roomId).emit('system_msg', `👋 ${xss(name)} bergabung.`);
        io.to(roomId).emit('update_user_count', room.users.length + 1); // +1 Sensei
    });

    // 3. UPDATE MATERI (Hanya Sensei)
    socket.on('update_content', ({ roomId, content, hideAnswer }) => {
        const room = rooms[roomId];
        if (!room || room.sensei !== socket.id) return; // Security Check

        room.currentContent = content;
        room.isAnswerHidden = hideAnswer;

        // Broadcast ke semua di room
        io.to(roomId).emit('content_updated', {
            content: room.currentContent,
            isAnswerHidden: room.isAnswerHidden
        });
    });

    // 4. TOGGLE JAWABAN (Hanya Sensei)
    socket.on('toggle_answer', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.sensei !== socket.id) return;

        room.isAnswerHidden = !room.isAnswerHidden;
        io.to(roomId).emit('answer_toggled', room.isAnswerHidden);
    });

    // 5. CHAT & JAWABAN SISWA
    socket.on('send_chat', ({ roomId, message, sender, role }) => {
        const room = rooms[roomId];
        if (!room) return;

        // Cek apakah ini jawaban benar (Logic Server-side)
        const cleanMsg = xss(message).trim().toLowerCase();
        let isCorrect = false;

        // Jika siswa menjawab dan sesuai kunci jawaban
        if (role === 'student' && room.currentContent.a && room.currentContent.a.includes(cleanMsg)) {
            isCorrect = true;
            io.to(roomId).emit('chat_received', {
                sender: "SISTEM",
                message: `🎉 ${xss(sender)} menjawab BENAR! (${room.currentContent.a[0]})`,
                type: 'system-success'
            });
        } else {
            // Chat biasa
            io.to(roomId).emit('chat_received', {
                sender: xss(sender),
                message: xss(message),
                role: role,
                type: 'normal'
            });
        }
    });

    // 6. REQUEST PUBLIC ROOMS
    socket.on('get_public_rooms', () => {
        socket.emit('update_public_rooms', getPublicRooms());
    });

    // 7. DISCONNECT
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            
            // Jika Sensei keluar -> Bubarkan Room
            if (room.sensei === socket.id) {
                io.to(roomId).emit('class_ended', 'Sensei telah meninggalkan kelas.');
                delete rooms[roomId];
                io.emit('update_public_rooms', getPublicRooms());
                break;
            }

            // Jika Siswa keluar
            const userIndex = room.users.findIndex(u => u.id === socket.id);
            if (userIndex !== -1) {
                const user = room.users[userIndex];
                room.users.splice(userIndex, 1);
                io.to(roomId).emit('system_msg', `➖ ${user.name} keluar.`);
                io.to(roomId).emit('update_user_count', room.users.length + 1);
                break;
            }
        }
    });
});

// Helper: Ambil room yang tidak dipassword
function getPublicRooms() {
    return Object.keys(rooms)
        .filter(id => !rooms[id].isPrivate)
        .map(id => ({
            id: id,
            sensei: rooms[id].senseiName,
            users: rooms[id].users.length + 1
        }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Manabu Server running on port ${PORT}`));