// public/app.js

const socket = io({ transports: ['websocket'], upgrade: false });

// ─── CONSTANTS ───────────────────────────────────────────
const MEDIA_CONSTRAINTS = {
  video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 20 } },
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
};
const MAX_VIDEO_BITRATE = 250000;
const MSG_CACHE_KEY = 'mc_msg_cache';
const MAX_CACHED_MSGS = 100; // per channel
const MSG_GROUP_THRESHOLD = 5 * 60 * 1000; // 5 minutes → new group header

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: 'turn:global.relay.metered.ca:80',
      username: '3668af38c652028b1a39b682',
      credential: 'TdkzU0crNP4oPMm1'
    },
    {
      urls: 'turn:global.relay.metered.ca:443',
      username: '3668af38c652028b1a39b682',
      credential: 'TdkzU0crNP4oPMm1'
    },
    {
      urls: 'turn:global.relay.metered.ca:443?transport=tcp',
      username: '3668af38c652028b1a39b682',
      credential: 'TdkzU0crNP4oPMm1'
    },
    {
      urls: 'turns:global.relay.metered.ca:443?transport=tcp',
      username: '3668af38c652028b1a39b682',
      credential: 'TdkzU0crNP4oPMm1'
    }
  ],
  bundlePolicy: 'max-bundle',
  iceCandidatePoolSize: 10
};

// ─── STATE ───────────────────────────────────────────────
let localStream = null;
let peerConnections = {};
let remoteStreams = {};
let activeServers = {};
let currentServerId = null;
let currentTextChannelId = null;
let currentVoiceChannelId = null;
let myName = '';
let myRole = 'member'; // 'member' | 'admin' | 'owner'
let onlineUsers = {};  // socketId → { name, role }
let pinnedMessages = []; // current channel pins
let membersSidebarOpen = false;
let lastMsgAuthor = null;
let lastMsgTime = null;

// ─── UI ELEMENTS ─────────────────────────────────────────
const guildsBar             = document.getElementById('guildsBar');
const channelListContainer  = document.getElementById('channelListContainer');
const currentServerName     = document.getElementById('currentServerName');
const activeChannelHeader   = document.getElementById('activeChannelHeader');
const channelTopic          = document.getElementById('channelTopic');
const headerIcon            = document.getElementById('headerIcon');
const videoGrid             = document.getElementById('videoGrid');
const videoArenaEmpty       = document.getElementById('videoArenaEmpty');
const msgFeed               = document.getElementById('msgFeed');
const textInput             = document.getElementById('textInput');
const sendBtn               = document.getElementById('sendBtn');
const voiceDock             = document.getElementById('voiceDock');
const dockChannelName       = document.getElementById('dockChannelName');
const loginOverlay          = document.getElementById('loginOverlay');
const loginBtn              = document.getElementById('loginBtn');
const usernameInput         = document.getElementById('username');
const passwordInput         = document.getElementById('password');
const loginError            = document.getElementById('loginError');
const adminPanelBtn         = document.getElementById('adminPanelBtn');
const adminPanel            = document.getElementById('adminPanel');
const closeAdminPanel       = document.getElementById('closeAdminPanel');
const adminUserList         = document.getElementById('adminUserList');
const adminChannelList      = document.getElementById('adminChannelList');
const addChannelBtn         = document.getElementById('addChannelBtn');
const newChannelName        = document.getElementById('newChannelName');
const newChannelType        = document.getElementById('newChannelType');
const clearCacheBtn         = document.getElementById('clearCacheBtn');
const selfAvatar            = document.getElementById('selfAvatar');
const selfName              = document.getElementById('selfName');
const selfStatus            = document.getElementById('selfStatus');
const toastContainer        = document.getElementById('toastContainer');
const contextMenu           = document.getElementById('contextMenu');

// New UI Elements
const membersBtn            = document.getElementById('membersBtn');
const membersSidebar        = document.getElementById('membersSidebar');
const membersList           = document.getElementById('membersList');
const memberCount           = document.getElementById('memberCount');
const searchBtn             = document.getElementById('searchBtn');
const searchContainer       = document.getElementById('searchContainer');
const searchInput           = document.getElementById('searchInput');
const searchClose           = document.getElementById('searchClose');
const pinsBtn               = document.getElementById('pinsBtn');
const pinsModal             = document.getElementById('pinsModal');
const pinsList              = document.getElementById('pinsList');
const selfSettingsBtn       = document.getElementById('selfSettingsBtn');
const settingsModal         = document.getElementById('settingsModal');
const settingsUsername      = document.getElementById('settingsUsername');
const saveSettingsBtn       = document.getElementById('saveSettingsBtn');
const createServerBtn       = document.getElementById('createServerBtn');
const createServerModal     = document.getElementById('createServerModal');
const newServerNameInput    = document.getElementById('newServerName');
const confirmCreateServerBtn = document.getElementById('confirmCreateServerBtn');
const ctxPin                = document.getElementById('ctxPin');

// ─── SEARCH LOGIC ─────────────────────────────
searchBtn.addEventListener('click', () => {
  searchContainer.classList.toggle('open');
  if (searchContainer.classList.contains('open')) searchInput.focus();
  else {
    searchInput.value = '';
    handleSearch();
  }
});

searchClose.addEventListener('click', () => {
  searchContainer.classList.remove('open');
  searchInput.value = '';
  handleSearch();
});

searchInput.addEventListener('input', handleSearch);

function handleSearch() {
  const query = searchInput.value.toLowerCase().trim();
  const messages = msgFeed.querySelectorAll('.msg-group');
  
  messages.forEach(group => {
    const author = group.querySelector('.msg-author').textContent.toLowerCase();
    const bodies = group.querySelectorAll('.msg-body');
    let groupVisible = false;
    
    bodies.forEach(body => {
      const text = body.textContent.toLowerCase();
      const visible = text.includes(query) || author.includes(query);
      body.style.display = visible ? 'block' : 'none';
      if (visible) groupVisible = true;
    });
    
    group.style.display = groupVisible ? 'flex' : 'none';
  });
}

// ─── MEMBERS SIDEBAR LOGIC ───────────────────
membersBtn.addEventListener('click', () => {
  membersSidebarOpen = !membersSidebarOpen;
  membersSidebar.classList.toggle('open', membersSidebarOpen);
  if (membersSidebarOpen) renderMembersList();
});

function renderMembersList() {
  membersList.innerHTML = '';
  const users = Object.values(onlineUsers);
  memberCount.textContent = users.length;

  users.forEach(user => {
    const el = document.createElement('div');
    el.className = 'member-item';
    el.innerHTML = `
      <div class="member-avatar">${user.name.charAt(0).toUpperCase()}</div>
      <div class="member-name online">${user.name}</div>
      <div class="member-role-icon">${user.role === 'owner' ? '👑' : user.role === 'admin' ? '🛡️' : ''}</div>
    `;
    membersList.appendChild(el);
  });
}

// ─── PINS LOGIC ─────────────────────────────
pinsBtn.addEventListener('click', () => {
  pinsModal.classList.add('open');
  socket.emit('get-pinned-messages', { serverId: currentServerId, channelId: currentTextChannelId });
});

socket.on('pinned-messages-update', ({ messages }) => {
  pinnedMessages = messages;
  renderPinsList();
});

function renderPinsList() {
  pinsList.innerHTML = '';
  if (pinnedMessages.length === 0) {
    pinsList.innerHTML = '<div style="color: var(--text-3); font-size: 0.8rem; text-align: center;">No pinned messages yet</div>';
    return;
  }

  pinnedMessages.forEach(msg => {
    const el = document.createElement('div');
    el.className = 'pin-item';
    el.innerHTML = `
      <div class="pin-meta">
        <strong>${msg.userName}</strong>
        <span>${formatTimestamp(msg.timestamp)}</span>
      </div>
      <div style="font-size: 0.85rem; color: var(--text-2);">${linkify(msg.text)}</div>
      <button class="admin-action-btn danger" style="margin-top:8px; width:fit-content; padding:2px 8px;" onclick="unpinMessage('${msg.id}')">Unpin</button>
    `;
    pinsList.appendChild(el);
  });
}

window.unpinMessage = (messageId) => {
  socket.emit('unpin-message', { serverId: currentServerId, channelId: currentTextChannelId, messageId });
};

// ─── USER SETTINGS LOGIC ─────────────────────
selfSettingsBtn.addEventListener('click', () => {
  settingsUsername.value = myName;
  settingsModal.classList.add('open');
});

saveSettingsBtn.addEventListener('click', () => {
  const newName = settingsUsername.value.trim();
  if (!newName) return;
  myName = newName;
  selfName.textContent = myName;
  selfAvatar.textContent = myName.charAt(0).toUpperCase();
  socket.emit('update-user', { newName });
  settingsModal.classList.remove('open');
  showToast('Profile updated', '👤');
});

// ─── CREATE SERVER LOGIC ────────────────────
createServerBtn.addEventListener('click', () => {
  createServerModal.classList.add('open');
});

confirmCreateServerBtn.addEventListener('click', () => {
  const name = newServerNameInput.value.trim();
  if (!name) return;
  socket.emit('create-server', { name });
  newServerNameInput.value = '';
  createServerModal.classList.remove('open');
  showToast(`Creating server "${name}"...`, '🏝️');
});

// ─── TOAST SYSTEM ────────────────────────────────────────
function showToast(message, icon = 'ℹ️', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${message}</span>`;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, duration);
}

// ─── AUTO-RESIZE TEXTAREA ────────────────────────────────
textInput.addEventListener('input', () => {
  textInput.style.height = 'auto';
  textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';
  sendBtn.disabled = !textInput.value.trim();
});

// ─── SEND LOGIC ──────────────────────────────────────────
function sendMessage() {
  const text = textInput.value.trim();
  if (!text || !currentTextChannelId) return;
  socket.emit('send-text-msg', {
    serverId: currentServerId,
    channelId: currentTextChannelId,
    text,
    userName: myName,
    role: myRole
  });
  textInput.value = '';
  textInput.style.height = 'auto';
  sendBtn.disabled = true;
}

sendBtn.disabled = true;
sendBtn.addEventListener('click', sendMessage);

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ─── LOGIN ───────────────────────────────────────────────
loginBtn.addEventListener('click', () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username) return;
  socket.emit('authenticate', { username, password });
});

// Allow Enter key in login fields
[usernameInput, passwordInput].forEach(el => {
  el.addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); });
});

socket.on('auth-result', ({ success, role }) => {
  if (success) {
    loginOverlay.style.display = 'none';
    myName = usernameInput.value.trim();
    myRole = role || 'member';
    // Update user panel
    selfAvatar.textContent = myName.charAt(0).toUpperCase();
    selfName.textContent = myName;
    // Show admin button if elevated
    if (myRole === 'admin' || myRole === 'owner') {
      adminPanelBtn.style.display = 'flex';
    }
    showToast(`Welcome back, ${myName}!`, '🐒');
    console.log(`[Auth] Logged in as ${myName} (${myRole})`);
  } else {
    loginError.style.display = 'block';
    passwordInput.value = '';
    passwordInput.focus();
  }
});

// ─── AUTOPLAY UNBLOCK ────────────────────────────────────
document.body.addEventListener('click', () => {
  document.querySelectorAll('video').forEach(v => {
    if (v.srcObject && v.id !== 'video-box-local') v.play().catch(() => {});
  });
}, { once: false });

// ─── MESSAGE CACHE (localStorage) ───────────────────────
function getCacheKey(serverId, channelId) {
  return `${MSG_CACHE_KEY}:${serverId}:${channelId}`;
}

function loadCachedMessages(serverId, channelId) {
  try {
    const raw = localStorage.getItem(getCacheKey(serverId, channelId));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function cacheMessage(serverId, channelId, msgObj) {
  try {
    const key = getCacheKey(serverId, channelId);
    const msgs = loadCachedMessages(serverId, channelId);
    msgs.push(msgObj);
    if (msgs.length > MAX_CACHED_MSGS) msgs.splice(0, msgs.length - MAX_CACHED_MSGS);
    localStorage.setItem(key, JSON.stringify(msgs));
  } catch (e) { console.warn('Cache write failed:', e); }
}

function clearChannelCache(serverId, channelId) {
  localStorage.removeItem(getCacheKey(serverId, channelId));
}

function clearAllCache() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(MSG_CACHE_KEY));
  keys.forEach(k => localStorage.removeItem(k));
  showToast('Message cache cleared', '🗑️');
}

// ─── MESSAGE RENDERING ───────────────────────────────────
function formatTimestamp(ts) {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function linkify(text) {
  // Convert URLs to clickable links, escape HTML first
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(
    /(https?:\/\/[^\s]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

function appendMessage(msgData) {
  const { id, userName, text, role, timestamp } = msgData;
  const ts = timestamp || Date.now();
  const isAdmin = role === 'admin' || role === 'owner';
  const isSelf = userName === myName;

  // Check if we should group with the previous message
  const sameAuthor = lastMsgAuthor === userName;
  const withinWindow = lastMsgTime && (ts - lastMsgTime) < MSG_GROUP_THRESHOLD;
  const shouldGroup = sameAuthor && withinWindow;

  let body;

  if (!shouldGroup) {
    // New group → header + fresh body
    const group = document.createElement('div');
    group.className = 'msg-group';

    const header = document.createElement('div');
    header.className = 'msg-group-header';

    const authorEl = document.createElement('span');
    authorEl.className = 'msg-author' + (isAdmin ? ' is-admin' : '');
    authorEl.textContent = userName + (isSelf ? ' (you)' : '');

    const tsEl = document.createElement('span');
    tsEl.className = 'msg-timestamp';
    tsEl.textContent = formatTimestamp(ts);

    header.appendChild(authorEl);
    header.appendChild(tsEl);

    body = document.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = linkify(text);
    body.dataset.group = 'root';

    group.appendChild(header);
    group.appendChild(body);
    msgFeed.appendChild(group);
  } else {
    // Append another line to the last group
    const lastGroup = msgFeed.querySelector('.msg-group:last-child');
    if (lastGroup) {
      body = document.createElement('div');
      body.className = 'msg-body';
      body.innerHTML = linkify(text);
      lastGroup.appendChild(body);
    }
  }

  if (body) {
    body.dataset.msgId = id;
    body.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, { type: 'message', data: msgData });
    });
  }

  lastMsgAuthor = userName;
  lastMsgTime = ts;

  msgFeed.scrollTop = msgFeed.scrollHeight;
}

function appendSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg-system';
  el.textContent = text;
  msgFeed.appendChild(el);
  // Reset grouping so next real message starts a new header
  lastMsgAuthor = null;
  lastMsgTime = null;
}

// ─── INIT SERVER DATA ────────────────────────────────────
socket.on('init-discord-data', ({ servers }) => {
  activeServers = servers;
  // Clear guild icons except home
  const existingIcons = guildsBar.querySelectorAll('.guild-icon:not(#homeGuildIcon)');
  existingIcons.forEach(e => e.remove());
  const divider = guildsBar.querySelector('.guild-divider');

  Object.keys(servers).forEach((id, idx) => {
    const btn = document.createElement('div');
    btn.classList.add('guild-icon');
    btn.textContent = servers[id].name.replace(/\s*[\u{1F300}-\u{1FFFF}]/gu, '').trim().substring(0, 2).toUpperCase();
    btn.title = servers[id].name;
    btn.dataset.serverId = id;
    btn.addEventListener('click', () => switchServer(id, btn));
    // Insert after divider
    divider ? guildsBar.insertBefore(btn, divider.nextSibling) : guildsBar.appendChild(btn);
  });

  if (currentServerId && activeServers[currentServerId]) {
    switchServer(currentServerId);
  } else {
    switchServer(Object.keys(servers)[0]);
  }
});

// Server created dynamically (admin action)
socket.on('server-created', ({ serverId, server }) => {
  activeServers[serverId] = server;
  showToast(`Server "${server.name}" created`, '🌳');
  socket.emit('init-discord-data-request'); // re-fetch if supported, else handle locally
});

// ─── SWITCH SERVER ───────────────────────────────────────
function switchServer(serverId, element = null) {
  const isSameServer = (currentServerId === serverId);
  currentServerId = serverId;
  const server = activeServers[serverId];
  if (!server) return;
  currentServerName.textContent = server.name;

  document.querySelectorAll('.guild-icon').forEach(e => e.classList.remove('active'));
  if (element) element.classList.add('active');
  else {
    const btn = guildsBar.querySelector(`[data-server-id="${serverId}"]`);
    if (btn) btn.classList.add('active');
  }

  renderChannels(server, serverId, !isSameServer);
}

// ─── RENDER CHANNELS ─────────────────────────────────────
function renderChannels(server, serverId, autoJoinFirst = true) {
  channelListContainer.innerHTML = '';

  // Text channels
  const tcHead = document.createElement('div');
  tcHead.className = 'ch-category';
  tcHead.innerHTML = `<span>Text Channels</span>${myRole !== 'member' ? '<span class="add-ch-btn" data-type="text" title="Add text channel">＋</span>' : ''}`;
  channelListContainer.appendChild(tcHead);

  tcHead.querySelector('.add-ch-btn')?.addEventListener('click', () => openAdminPanel());

  Object.keys(server.textChannels || {}).forEach(id => {
    const el = document.createElement('div');
    el.className = 'channel-item';
    el.id = `ch-item-${id}`;
    el.innerHTML = `<span class="ch-icon">💬</span><span>${id}</span><span class="unread-dot"></span>`;
    if (id === currentTextChannelId) el.classList.add('active');
    el.addEventListener('click', () => joinTextChannel(id));
    channelListContainer.appendChild(el);
  });

  // Voice channels
  const vcHead = document.createElement('div');
  vcHead.className = 'ch-category';
  vcHead.innerHTML = `<span>Voice Channels</span>${myRole !== 'member' ? '<span class="add-ch-btn" data-type="voice" title="Add voice channel">＋</span>' : ''}`;
  channelListContainer.appendChild(vcHead);

  vcHead.querySelector('.add-ch-btn')?.addEventListener('click', () => openAdminPanel());

  Object.keys(server.voiceChannels || {}).forEach(id => {
    const el = document.createElement('div');
    el.className = 'channel-item';
    el.id = `vc-item-${id}`;
    el.innerHTML = `<span class="ch-icon">🔊</span><span>${server.voiceChannels[id]}</span><span class="user-count">0</span>`;
    if (id === currentVoiceChannelId) el.classList.add('active-voice');
    el.addEventListener('click', () => joinVoiceChannel(id));
    channelListContainer.appendChild(el);
  });

  // Auto-join first text channel if requested
  if (autoJoinFirst) {
    const firstText = Object.keys(server.textChannels || {})[0];
    if (firstText) joinTextChannel(firstText);
  }
}

// ─── TEXT CHANNEL ────────────────────────────────────────
function joinTextChannel(channelId) {
  // Mark previous as not active
  if (currentTextChannelId) {
    document.getElementById(`ch-item-${currentTextChannelId}`)?.classList.remove('active');
  }

  currentTextChannelId = channelId;
  headerIcon.textContent = '💬';
  activeChannelHeader.textContent = channelId;
  channelTopic.textContent = `#${channelId} — ${currentServerName.textContent}`;

  document.getElementById(`ch-item-${channelId}`)?.classList.add('active');
  document.getElementById(`ch-item-${channelId}`)?.classList.remove('has-unread');

  // Clear and reload from cache
  msgFeed.innerHTML = '';
  lastMsgAuthor = null;
  lastMsgTime = null;

  const cached = loadCachedMessages(currentServerId, channelId);
  if (cached.length > 0) {
    appendSystemMessage(`${cached.length} cached message${cached.length > 1 ? 's' : ''} loaded`);
    cached.forEach(m => appendMessage(m));
    appendSystemMessage('— live —');
  } else {
    appendSystemMessage('no message history — start the conversation');
  }

  socket.emit('join-text', { serverId: currentServerId, channelId });
  textInput.focus();
}

socket.on('receive-text-msg', (msgData) => {
  const { userName, text, role, timestamp } = msgData;
  // Cache it
  cacheMessage(currentServerId, currentTextChannelId, msgData);

  // Show unread pip if channel not active (shouldn't happen in this flow but future-proof)
  appendMessage({ userName, text, role, timestamp });

  // Notify if someone else sends a message while focused on another tab
  if (document.hidden && Notification.permission === 'granted') {
    new Notification(`monkey.chat — #${currentTextChannelId}`, {
      body: `${userName}: ${text.substring(0, 80)}`,
      icon: '/favicon.ico'
    });
  }
});

// ─── ONLINE USER TRACKING ────────────────────────────────
socket.on('user-list-update', (users) => {
  onlineUsers = {};
  users.forEach(u => { onlineUsers[u.socketId] = u; });
  renderAdminUserList();
  renderMembersList();
});

// ─── VOICE CHANNEL ───────────────────────────────────────
async function joinVoiceChannel(channelId) {
  if (currentVoiceChannelId === channelId) return;

  document.querySelectorAll('.channel-item').forEach(e => e.classList.remove('active-voice'));
  const vcItem = document.getElementById(`vc-item-${channelId}`);
  if (vcItem) vcItem.classList.add('active-voice');

  cleanUpVoice(false);
  currentVoiceChannelId = channelId;
  headerIcon.textContent = '🔊';
  activeChannelHeader.textContent = activeServers[currentServerId]?.voiceChannels?.[channelId] || channelId;
  dockChannelName.textContent = activeServers[currentServerId]?.voiceChannels?.[channelId] || channelId;

  // Show video grid, hide placeholder
  videoArenaEmpty.style.display = 'none';
  videoGrid.style.display = 'grid';
  voiceDock.style.display = 'flex';

  try {
    localStream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
  } catch (err) {
    console.error('Failed optimized constraints, trying audio-only...', err);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      showToast('Camera unavailable — audio only', '🎙️');
    } catch {
      showToast('Could not access mic/camera', '❌');
      cleanUpVoice();
      return;
    }
  }

  addVideoNode('local', myName, localStream);
  socket.emit('join-voice', { serverId: currentServerId, channelId, userName: myName });
  showToast(`Joined ${activeChannelHeader.textContent}`, '🔊');
}

socket.on('current-room-monkeys', (users) => {
  console.log(`[WebRTC] Found ${users.length} existing monkeys in room`);
  setTimeout(() => {
    users.forEach((user, idx) => {
      // Stagger initiation to avoid signaling flood
      setTimeout(() => initiatePeerConnection(user.id, user.name), idx * 300);
    });
  }, 100);
});

socket.on('peer-joined-voice', ({ id, name }) => {
  appendSystemMessage(`${name} joined the call`);
  initiatePeerConnection(id, name);
  showToast(`${name} joined the call`, '🐒');
  // Update vc user count
  updateVCUserCount();
});

async function initiatePeerConnection(peerId, peerName) {
  if (peerConnections[peerId]) return;

  console.log(`[WebRTC] Initiating connection to ${peerName} (${peerId})`);
  const pc = new RTCPeerConnection(rtcConfig);
  const isPolite = socket.id > peerId;

  peerConnections[peerId] = {
    pc, peerName,
    iceBuffer: [],
    makingOffer: false,
    ignoreOffer: false,
    isPolite,
    isSettingRemoteAnswerPending: false,
    retryCount: 0
  };

  remoteStreams[peerId] = new MediaStream();

  pc.onicecandidate = ({ candidate }) => {
    socket.emit('webrtc-signal', { targetPeerId: peerId, signal: { candidate } });
  };

  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC] ${peerName} connection state: ${pc.connectionState}`);
    if (pc.connectionState === 'failed') {
      handleConnectionFailure(peerId, peerName);
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[WebRTC] ${peerName} ICE state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') {
      pc.restartIce();
    }
  };

  pc.ontrack = (event) => {
    console.log(`[WebRTC] Received track from ${peerName}: ${event.track.kind}`);
    event.streams[0]?.getTracks().forEach(track => remoteStreams[peerId].addTrack(track));
    addVideoNode(peerId, peerName, remoteStreams[peerId]);
  };

  let negotiationInProgress = false;
  pc.onnegotiationneeded = async () => {
    if (negotiationInProgress) return;
    try {
      negotiationInProgress = true;
      console.log(`[WebRTC] Negotiation needed for ${peerName}`);
      peerConnections[peerId].makingOffer = true;
      await pc.setLocalDescription();
      applyBitrateLimits(pc);
      socket.emit('webrtc-signal', { targetPeerId: peerId, signal: { sdp: pc.localDescription } });
    } catch (err) {
      console.error(`Negotiation error for ${peerName}:`, err);
    } finally {
      peerConnections[peerId].makingOffer = false;
      negotiationInProgress = false;
    }
  };

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }
}

function handleConnectionFailure(peerId, peerName) {
  const conn = peerConnections[peerId];
  if (!conn || conn.retryCount >= 3) {
    showToast(`Connection with ${peerName} failed permanently`, '❌');
    return;
  }

  conn.retryCount++;
  showToast(`Retrying connection with ${peerName} (${conn.retryCount}/3)...`, '🔄');
  console.log(`[WebRTC] Retrying connection with ${peerName}, attempt ${conn.retryCount}`);
  
  // Clean up and restart
  const oldPc = conn.pc;
  oldPc.close();
  delete peerConnections[peerId];
  
  setTimeout(() => initiatePeerConnection(peerId, peerName), 2000);
}

socket.on('webrtc-signal', async ({ senderPeerId, signal }) => {
  if (!peerConnections[senderPeerId]) {
    const peerName = onlineUsers[senderPeerId]?.name || 'Monkey';
    await initiatePeerConnection(senderPeerId, peerName);
  }

  const conn = peerConnections[senderPeerId];
  if (!conn) return;

  const pc = conn.pc;
  const peerName = conn.peerName;

  try {
    if (signal.sdp) {
      const offerCollision = (signal.sdp.type === 'offer') &&
                             (conn.makingOffer || pc.signalingState !== 'stable');

      conn.ignoreOffer = !conn.isPolite && offerCollision;
      if (conn.ignoreOffer) {
        console.log(`[WebRTC] Ignoring offer collision from ${peerName}`);
        return;
      }

      const isSettingRemoteAnswerPending = signal.sdp.type === 'answer';
      conn.isSettingRemoteAnswerPending = isSettingRemoteAnswerPending;
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      conn.isSettingRemoteAnswerPending = false;

      if (signal.sdp.type === 'offer') {
        await pc.setLocalDescription();
        applyBitrateLimits(pc);
        socket.emit('webrtc-signal', { targetPeerId: senderPeerId, signal: { sdp: pc.localDescription } });
      }

      // Flush buffered ICE candidates
      while (conn.iceBuffer.length > 0) {
        const cand = conn.iceBuffer.shift();
        try { await pc.addIceCandidate(cand); } catch (e) { console.warn(`[WebRTC] Buffered ICE error:`, e); }
      }
    } else if (signal.candidate) {
      try {
        if (pc.remoteDescription && !conn.isSettingRemoteAnswerPending) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } else {
          conn.iceBuffer.push(new RTCIceCandidate(signal.candidate));
        }
      } catch (err) {
        if (!conn.ignoreOffer) console.error(`[WebRTC] ICE error for ${peerName}:`, err);
      }
    }
  } catch (err) {
    console.error(`[WebRTC] Signaling error for ${peerName}:`, err);
  }
});

socket.on('peer-left-voice', (peerId) => {
  const name = peerConnections[peerId]?.peerName || peerId;
  appendSystemMessage(`${name} left the call`);
  showToast(`${name} left the call`, '👋');

  peerConnections[peerId]?.pc.close();
  delete peerConnections[peerId];
  remoteStreams[peerId]?.getTracks().forEach(t => t.stop());
  delete remoteStreams[peerId];
  document.getElementById(`video-box-${peerId}`)?.remove();
  updateVCUserCount();
});

// ─── VIDEO NODES ─────────────────────────────────────────
function addVideoNode(id, labelName, stream) {
  let box = document.getElementById(`video-box-${id}`);
  if (!box) {
    box = document.createElement('div');
    box.className = 'video-box';
    box.id = `video-box-${id}`;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;

    const placeholder = document.createElement('div');
    placeholder.className = 'no-video-placeholder';
    placeholder.textContent = labelName.charAt(0).toUpperCase();

    const tag = document.createElement('div');
    tag.className = 'user-tag';
    tag.innerHTML = `<span>${labelName}</span><span class="mic-status">🎙️</span>`;

    box.appendChild(video);
    box.appendChild(placeholder);
    box.appendChild(tag);

    // Admin badge
    const userData = Object.values(onlineUsers).find(u => u.name === labelName);
    if (userData?.role === 'admin' || userData?.role === 'owner') {
      const badge = document.createElement('div');
      badge.className = 'admin-badge';
      badge.textContent = userData.role;
      box.appendChild(badge);
    }

    // Context menu on right-click (admin only)
    if (id !== 'local' && (myRole === 'admin' || myRole === 'owner')) {
      box.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, { peerId: id, peerName: labelName });
      });
    }

    videoGrid.appendChild(box);
  }

  const videoEl = box.querySelector('video');
  const hasVideo = stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live');

  if (videoEl.srcObject !== stream) {
    videoEl.srcObject = stream;
    videoEl.muted = (id === 'local');
    videoEl.volume = 1.0;
    if (id !== 'local') videoEl.play().catch(() => {});
  }

  // Show/hide video vs placeholder
  const placeholder = box.querySelector('.no-video-placeholder');
  videoEl.style.display = hasVideo ? 'block' : 'none';
  placeholder.style.display = hasVideo ? 'none' : 'flex';
}

function updateVCUserCount() {
  const count = Object.keys(peerConnections).length + 1; // +1 for self
  const vcItem = document.getElementById(`vc-item-${currentVoiceChannelId}`);
  if (vcItem) {
    vcItem.classList.add('vc-active');
    const countEl = vcItem.querySelector('.user-count');
    if (countEl) countEl.textContent = count;
  }
}

function cleanUpVoice(resetUI = true) {
  socket.emit('leave-voice');
  Object.values(peerConnections).forEach(({ pc }) => pc.close());
  peerConnections = {};
  Object.values(remoteStreams).forEach(s => s.getTracks().forEach(t => t.stop()));
  remoteStreams = {};
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;

  if (resetUI) {
    videoGrid.innerHTML = '';
    videoGrid.style.display = 'none';
    videoArenaEmpty.style.display = 'flex';
    voiceDock.style.display = 'none';
    document.querySelectorAll('.channel-item').forEach(e => {
      e.classList.remove('active-voice');
      e.classList.remove('vc-active');
    });
    currentVoiceChannelId = null;
  }
}

// ─── DOCK CONTROLS ───────────────────────────────────────
document.getElementById('disconnectVoice').addEventListener('click', () => {
  cleanUpVoice(true);
  showToast('Left voice channel', '📵');
});

document.getElementById('toggleMic').addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const btn = document.getElementById('toggleMic');
  btn.classList.toggle('muted', !track.enabled);
  btn.textContent = track.enabled ? '🎙️' : '🔇';
  selfStatus.textContent = track.enabled ? '● online' : '● muted';
  selfStatus.className = 'user-panel-status' + (track.enabled ? '' : ' muted');
  // Update local video tag mic indicator
  const localTag = document.querySelector('#video-box-local .mic-status');
  if (localTag) localTag.textContent = track.enabled ? '🎙️' : '🔇';
});

document.getElementById('toggleVid').addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const btn = document.getElementById('toggleVid');
  btn.classList.toggle('muted', !track.enabled);
  btn.textContent = track.enabled ? '📹' : '🚫';
  // Refresh placeholder visibility
  const box = document.getElementById('video-box-local');
  if (box) {
    box.querySelector('video').style.display = track.enabled ? 'block' : 'none';
    box.querySelector('.no-video-placeholder').style.display = track.enabled ? 'none' : 'flex';
  }
});

// ─── INIT SERVER LIST POPULATE ───────────────────────────
function buildServerUI(servers) {
  activeServers = servers;
  const existingIcons = guildsBar.querySelectorAll('.guild-icon:not(#homeGuildIcon)');
  existingIcons.forEach(e => e.remove());

  Object.keys(servers).forEach((id, idx) => {
    const btn = document.createElement('div');
    btn.className = 'guild-icon' + (idx === 0 ? ' active' : '');
    btn.textContent = servers[id].name.replace(/\s*[\u{1F300}-\u{1FFFF}]/gu, '').trim().substring(0, 2).toUpperCase();
    btn.title = servers[id].name;
    btn.dataset.serverId = id;
    btn.addEventListener('click', () => switchServer(id, btn));
    guildsBar.appendChild(btn);
  });

  switchServer(Object.keys(servers)[0]);
}

// ─── ADMIN PANEL ─────────────────────────────────────────
adminPanelBtn.addEventListener('click', openAdminPanel);
closeAdminPanel.addEventListener('click', () => adminPanel.classList.remove('open'));
adminPanel.addEventListener('click', (e) => { if (e.target === adminPanel) adminPanel.classList.remove('open'); });

function openAdminPanel() {
  adminPanel.classList.add('open');
  renderAdminUserList();
  renderAdminChannelList();
}

function renderAdminUserList() {
  adminUserList.innerHTML = '';
  const users = Object.values(onlineUsers);
  if (users.length === 0) {
    adminUserList.innerHTML = '<div style="color: var(--text-3); font-size: 0.8rem; font-family: \'JetBrains Mono\', monospace;">No users online</div>';
    return;
  }
  users.forEach(user => {
    const row = document.createElement('div');
    row.className = 'admin-user-row';
    const canKick = (myRole === 'owner' || (myRole === 'admin' && user.role === 'member')) && user.name !== myName;
    row.innerHTML = `
      <div class="admin-user-avatar">${user.name.charAt(0).toUpperCase()}</div>
      <span class="admin-user-name">${user.name}</span>
      <span class="admin-user-role ${user.role}">${user.role}</span>
      <div class="admin-actions">
        ${canKick ? `<button class="admin-action-btn danger kick-btn" data-id="${user.socketId}">Kick</button>` : ''}
        ${myRole === 'owner' && user.role !== 'owner' && user.name !== myName
          ? `<button class="admin-action-btn promote-btn" data-id="${user.socketId}">Promote</button>` : ''}
      </div>
    `;
    row.querySelector('.kick-btn')?.addEventListener('click', () => {
      socket.emit('admin-kick', { targetSocketId: user.socketId });
      showToast(`Kicked ${user.name}`, '🚫');
    });
    row.querySelector('.promote-btn')?.addEventListener('click', () => {
      socket.emit('admin-promote', { targetSocketId: user.socketId });
      showToast(`Promoted ${user.name} to admin`, '⬆️');
    });
    adminUserList.appendChild(row);
  });
}

function renderAdminChannelList() {
  adminChannelList.innerHTML = '';
  const server = activeServers[currentServerId];
  if (!server) return;

  const allChannels = [
    ...Object.keys(server.textChannels || {}).map(id => ({ id, type: 'text', name: id })),
    ...Object.keys(server.voiceChannels || {}).map(id => ({ id, type: 'voice', name: server.voiceChannels[id] }))
  ];

  allChannels.forEach(ch => {
    const row = document.createElement('div');
    row.className = 'admin-channel-row';
    row.innerHTML = `
      <span class="ch-icon">${ch.type === 'text' ? '💬' : '🔊'}</span>
      <span class="admin-channel-name">${ch.name}</span>
      <span class="admin-channel-type">${ch.type}</span>
      <div class="admin-actions">
        ${myRole === 'owner' ? `<button class="admin-action-btn danger delete-ch-btn" data-id="${ch.id}" data-type="${ch.type}">Delete</button>` : ''}
      </div>
    `;
    row.querySelector('.delete-ch-btn')?.addEventListener('click', () => {
      socket.emit('admin-delete-channel', { serverId: currentServerId, channelId: ch.id, channelType: ch.type });
      showToast(`Deleted #${ch.name}`, '🗑️');
      adminPanel.classList.remove('open');
    });
    adminChannelList.appendChild(row);
  });
}

addChannelBtn.addEventListener('click', () => {
  const name = newChannelName.value.trim().toLowerCase().replace(/\s+/g, '-');
  const type = newChannelType.value;
  if (!name) return;
  socket.emit('admin-add-channel', { serverId: currentServerId, channelName: name, channelType: type });
  newChannelName.value = '';
  showToast(`Added ${type} channel #${name}`, '✅');
});

clearCacheBtn.addEventListener('click', clearAllCache);

// Server responds to admin actions
socket.on('channels-updated', ({ serverId, server }) => {
  activeServers[serverId] = server;
  if (serverId === currentServerId) renderChannels(server, serverId);
});

socket.on('admin-kicked', () => {
  showToast('You were kicked from voice by an admin', '🚫');
  cleanUpVoice(true);
});

socket.on('role-updated', ({ socketId, newRole }) => {
  if (onlineUsers[socketId]) onlineUsers[socketId].role = newRole;
  // If it's us, update our own role
  if (socketId === socket.id) {
    myRole = newRole;
    adminPanelBtn.style.display = (newRole !== 'member') ? 'flex' : 'none';
    showToast(`Your role updated to: ${newRole}`, '⬆️');
  }
  renderAdminUserList();
});

// ─── CONTEXT MENU ────────────────────────────────────────
let ctxTarget = null;

function showContextMenu(x, y, target) {
  ctxTarget = target;
  contextMenu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 150)}px`;
  contextMenu.style.display = 'block';

  // Toggle visibility of context menu items based on target type
  const isMsg = target.type === 'message';
  ctxPin.style.display = isMsg ? 'flex' : 'none';
  document.getElementById('ctxKick').style.display = !isMsg ? 'flex' : 'none';
}

document.addEventListener('click', () => { contextMenu.style.display = 'none'; });
document.addEventListener('contextmenu', (e) => { 
  if (!e.target.closest('.video-box') && !e.target.closest('.msg-body')) {
    contextMenu.style.display = 'none'; 
  }
});

document.getElementById('ctxMention').addEventListener('click', () => {
  if (ctxTarget) {
    const name = ctxTarget.type === 'message' ? ctxTarget.data.userName : ctxTarget.peerName;
    textInput.value += `@${name} `;
    textInput.focus();
  }
});

document.getElementById('ctxPin').addEventListener('click', () => {
  if (ctxTarget && ctxTarget.type === 'message') {
    socket.emit('pin-message', { 
      serverId: currentServerId, 
      channelId: currentTextChannelId, 
      message: ctxTarget.data 
    });
    showToast('Message pinned', '📌');
  }
});

document.getElementById('ctxKick').addEventListener('click', () => {
  if (ctxTarget && ctxTarget.type !== 'message' && (myRole === 'admin' || myRole === 'owner')) {
    socket.emit('admin-kick', { targetSocketId: ctxTarget.peerId });
    showToast(`Kicked ${ctxTarget.peerName} from voice`, '🚫');
  }
});

// ─── BROWSER NOTIFICATIONS ───────────────────────────────
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

// ─── DISCONNECT HANDLING ─────────────────────────────────
socket.on('disconnect', () => {
  showToast('Disconnected — reconnecting...', '⚡');
  selfStatus.textContent = '● disconnected';
  selfStatus.style.color = 'var(--red)';
});

socket.on('connect', () => {
  if (myName) {
    showToast('Reconnected', '✅');
    selfStatus.textContent = '● online';
    selfStatus.style.color = '';
  }
});
