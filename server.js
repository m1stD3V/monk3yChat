// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// Mock Discord Server Database Structure
const jungleServers = {
  "canopy-hub": {
    name: "Canopy Hub 🌳",
    textChannels: { "general": "💬 general-chat", "banana-talk": "🍌 banana-market" },
    voiceChannels: { "lounge": "🔊 The Lounge", "raid-room": "🦍 Gorilla Raid" }
  },
  "research-lab": {
    name: "Chimp Research Lab 🧪",
    textChannels: { "intel": "📑 brain-size-trends" },
    voiceChannels: { "lab-meeting": "🔊 Lab Meeting" }
  }
};

// Tracks state: socketId -> { serverId, channelId, userName }
const userRegistry = {};

io.on('connection', (socket) => {
  console.log(`🐒 Monkey swung in: ${socket.id}`);

  // Bootstrap data for frontend layout
  socket.emit('init-discord-data', { servers: jungleServers });

  socket.on('join-voice', ({ serverId, channelId, userName }) => {
    // Disconnect from any previous voice channel first
    leavePreviousVoice(socket);

    const internalRoomId = `vc-${serverId}-${channelId}`;
    socket.join(internalRoomId);

    userRegistry[socket.id] = { serverId, channelId, userName, internalRoomId };

    // Fetch all other monkeys currently sitting in this voice channel
    const participants = Object.keys(userRegistry).filter(
      id => id !== socket.id && userRegistry[id].internalRoomId === internalRoomId
    );

    // Send the newcomer a list of everyone already in the room
    socket.emit('current-room-monkeys', participants.map(id => ({ id, name: userRegistry[id].userName })));

    // Broadcast to existing members that a new peer joined
    socket.to(internalRoomId).emit('peer-joined-voice', {
      id: socket.id,
      name: userName
    });

    console.log(`🔊 ${userName} joined voice room: ${internalRoomId}`);
  });

  // Targeted WebRTC Signal Router (Peer-to-Peer Handshake)
  socket.on('webrtc-signal', ({ targetPeerId, signal }) => {
    io.to(targetPeerId).emit('webrtc-signal', {
      senderPeerId: socket.id,
      signal: signal
    });
  });

  socket.on('send-text-msg', ({ serverId, channelId, text, userName }) => {
    const textRoomId = `tx-${serverId}-${channelId}`;
    io.to(textRoomId).emit('receive-text-msg', {
      senderId: socket.id,
      userName,
      text
    });
  });

  socket.on('join-text', ({ serverId, channelId }) => {
    // Leave old text rooms
    const currentRooms = Array.from(socket.rooms);
    currentRooms.forEach(r => { if (r.startsWith('tx-')) socket.leave(r); });

    socket.join(`tx-${serverId}-${channelId}`);
  });

  socket.on('leave-voice', () => leavePreviousVoice(socket));
  socket.on('disconnect', () => {
    leavePreviousVoice(socket);
    delete userRegistry[socket.id];
  });
});

function leavePreviousVoice(socket) {
  const userData = userRegistry[socket.id];
  if (userData && userData.internalRoomId) {
    socket.to(userData.internalRoomId).emit('peer-left-voice', socket.id);
    socket.leave(userData.internalRoomId);
    userData.internalRoomId = null;
    userData.channelId = null;
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🍌 Discord-Monkey structure running on port ${PORT}`));
