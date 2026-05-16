// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── CREDENTIALS + ROLES ─────────────────────────────────
// AUTH_CREDENTIALS format: "user:pass:role;user2:pass2:role2"
// Roles: owner | admin | member (default)
const loadCredentials = () => {
  const authEnv = process.env.AUTH_CREDENTIALS;
  if (!authEnv) {
    console.warn('WARNING: AUTH_CREDENTIALS not set.');
    return [];
  }
  return authEnv.split(';').filter(line => line.includes(':')).map(line => {
    const parts = line.trim().split(':');
    return {
      username: parts[0].trim(),
      password: parts[1].trim(),
      role: (parts[2] || 'member').trim()
    };
  });
};

// ─── SERVER DATABASE ─────────────────────────────────────
// Deep-clone so runtime mutations don't affect the original definition
const defaultServers = {
  'canopy-hub': {
    name: 'Canopy Hub 🌳',
    textChannels: { general: '💬 general-chat', 'banana-talk': '🍌 banana-market' },
    voiceChannels: { lounge: '🔊 The Lounge', 'raid-room': '🦍 Gorilla Raid' }
  },
  'research-lab': {
    name: 'Chimp Research Lab 🧪',
    textChannels: { intel: '📑 brain-size-trends' },
    voiceChannels: { 'lab-meeting': '🔊 Lab Meeting' }
  }
};

// Runtime-mutable server list (admin actions modify this)
let jungleServers = JSON.parse(JSON.stringify(defaultServers));

// ─── MESSAGE CACHE (server-side, in-memory ring buffer) ──
// Structure: cache[serverId][channelId] = [...msgs]
const MSG_CACHE_MAX = 100;
const msgCache = {};

function cacheMsg(serverId, channelId, msgObj) {
  if (!msgCache[serverId]) msgCache[serverId] = {};
  if (!msgCache[serverId][channelId]) msgCache[serverId][channelId] = [];
  const ch = msgCache[serverId][channelId];
  ch.push(msgObj);
  if (ch.length > MSG_CACHE_MAX) ch.shift();
}

function getHistory(serverId, channelId) {
  return msgCache[serverId]?.[channelId] || [];
}

function clearChannelCache(serverId, channelId) {
  if (msgCache[serverId]) delete msgCache[serverId][channelId];
}

function clearServerCache(serverId) {
  delete msgCache[serverId];
}

// ─── USER REGISTRY ───────────────────────────────────────
// socketId → { serverId, channelId, internalRoomId, userName, role }
const userRegistry = {};

function broadcastUserList() {
  const users = Object.entries(userRegistry).map(([socketId, u]) => ({
    socketId,
    name: u.userName,
    role: u.role,
    serverId: u.serverId
  }));
  io.emit('user-list-update', users);
}

// ─── SOCKET HANDLERS ─────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🐒 Connected: ${socket.id}`);

  // ── Authentication
  socket.on('authenticate', ({ username, password }) => {
    const creds = loadCredentials();
    const user = creds.find(c => c.username === username && c.password === password);
    if (user) {
      userRegistry[socket.id] = {
        userName: user.username,
        role: user.role,
        serverId: null,
        channelId: null,
        internalRoomId: null
      };
      socket.emit('auth-result', { success: true, role: user.role });
      broadcastUserList();
      console.log(`✅ Auth: ${username} (${user.role})`);
    } else {
      socket.emit('auth-result', { success: false });
      console.log(`❌ Auth failed: ${username}`);
    }
  });

  // ── Bootstrap data
  socket.emit('init-discord-data', { servers: jungleServers });

  // ── Join voice
  socket.on('join-voice', ({ serverId, channelId, userName }) => {
    leavePreviousVoice(socket);

    const roomId = `vc-${serverId}-${channelId}`;
    socket.join(roomId);

    if (userRegistry[socket.id]) {
      userRegistry[socket.id].serverId = serverId;
      userRegistry[socket.id].channelId = channelId;
      userRegistry[socket.id].internalRoomId = roomId;
    }

    const existing = Object.keys(userRegistry).filter(
      id => id !== socket.id && userRegistry[id].internalRoomId === roomId
    );

    socket.emit('current-room-monkeys', existing.map(id => ({
      id, name: userRegistry[id].userName
    })));

    socket.to(roomId).emit('peer-joined-voice', { id: socket.id, name: userName });
    console.log(`🔊 ${userName} joined voice: ${roomId}`);
  });

  // ── WebRTC signaling
  socket.on('webrtc-signal', ({ targetPeerId, signal }) => {
    io.to(targetPeerId).emit('webrtc-signal', { senderPeerId: socket.id, signal });
  });

  // ── Join text channel (and send history)
  socket.on('join-text', ({ serverId, channelId }) => {
    // Leave old text rooms
    Array.from(socket.rooms).filter(r => r.startsWith('tx-')).forEach(r => socket.leave(r));
    socket.join(`tx-${serverId}-${channelId}`);

    // Send cached message history to this client
    const history = getHistory(serverId, channelId);
    if (history.length > 0) {
      socket.emit('message-history', { serverId, channelId, messages: history });
    }
  });

  // ── Text message
  socket.on('send-text-msg', ({ serverId, channelId, text, userName, role }) => {
    // Sanitize text length
    const safeText = String(text).substring(0, 2000);
    const userData = userRegistry[socket.id];
    const effectiveRole = userData?.role || role || 'member';

    const msgObj = {
      senderId: socket.id,
      userName,
      text: safeText,
      role: effectiveRole,
      timestamp: Date.now()
    };

    cacheMsg(serverId, channelId, msgObj);
    io.to(`tx-${serverId}-${channelId}`).emit('receive-text-msg', msgObj);
  });

  // ── Leave voice
  socket.on('leave-voice', () => leavePreviousVoice(socket));

  // ─────────────────────────────────────────────────────────
  // ── ADMIN ACTIONS
  // ─────────────────────────────────────────────────────────

  function isAdmin(socketId) {
    const u = userRegistry[socketId];
    return u && (u.role === 'admin' || u.role === 'owner');
  }

  function isOwner(socketId) {
    const u = userRegistry[socketId];
    return u && u.role === 'owner';
  }

  // Kick user from voice
  socket.on('admin-kick', ({ targetSocketId }) => {
    if (!isAdmin(socket.id)) return;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      leavePreviousVoice(targetSocket);
      targetSocket.emit('admin-kicked');
      console.log(`🚫 ${userRegistry[socket.id]?.userName} kicked ${userRegistry[targetSocketId]?.userName}`);
    }
  });

  // Promote user to admin
  socket.on('admin-promote', ({ targetSocketId }) => {
    if (!isOwner(socket.id)) return;
    if (userRegistry[targetSocketId]) {
      userRegistry[targetSocketId].role = 'admin';
      io.to(targetSocketId).emit('role-updated', { socketId: targetSocketId, newRole: 'admin' });
      broadcastUserList();
      console.log(`⬆️ ${userRegistry[targetSocketId].userName} promoted to admin`);
    }
  });

  // Add channel
  socket.on('admin-add-channel', ({ serverId, channelName, channelType }) => {
    if (!isAdmin(socket.id)) return;
    const server = jungleServers[serverId];
    if (!server) return;

    // Sanitize
    const safeName = channelName.toLowerCase().replace(/[^a-z0-9-]/g, '').substring(0, 32);
    if (!safeName) return;

    if (channelType === 'text') {
      server.textChannels[safeName] = safeName;
    } else {
      server.voiceChannels[safeName] = `🔊 ${safeName}`;
    }

    io.emit('channels-updated', { serverId, server });
    console.log(`➕ Channel added: ${channelType}/${safeName} in ${serverId}`);
  });

  // Delete channel
  socket.on('admin-delete-channel', ({ serverId, channelId, channelType }) => {
    if (!isOwner(socket.id)) return;
    const server = jungleServers[serverId];
    if (!server) return;

    if (channelType === 'text') {
      delete server.textChannels[channelId];
      clearChannelCache(serverId, channelId);
    } else {
      delete server.voiceChannels[channelId];
    }

    io.emit('channels-updated', { serverId, server });
    console.log(`🗑️ Channel deleted: ${channelType}/${channelId} in ${serverId}`);
  });

  // Clear message cache (admin)
  socket.on('admin-clear-cache', ({ serverId, channelId }) => {
    if (!isAdmin(socket.id)) return;
    if (channelId) clearChannelCache(serverId, channelId);
    else clearServerCache(serverId);
    console.log(`🗑️ Cache cleared: ${serverId}/${channelId || '*'}`);
  });

  // ─────────────────────────────────────────────────────────

  // ── Disconnect
  socket.on('disconnect', () => {
    leavePreviousVoice(socket);
    delete userRegistry[socket.id];
    broadcastUserList();
    console.log(`🐒 Disconnected: ${socket.id}`);
  });
});

// ─── LEAVE VOICE HELPER ──────────────────────────────────
function leavePreviousVoice(socket) {
  const userData = userRegistry[socket.id];
  if (userData?.internalRoomId) {
    socket.to(userData.internalRoomId).emit('peer-left-voice', socket.id);
    socket.leave(userData.internalRoomId);
    userData.internalRoomId = null;
    userData.channelId = null;
  }
}

// ─── START ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🍌 monkey.chat running on :${PORT}`));

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
