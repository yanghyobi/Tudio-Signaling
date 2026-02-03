const { Server } = require("socket.io");
const { Socket } = require("socket.io-client");
const axios = require('axios');

const rooms = {};

function initializeSignaling(server, ioOptions, httpsAgent) {
    const io = new Server(server, ioOptions);

    const SPRING_BOOT_API_URL = process.env.SPRING_BOOT_API_URL;

    io.use((socket, next) => {
        try {
            const token = socket.handshake.auth.token;
                   
            if (token) {
                const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
                
                socket.user = {
                    id: payload.memNo || "unknown_id",
                    name: payload.memName || "알 수 없음"
                };
                console.log(`[Auth Bypass] 사용자 인증 성공: ${socket.user.name}`);
            } else {
                socket.user = { id: "guest_" + socket.id, name: "손님" };
            }

            next();
        } catch (error) {
            console.error("인증 처리 중 에러 발생:", error.message);
            socket.user = { id: "error_user", name: "접속오류유저" };
            next();
        }
    });

    io.on("connection", (socket) => {
        const { id: memId, name: memName } = socket.user; 
        console.log(`Connected: ${socket.id} (User: ${memName}, ID: ${memId})`);

        const getUniqueMeetingCount = (roomId) => {
            if (!rooms[roomId]) return 0;
            
            const meetingParticipants = rooms[roomId].participants.filter(p => p.userType === "MEETING");
            const uniqueMemIds = new Set(meetingParticipants.map(p => p.memId));
            
            return uniqueMemIds.size;
        };

        socket.on("join_room", async ({ roomId, userType }) => {
            console.log(`📥 [Join 요청] ${memName} (${socket.id}) → Room: ${roomId}, Type: ${userType}`);

            socket.roomId = roomId;
            socket.userType = userType;
            
            if (!rooms[roomId]) {
                rooms[roomId] = { participants: [], roomTitle: "" };
                console.log(`🆕 새 방 생성: ${roomId}`);
            }

            const isAlreadyInRoom = rooms[roomId].participants.some(p => p.socketId === socket.id);
            if (isAlreadyInRoom) {
                console.log(`⚠️ [Join] ${memName}는 이미 ${roomId}에 있음. Skip!`);
                return;
            }

            const usersInRoom = rooms[roomId].participants.filter(p => p.socketId !== socket.id);
            console.log(`👥 기존 유저 ${usersInRoom.length}명:`, usersInRoom.map(u => `${u.name}(${u.socketId})`));

            const newUser = { 
                socketId: socket.id, 
                memId: memId, 
                name: memName,
                userType: userType  
            };
            
            rooms[roomId].participants.push(newUser);
            socket.join(roomId);

            if (rooms[roomId].roomTitle) {
                socket.emit("room_info", { roomName: rooms[roomId].roomTitle });
            }
        
            console.log(`✅ [Join 완료] ${memName} (${socket.id}) → Room: ${roomId} (총 ${rooms[roomId].participants.length}명)`);

            io.to(roomId).emit("participant_count", {
                count: getUniqueMeetingCount(roomId) 
            });
            
            socket.emit("all_users", usersInRoom);
            console.log(`📤 [all_users] ${memName}에게 기존 유저 ${usersInRoom.length}명 전송`);

            socket.to(roomId).emit("user_joined", newUser);
            console.log(`📢 [user_joined] 방에 ${memName} 입장 알림`);
        });

        socket.on("set_room_name", ({ roomId, roomName }) => {
            if (rooms[roomId]) {
                rooms[roomId].roomTitle = roomName;
                
                io.to(roomId).emit("room_info", { roomName: roomName });
                console.log(`📡 [Sync] Room ${roomId} 이름 설정됨: ${roomName}`);
            }
        });

        socket.on("offer", ({ targetId, offer }) => {
            console.log(`[Signaling] Offer from ${memId} to ${targetId}`);
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) {
                io.to(targetId).emit("offer", { from: socket.id, offer });
                console.log(`✅ Offer 전송 성공`);
            } else {
                console.error(`❌ 대상 소켓 없음: ${targetId}`);
            }
        });

        socket.on("answer", ({targetId, answer}) => {
            console.log(`[Signaling] Answer from ${memId} to ${targetId}`);
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) {
                io.to(targetId).emit("answer", { from: socket.id, answer });
                console.log(`✅ Answer 전송 성공`);
            } else {
                console.error(`❌ 대상 소켓 없음: ${targetId}`);
            }
        });
        socket.on("ice", ({ targetId, candidate }) => {
            io.to(targetId).emit("ice", { from: socket.id, candidate });
        });

        // 채팅 기능
        socket.on("chat_message", ({ roomId, message }) => {
            if (!message || message.trim() === "") return;

            const chatData = {
                sender: memName,        // 보낸 사용자 이름
                memId: memId,           // 보낸 사용자 ID
                message: message,       // 보낸 내용
                timestamp: new Date(),  // 전송 시간
                socketId: socket.id
            };

            // 방에 있는 모든 사람에게 전송
            io.to(roomId).emit("chat_message", chatData);
            console.log(`[Chat] Room ${roomId} - ${memId}: ${message}`);
        });

        // 미디어 상태 변경 
        socket.on("media_state_change", ({ roomId, type, enabled }) => {
            socket.to(roomId).emit("media_state_change", {
                socketId: socket.id, 
                type: type,          
                enabled: enabled    
            });
            
            console.log(`[Media] Room: ${roomId} - ${memName}(${socket.id}) ${type} is now ${enabled ? 'ON' : 'OFF'}`);
        });

        // 연결 해제 
        socket.on("disconnect", () => {
            const roomId = socket.roomId;
            if (!roomId || !rooms[roomId]) return;

            console.log(`Disconnected: ${memName} (${socket.id})`);

            const room = rooms[roomId];
            const leavingUser = room.participants.find(p => p.socketId === socket.id);

            if (leavingUser) {
                console.log(`[Disconnect] ${leavingUser.name} (${socket.id}) 퇴장`);

                room.participants = room.participants.filter(p => p.socketId !== socket.id);
                
                io.to(roomId).emit("user_disconnected_report", { 
                    memId: leavingUser.memId 
                });

                const currentMeetingCount = getUniqueMeetingCount(roomId);

                io.to(roomId).emit("participant_count", {
                    count: currentMeetingCount
                });

                socket.broadcast.to(roomId).emit("user_left", { socketId: socket.id });

                if (currentMeetingCount === 0) {
                    console.log(`🚀 [Meeting Empty] ${roomId} 종료`);
                    io.to(roomId).emit("trigger_close_room", { roomId: roomId });
                    delete rooms[roomId];
                }
            }
        });
    });
}

module.exports = { initializeSignaling };