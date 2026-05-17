require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN },
  pingTimeout: 60000,
  pingInterval: 25000
});

const fs = require('fs');
const publicDir = path.join(__dirname, 'public');

function debug(...args) {
  if (process.env.DEBUG) console.log(...args);
}

function getRtcConfig() {
  const username = process.env.TURN_USERNAME || '4f896608fcb95956035370ff';
  const credential = process.env.TURN_CREDENTIAL || 'fsReP4d/VohYU6Ei';
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: [
          'turn:global.relay.metered.ca:80',
          'turn:global.relay.metered.ca:443',
          'turn:global.relay.metered.ca:443?transport=tcp'
        ],
        username,
        credential
      }
    ],
    bundlePolicy: 'max-bundle',
    iceCandidatePoolSize: 10
  };
}

const rtcConfigScript = `<script>window.__RTC_CONFIG = ${JSON.stringify(getRtcConfig())};</script>`;
const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8').replace('</head>', rtcConfigScript + '</head>');

app.get('/', (req, res) => res.type('html').send(indexHtml));
app.use(express.static(publicDir));

const loadCredentials = () => {
  const authEnv = process.env.AUTH_CREDENTIALS;
  if (!authEnv) return [];
  return authEnv.split(';').filter(line => line.includes(':')).map(line => {
    const parts = line.trim().split(':');
    return {
      username: parts[0].trim(),
      password: parts[1].trim(),
      role: (parts[2] || 'member').trim()
    };
  });
};

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

let jungleServers = JSON.parse(JSON.stringify(defaultServers));

const pinnedMessages = {};

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

const userRegistry = {};
const sessionRegistry = {};

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW = 10000;
const RATE_LIMIT_MAX = 20;
const rateCounters = {};

function checkRateLimit(socketId) {
  const now = Date.now();
  if (!rateCounters[socketId]) rateCounters[socketId] = { count: 1, resetAt: now + RATE_LIMIT_WINDOW };
  else {
    if (now > rateCounters[socketId].resetAt) {
      rateCounters[socketId] = { count: 1, resetAt: now + RATE_LIMIT_WINDOW };
    } else {
      rateCounters[socketId].count++;
      if (rateCounters[socketId].count > RATE_LIMIT_MAX) return false;
    }
  }
  return true;
}

function isAdmin(socketId) {
  const u = userRegistry[socketId];
  return u && (u.role === 'admin' || u.role === 'owner');
}

function isOwner(socketId) {
  const u = userRegistry[socketId];
  return u && u.role === 'owner';
}

function broadcastUserList() {
  const users = Object.entries(userRegistry).map(([socketId, u]) => ({
    socketId,
    name: u.userName,
    role: u.role,
    serverId: u.serverId
  }));
  io.emit('user-list-update', users);
}

io.on('connection', (socket) => {
  debug(`Connected: ${socket.id}`);

  socket.on('authenticate', ({ username, password, token }) => {
    if (!checkRateLimit(socket.id)) return socket.emit('auth-result', { success: false, error: 'Rate limited' });

    let user;
    if (token && sessionRegistry[token]) {
      const session = sessionRegistry[token];
      if (session.expiresAt && Date.now() > session.expiresAt) {
        delete sessionRegistry[token];
        return socket.emit('auth-result', { success: false, error: 'Session expired' });
      }
      user = { username: session.userName, role: session.role };
    } else {
      const creds = loadCredentials();
      user = creds.find(c => c.username === username && c.password === password);
      if (user) {
        token = Math.random().toString(36).substring(2) + Date.now().toString(36);
        sessionRegistry[token] = { userName: user.username, role: user.role, expiresAt: Date.now() + SESSION_TTL_MS };
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
      debug(`Auth: ${user.username} (${user.role})`);
    } else {
      socket.emit('auth-result', { success: false });
      debug(`Auth failed: ${username || 'Token login'}`);
    }
  });

  socket.on('join-voice', ({ serverId, channelId }) => {
    const userData = userRegistry[socket.id];
    if (!userData) return;
    if (!checkRateLimit(socket.id)) return;

    const server = jungleServers[serverId];
    if (!server || !server.voiceChannels[channelId]) return;

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
    debug(`${userData.userName} joined voice: ${roomId}`);
  });

  socket.on('webrtc-signal', ({ targetPeerId, signal }) => {
    if (!userRegistry[socket.id]) return;
    if (!checkRateLimit(socket.id)) return;
    io.to(targetPeerId).emit('webrtc-signal', { senderPeerId: socket.id, signal });
  });

  socket.on('join-text', ({ serverId, channelId }) => {
    if (!userRegistry[socket.id]) return;

    const server = jungleServers[serverId];
    if (!server || !server.textChannels[channelId]) return;

    Array.from(socket.rooms).filter(r => r.startsWith('tx-')).forEach(r => socket.leave(r));
    socket.join(`tx-${serverId}-${channelId}`);

    const history = getHistory(serverId, channelId);
    if (history.length > 0) {
      socket.emit('message-history', { serverId, channelId, messages: history });
    }
  });

  socket.on('send-text-msg', ({ serverId, channelId, text }) => {
    const userData = userRegistry[socket.id];
    if (!userData) return;
    if (!checkRateLimit(socket.id)) return;

    const server = jungleServers[serverId];
    if (!server || !server.textChannels[channelId]) return;

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

  socket.on('pin-message', ({ serverId, channelId, message }) => {
    if (!isAdmin(socket.id)) return;
    if (!pinnedMessages[serverId]) pinnedMessages[serverId] = {};
    if (!pinnedMessages[serverId][channelId]) pinnedMessages[serverId][channelId] = [];

    if (pinnedMessages[serverId][channelId].some(m => m.id === message.id)) return;

    pinnedMessages[serverId][channelId].push(message);
    io.to(`tx-${serverId}-${channelId}`).emit('pinned-messages-update', {
      serverId, channelId, messages: pinnedMessages[serverId][channelId]
    });
  });

  socket.on('unpin-message', ({ serverId, channelId, messageId }) => {
    if (!isAdmin(socket.id)) return;
    if (pinnedMessages[serverId]?.[channelId]) {
      pinnedMessages[serverId][channelId] = pinnedMessages[serverId][channelId].filter(m => m.id !== messageId);
      io.to(`tx-${serverId}-${channelId}`).emit('pinned-messages-update', {
        serverId, channelId, messages: pinnedMessages[serverId][channelId]
      });
    }
  });

  socket.on('get-pinned-messages', ({ serverId, channelId }) => {
    if (!userRegistry[socket.id]) return;
    const pins = pinnedMessages[serverId]?.[channelId] || [];
    socket.emit('pinned-messages-update', { serverId, channelId, messages: pins });
  });

  socket.on('create-server', ({ name }) => {
    if (!userRegistry[socket.id]) return;
    if (!checkRateLimit(socket.id)) return;

    const serverId = name.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 32) + '-' + Math.floor(Math.random() * 1000);
    const newServer = {
      name: name + ' 🏝️',
      textChannels: { general: '💬 general-chat' },
      voiceChannels: { lounge: '🔊 The Lounge' }
    };
    jungleServers[serverId] = newServer;
    socket.emit('server-created', { serverId, server: newServer });
    socket.emit('init-discord-data', { servers: jungleServers });
  });

  socket.on('update-user', ({ newName }) => {
    const userData = userRegistry[socket.id];
    if (!userData) return;
    if (!checkRateLimit(socket.id)) return;

    const oldName = userData.userName;
    userData.userName = newName;
    broadcastUserList();
    debug(`${oldName} changed name to ${newName}`);
  });

  socket.on('leave-voice', () => leavePreviousVoice(socket));

  socket.on('admin-kick', ({ targetSocketId }) => {
    if (!isAdmin(socket.id)) return;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      leavePreviousVoice(targetSocket);
      targetSocket.emit('admin-kicked');
      debug(`${userRegistry[socket.id]?.userName} kicked ${userRegistry[targetSocketId]?.userName}`);
    }
  });

  socket.on('admin-promote', ({ targetSocketId }) => {
    if (!isOwner(socket.id)) return;
    if (userRegistry[targetSocketId]) {
      userRegistry[targetSocketId].role = 'admin';
      io.to(targetSocketId).emit('role-updated', { socketId: targetSocketId, newRole: 'admin' });
      broadcastUserList();
      debug(`${userRegistry[targetSocketId].userName} promoted to admin`);
    }
  });

  socket.on('admin-add-channel', ({ serverId, channelName, channelType }) => {
    if (!isAdmin(socket.id)) return;
    const server = jungleServers[serverId];
    if (!server) return;

    const safeName = channelName.toLowerCase().replace(/[^a-z0-9-]/g, '').substring(0, 32);
    if (!safeName) return;

    if (channelType === 'text') {
      server.textChannels[safeName] = safeName;
    } else {
      server.voiceChannels[safeName] = `🔊 ${safeName}`;
    }

    io.emit('channels-updated', { serverId, server });
    debug(`Channel added: ${channelType}/${safeName} in ${serverId}`);
  });

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
    debug(`Channel deleted: ${channelType}/${channelId} in ${serverId}`);
  });

  socket.on('admin-clear-cache', ({ serverId, channelId }) => {
    if (!isAdmin(socket.id)) return;
    if (channelId) clearChannelCache(serverId, channelId);
    else clearServerCache(serverId);
    debug(`Cache cleared: ${serverId}/${channelId || '*'}`);
  });

  socket.on('disconnect', () => {
    leavePreviousVoice(socket);
    delete userRegistry[socket.id];
    broadcastUserList();
    debug(`Disconnected: ${socket.id}`);
  });
});

function leavePreviousVoice(socket) {
  const userData = userRegistry[socket.id];
  if (userData?.internalRoomId) {
    socket.to(userData.internalRoomId).emit('peer-left-voice', socket.id);
    socket.leave(userData.internalRoomId);
    userData.internalRoomId = null;
    userData.channelId = null;
  }
}

if (!process.env.AUTH_CREDENTIALS) {
  console.error('FATAL: AUTH_CREDENTIALS environment variable is not set. Server will not start.');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`monkey.chat running on :${PORT}`));

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
