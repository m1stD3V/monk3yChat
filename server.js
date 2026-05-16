// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*" },
  pingTimeout: 60000, // Increase to 60 seconds
  pingInterval: 25000 // Increase interval to 25 seconds
});

app.use(express.static(path.join(__dirname, 'public')));

// Credentials Loader
const loadCredentials = () => {
    const authEnv = process.env.AUTH_CREDENTIALS;
    if (!authEnv) {
        console.warn("WARNING: AUTH_CREDENTIALS environment variable not set.");
        return [];
    }
    return authEnv.split(';').filter(line => line.includes(':')).map(line => {
        const [username, password] = line.split(':');
        return { username: username.trim(), password: password.trim() };
    });
};

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

  // Authentication
  socket.on('authenticate', ({ username, password }) => {
    const credentials = loadCredentials();
    console.log(`Debug: Attempting login for ${username}`);
    const user = credentials.find(c => c.username === username && c.password === password);
    if (user) {
      console.log(`Debug: Login successful for ${username}`);
      socket.emit('auth-result', { success: true });
    } else {
      console.log(`Debug: Login failed for ${username}`);
      socket.emit('auth-result', { success: false });
    }
  });

  // Bootstrap data for frontend layout
  socket.emit('init-discord-data', { servers: jungleServers });

  socket.on('join-voice', ({ serverId, channelId, userName }) => {
    console.log(`Debug: Received join-voice request for ${userName} in ${serverId}/${channelId}`);
    // Disconnect from any previous voice channel first
    leavePreviousVoice(socket);

    const internalRoomId = `vc-${serverId}-${channelId}`;
    socket.join(internalRoomId);

    userRegistry[socket.id] = { serverId, channelId, userName, internalRoomId };
    console.log(`Debug: UserRegistry after registering ${socket.id}:`, Object.keys(userRegistry));

    // Fetch all other monkeys currently sitting in this voice channel
    const participants = Object.keys(userRegistry).filter(
      id => id !== socket.id && userRegistry[id].internalRoomId === internalRoomId
    );
    console.log(`Debug: Participants in ${internalRoomId}:`, participants);

    // Send the newcomer a list of everyone already in the room
    socket.emit('current-room-monkeys', participants.map(id => ({ id, name: userRegistry[id].userName })));

    // Broadcast to existing members that a new peer joined
    console.log(`Debug: Broadcasting peer-joined-voice for ${socket.id} to ${internalRoomId}`);
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
  socket.on('disconnect', (reason) => {
    console.log(`Debug: User ${socket.id} disconnected. Reason: ${reason}`);
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

// Graceful shutdown for production (Render/K8s)
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
