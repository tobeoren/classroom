const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    pingTimeout: 60000, // Tunggu 60 detik sebelum dianggap mati
    pingInterval: 25000 // Kirim ping setiap 25 detik
});

app.use(express.static(path.join(__dirname, 'public')));

// --- MEMORY STORAGE ---
// Format: { roomId: { sensei: socketId, users: [], currentQuestion: {}, isAnswerHidden: true, password: '', isPublic: true } }
let rooms = {};
let tempBans = {};

// Helper: Ambil list user di dalam voice room
function getVoiceParticipants(roomId) {
    const room = rooms[roomId];
    if (!room) return [];
    // Kembalikan nama dan role untuk ditampilkan di Avatar
    return room.users
        .filter(u => u.isInVoice)
        .map(u => ({ id: u.id, name: u.name, role: u.role }));
}

io.on('connection', (socket) => {
    
    // 1. BUAT KELAS (Sensei)
    socket.on('create_room', ({ name, roomId, password, deviceId }) => { // TAMBAHKAN deviceId di sini
    // CEK RECONNECT: Jika room ada, cek apakah namanya sama
        if (rooms[roomId]) {
            const room = rooms[roomId];
                if (room.senseiName === name) {
                    // VERIFIKASI PERANGKAT: Jika sidik jari cocok, izinkan update socket
                    if (room.senseiDeviceId === deviceId) {
                        room.sensei = socket.id;
                        const sIdx = room.users.findIndex(u => u.name === name);
                        if(sIdx !== -1) room.users[sIdx].id = socket.id;

                        socket.join(roomId);
                        return socket.emit('room_joined', { 
                            role: 'sensei', roomId, name,
                            currentQuestion: room.currentQuestion,
                            isAnswerHidden: room.isAnswerHidden
                        });
                    } else {
                        // SIDIK JARI BEDA: Tolak akses pembajakan!
                        return socket.emit('error_msg', '⚠️ KEAMANAN: Identitas Sensei ini sudah terkunci pada perangkat lain!');
                    }
                }
                return socket.emit('error_msg', '❌ Room ID sudah digunakan oleh Sensei lain!');
            }

        rooms[roomId] = {
            sensei: socket.id,
            senseiName: name,
            senseiDeviceId: deviceId,
            users: [],
            password: password || null,
            currentQuestion: { q: '...', a: [], m: '...' },
            isAnswerHidden: true, // Default hidden
            isPublic: !password
        };

        // Masukkan Sensei ke list users juga biar seragam
        rooms[roomId].users.push({ id: socket.id, name: name, role: 'sensei', isInVoice: false, deviceId});

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
    socket.on('join_room', ({ name, roomId, password, deviceId }) => { // TAMBAHKAN deviceId di sini
        const room = rooms[roomId];
        if (!room) return socket.emit('error_msg', '❌ Room Not Found');

        // Cek Kick Permanen (Berdasarkan Fingerprint atau Nama)
        if (room.bannedDevices && room.bannedDevices.includes(deviceId)) {
            return socket.emit('error_msg', '🚫 Anda dilarang masuk ke kelas ini secara permanen.');
        }
        const banKey = `${roomId}_${deviceId}`;
        if (tempBans[banKey] && Date.now() < tempBans[banKey]) {
            const remaining = Math.ceil((tempBans[banKey] - Date.now()) / 60000);
            return socket.emit('error_msg', `⏰ Anda masih dilarang masuk selama ${remaining} menit lagi.`);
        }
        if (room.password && room.password !== password) return socket.emit('error_msg', '🔒 Wrong Password/Salah');
        
        if (name === room.senseiName) {
            return socket.emit('error_msg', '❌ Nama ini adalah nama Sensei, gunakan nama lain!');
        }

        const existingUser = room.users.find(u => u.name === name);
        if (existingUser) {
            // Validasi Fingerprint Siswa
            if (existingUser.deviceId !== deviceId) {
                return socket.emit('error_msg', '❌ Nama sudah digunakan siswa lain, pilih nama unik!');
            }
            existingUser.id = socket.id;
            socket.join(roomId);
            return socket.emit('room_joined', { 
                role: 'student', roomId, name, 
                currentQuestion: room.currentQuestion, 
                isAnswerHidden: room.isAnswerHidden 
            });
        }
        
        room.users.push({ id: socket.id, name: name, deviceId: deviceId, role: 'student', isInVoice: false });
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
        io.to(roomId).emit('chat_message', { 
            type: 'sys', 
            msgCode: 'join', // Kode untuk diterjemahkan client
            user: name 
        });
        io.to(roomId).emit('update_user_count', room.users.length);
        socket.emit('voice_status_update', getVoiceParticipants(roomId));
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
                msgCode: 'correct',
                sender: 'SISTEM',
                user: sender
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

    // Aksi Kick
    socket.on('admin_kick_user', ({ roomId, targetSocketId, type, duration, deviceId }) => {
        const room = rooms[roomId];
        if (!room || room.sensei !== socket.id) return;

        if (type === 'permanent') {
            if (!room.bannedDevices) room.bannedDevices = [];
            room.bannedDevices.push(deviceId);
            io.to(targetSocketId).emit('force_leave', '🚫 Anda telah di-banned permanen.');
        } else {
            const minutes = parseInt(duration) || 1;
            const banKey = `${roomId}_${deviceId}`;
            tempBans[banKey] = Date.now() + (minutes * 60000); // Set waktu buka ban
            io.to(targetSocketId).emit('force_leave', `⏰ Anda dikeluarkan selama ${minutes} menit.`);
        }
        
        // Hapus user dari memory room segera
        const idx = room.users.findIndex(u => u.id === targetSocketId);
        if(idx !== -1) room.users.splice(idx, 1);

        io.to(roomId).emit('update_user_count', room.users.length);
        io.to(roomId).emit('update_student_manager_list', room.users);
    });

    // Aksi Mute Remote
    socket.on('admin_toggle_mute', ({ roomId, targetSocketId, muteState }) => {
        const room = rooms[roomId];
        if (!room || room.sensei !== socket.id) return;

        // Update state di server agar data yang dikirim ke Sensei selalu terbaru
        const user = room.users.find(u => u.id === targetSocketId);
        if (user) user.isMutedBySensei = muteState; // Kita tambah properti baru

        io.to(targetSocketId).emit('remote_mute_control', muteState);
        io.to(roomId).emit('update_student_manager_list', room.users);
    });

    // Request daftar siswa untuk manager
    socket.on('get_student_list', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.sensei !== socket.id) return;
        
        socket.emit('update_student_manager_list', room.users);
    });

    // --- FITUR BARU: VOICE ROOM (WebRTC Signaling) ---
    
    // 1. User Mengaktifkan Mic (Join Voice)
    socket.on('join_voice', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        // 1. Update status user
        const user = room.users.find(u => u.id === socket.id);
        if (user) user.isInVoice = true;

        // 2. Beritahu WebRTC Signaling (untuk koneksi audio)
        const usersInVoice = room.users.filter(u => u.isInVoice && u.id !== socket.id);
        socket.emit('voice_users_list', usersInVoice.map(u => u.id));

        // 3. Beritahu UI Semua Orang (untuk update Avatar Bubble)
        io.to(roomId).emit('voice_status_update', getVoiceParticipants(roomId));

        io.to(roomId).emit('update_student_manager_list', room.users);
    });

    // 2. User Mematikan Mic (Leave Voice)
    socket.on('leave_voice', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        const user = room.users.find(u => u.id === socket.id);
        if (user) user.isInVoice = false;
        
        // Putus koneksi audio
        socket.to(roomId).emit('user_left_voice', socket.id);
        
        // Update UI Avatar
        io.to(roomId).emit('voice_status_update', getVoiceParticipants(roomId));

        io.to(roomId).emit('update_student_manager_list', room.users);
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
            if (room.sensei === socket.id) {
                console.log(`Sensei disconnected from ${roomId}. Waiting for reconnect...`);
                
                // Beri waktu 1 menit sebelum benar-benar dihapus
                setTimeout(() => {
                    // Cek apakah dalam 60 detik sensei SUDAH update socket.id-nya
                    if (rooms[roomId] && rooms[roomId].sensei === socket.id) {
                        io.to(roomId).emit('force_leave', 'Sensei has closed the class.');
                        delete rooms[roomId];
                        io.emit('update_public_rooms', getPublicRooms());
                    }
                }, 60000); 
                break;
            }

            // Jika Siswa keluar
            const index = room.users.findIndex(u => u.id === socket.id);
            if (index !== -1) {
                const user = room.users[index];
                const studentSocketId = socket.id;

                // Beri waktu 15-20 detik sebelum benar-benar dianggap keluar
                setTimeout(() => {
                    // Cek apakah siswa tersebut BELUM masuk lagi dengan socket ID baru
                    const currentRoom = rooms[roomId];
                    if (currentRoom) {
                        const isStillGone = !currentRoom.users.some(u => u.name === user.name);
                        
                        if (isStillGone) {
                            if (user.isInVoice) {
                                socket.to(roomId).emit('user_left_voice', studentSocketId);
                            }
                            
                            // Hapus dari daftar hanya jika memang tidak kembali
                            const finalIdx = currentRoom.users.findIndex(u => u.id === studentSocketId);
                            if (finalIdx !== -1) currentRoom.users.splice(finalIdx, 1);

                            io.to(roomId).emit('chat_message', { 
                                type: 'sys', 
                                msgCode: 'leave', 
                                user: user.name 
                            });
                            io.to(roomId).emit('update_user_count', currentRoom.users.length);
                            io.to(roomId).emit('voice_status_update', getVoiceParticipants(roomId));
                        }
                    }
                }, 7000); // 7 detik masa tenggang
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
