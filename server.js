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

// ─── PINNED MESSAGES (in-memory) ────────────────────────
// pinnedMessages[serverId][channelId] = [...msgs]
const pinnedMessages = {};

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
// socketId → { serverId, channelId, internalRoomId, userName, role, token }
const userRegistry = {};
// token → { userName, role }
const sessionRegistry = {};

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
  socket.on('authenticate', ({ username, password, token }) => {
    let user;
    if (token && sessionRegistry[token]) {
      user = { username: sessionRegistry[token].userName, role: sessionRegistry[token].role };
    } else {
      const creds = loadCredentials();
      user = creds.find(c => c.username === username && c.password === password);
      if (user) {
        token = Math.random().toString(36).substring(2) + Date.now().toString(36);
        sessionRegistry[token] = { userName: user.username, role: user.role };
      }
    }

    if (user) {
      userRegistry[socket.id] = {
        userName: user.username,
        role: user.role,
        serverId: null,
        channelId: null,
        internalRoomId: null,
        token: token
      };
      socket.emit('auth-result', { success: true, role: user.role, token: token });
      socket.emit('init-discord-data', { servers: jungleServers });
      broadcastUserList();
      console.log(`✅ Auth: ${user.username} (${user.role})`);
    } else {
      socket.emit('auth-result', { success: false });
      console.log(`❌ Auth failed: ${username || 'Token login'}`);
    }
  });

  // ── Join voice
  socket.on('join-voice', ({ serverId, channelId }) => {
    const userData = userRegistry[socket.id];
    if (!userData) return;

    leavePreviousVoice(socket);

    const roomId = `vc-${serverId}-${channelId}`;
    socket.join(roomId);

    userData.serverId = serverId;
    userData.channelId = channelId;
    userData.internalRoomId = roomId;

    const existing = Object.keys(userRegistry).filter(
      id => id !== socket.id && userRegistry[id].internalRoomId === roomId
    );

    socket.emit('current-room-monkeys', existing.map(id => ({
      id, name: userRegistry[id].userName
    })));

    socket.to(roomId).emit('peer-joined-voice', { id: socket.id, name: userData.userName });
    console.log(`🔊 ${userData.userName} joined voice: ${roomId}`);
  });

  // ── WebRTC signaling
  socket.on('webrtc-signal', ({ targetPeerId, signal }) => {
    if (!userRegistry[socket.id]) return;
    io.to(targetPeerId).emit('webrtc-signal', { senderPeerId: socket.id, signal });
  });

  // ── Join text channel (and send history)
  socket.on('join-text', ({ serverId, channelId }) => {
    if (!userRegistry[socket.id]) return;

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
  socket.on('send-text-msg', ({ serverId, channelId, text }) => {
    const userData = userRegistry[socket.id];
    if (!userData) return;

    // Sanitize text length
    const safeText = String(text).substring(0, 2000);

    const msgObj = {
      id: `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      senderId: socket.id,
      userName: userData.userName,
      text: safeText,
      role: userData.role,
      timestamp: Date.now()
    };

    cacheMsg(serverId, channelId, msgObj);
    io.to(`tx-${serverId}-${channelId}`).emit('receive-text-msg', msgObj);
  });

  // ── Pinning
  socket.on('pin-message', ({ serverId, channelId, message }) => {
    if (!pinnedMessages[serverId]) pinnedMessages[serverId] = {};
    if (!pinnedMessages[serverId][channelId]) pinnedMessages[serverId][channelId] = [];
    
    // Check if already pinned
    if (pinnedMessages[serverId][channelId].some(m => m.id === message.id)) return;
    
    pinnedMessages[serverId][channelId].push(message);
    io.to(`tx-${serverId}-${channelId}`).emit('pinned-messages-update', { 
      serverId, channelId, messages: pinnedMessages[serverId][channelId] 
    });
  });

  socket.on('unpin-message', ({ serverId, channelId, messageId }) => {
    if (pinnedMessages[serverId]?.[channelId]) {
      pinnedMessages[serverId][channelId] = pinnedMessages[serverId][channelId].filter(m => m.id !== messageId);
      io.to(`tx-${serverId}-${channelId}`).emit('pinned-messages-update', { 
        serverId, channelId, messages: pinnedMessages[serverId][channelId] 
      });
    }
  });

  socket.on('get-pinned-messages', ({ serverId, channelId }) => {
    const pins = pinnedMessages[serverId]?.[channelId] || [];
    socket.emit('pinned-messages-update', { serverId, channelId, messages: pins });
  });

  // ── Server Management
  socket.on('create-server', ({ name }) => {
    const serverId = name.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 32) + '-' + Math.floor(Math.random() * 1000);
    const newServer = {
      name: name + ' 🏝️',
      textChannels: { general: '💬 general-chat' },
      voiceChannels: { lounge: '🔊 The Lounge' }
    };
    jungleServers[serverId] = newServer;
    io.emit('server-created', { serverId, server: newServer });
    // Re-emit init data to everyone to refresh guild bars
    io.emit('init-discord-data', { servers: jungleServers });
  });

  // ── User settings
  socket.on('update-user', ({ newName }) => {
    if (userRegistry[socket.id]) {
      const oldName = userRegistry[socket.id].userName;
      userRegistry[socket.id].userName = newName;
      broadcastUserList();
      console.log(`👤 ${oldName} changed name to ${newName}`);
    }
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
