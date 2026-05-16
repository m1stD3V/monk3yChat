// public/app.js
const socket = io({
  transports: ['websocket'],
  upgrade: false
});

// High-Scale Optimization Constants
const MEDIA_CONSTRAINTS = {
  video: {
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 15, max: 20 }
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
};
const MAX_VIDEO_BITRATE = 250000; // 250kbps for 10-person mesh stability

// Production WebRTC Configuration utilizing your dedicated Metered.ca infrastructure Relay
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }, // Public Google STUN
    { urls: 'stun:stun.metered.ca:80' },       // Metered STUN
    {
      urls: 'turn:global.turn.metered.ca:80',
      username: '3668af38c652028b1a39b682',
      credential: 'TdkzU0crNP4oPMm1'
    },
    {
      urls: 'turn:global.turn.metered.ca:443?transport=tcp', // Fallback for strict firewalls/ports
      username: '3668af38c652028b1a39b682',
      credential: 'TdkzU0crNP4oPMm1'
    }
  ],
  bundlePolicy: 'max-bundle',
  iceCandidatePoolSize: 10 // Pre-gather candidates
};

let localStream = null;
let peerConnections = {}; // Format: { [socketId]: { pc, iceBuffer, makingOffer, ignoreOffer, isPolite, isSettingRemoteAnswerPending } }
let remoteStreams = {};   // Format: { [socketId]: MediaStream }
let activeServers = {};
let currentServerId = null;
let currentTextChannelId = null;
let currentVoiceChannelId = null;
// ... existing constants ...
let myName = "Monkey_" + Math.floor(Math.random() * 900);

// UI Elements
const guildsBar = document.getElementById('guildsBar');
const channelListContainer = document.getElementById('channelListContainer');
const currentServerName = document.getElementById('currentServerName');
const activeChannelHeader = document.getElementById('activeChannelHeader');
const videoGrid = document.getElementById('videoGrid');
const msgFeed = document.getElementById('msgFeed');
const textInput = document.getElementById('textInput');
const voiceDock = document.getElementById('voiceDock');
const loginOverlay = document.getElementById('loginOverlay');
const loginBtn = document.getElementById('loginBtn');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginError = document.getElementById('loginError');

// Authentication
loginBtn.addEventListener('click', () => {
  const username = usernameInput.value;
  const password = passwordInput.value;
  socket.emit('authenticate', { username, password });
});

socket.on('auth-result', ({ success }) => {
  if (success) {
    loginOverlay.style.display = 'none';
    myName = usernameInput.value;
    console.log(`[DEBUG] Login success. Username updated to: ${myName}`);
  } else {
    loginError.style.display = 'block';
  }
});

// Ensure browser media element streams pick up interactions for autoplay permissions
document.body.addEventListener('click', () => {
  document.querySelectorAll('video').forEach(video => {
    if (video.srcObject && video.id !== 'video-box-local') {
      video.play().catch(() => { });
    }
  });
}, { once: false });

// --- 1. POPULATE DISCORD STRUCTURE ---
socket.on('init-discord-data', ({ servers }) => {
  activeServers = servers;
  guildsBar.innerHTML = '';

  Object.keys(servers).forEach((id, idx) => {
    const btn = document.createElement('div');
    btn.classList.add('guild-icon');
    if (idx === 0) btn.classList.add('active');
    btn.innerText = servers[id].name.substring(0, 2);
    btn.title = servers[id].name;
    btn.onclick = () => switchServer(id, btn);
    guildsBar.appendChild(btn);
  });

  // Default to first server
  switchServer(Object.keys(servers)[0]);
});

function switchServer(serverId, element = null) {
  currentServerId = serverId;
  const server = activeServers[serverId];
  currentServerName.innerText = server.name;

  if (element) {
    document.querySelectorAll('.guild-icon').forEach(e => e.classList.remove('active'));
    element.classList.add('active');
  }

  renderChannels(server);
}

function renderChannels(server) {
  channelListContainer.innerHTML = '';

  // Render Text Channels
  const tcHead = document.createElement('div');
  tcHead.classList.add('ch-category');
  tcHead.innerText = "Text Channels";
  channelListContainer.appendChild(tcHead);

  Object.keys(server.textChannels).forEach(id => {
    const el = document.createElement('div');
    el.classList.add('channel-item');
    el.innerText = "💬 " + id;
    el.onclick = () => joinTextChannel(id);
    channelListContainer.appendChild(el);
  });

  // Render Voice Channels
  const vcHead = document.createElement('div');
  vcHead.classList.add('ch-category');
  vcHead.innerText = "Voice Channels";
  channelListContainer.appendChild(vcHead);

  Object.keys(server.voiceChannels).forEach(id => {
    const el = document.createElement('div');
    el.classList.add('channel-item');
    el.id = `vc-item-${id}`;
    el.innerText = "🔊 " + server.voiceChannels[id];
    el.onclick = () => joinVoiceChannel(id);
    channelListContainer.appendChild(el);
  });

  // Auto-join first text channel
  joinTextChannel(Object.keys(server.textChannels)[0]);
}

// --- 2. TEXT CHAT SYSTEM ---
function joinTextChannel(channelId) {
  currentTextChannelId = channelId;
  activeChannelHeader.innerText = `# ${channelId}`;
  msgFeed.innerHTML = '';
  socket.emit('join-text', { serverId: currentServerId, channelId });
}

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && textInput.value.trim()) {
    socket.emit('send-text-msg', {
      serverId: currentServerId,
      channelId: currentTextChannelId,
      text: textInput.value.trim(),
      userName: myName
    });
    textInput.value = '';
  }
});

socket.on('receive-text-msg', ({ userName, text }) => {
  const line = document.createElement('div');
  line.classList.add('msg-line');
  line.innerHTML = `<b>${userName}:</b> ${text}`;
  msgFeed.appendChild(line);
  msgFeed.scrollTop = msgFeed.scrollHeight;
});

// --- 3. MULTI-USER WEBRTC VOICE/VIDEO LOGIC ---
async function joinVoiceChannel(channelId) {
  if (currentVoiceChannelId === channelId) return;

  // Clear old visual channel highlights
  document.querySelectorAll('.channel-item').forEach(e => e.classList.remove('active-voice'));
  const targetedItem = document.getElementById(`vc-item-${channelId}`);
  if (targetedItem) targetedItem.classList.add('active-voice');

  cleanUpVoice();
  currentVoiceChannelId = channelId;
  voiceDock.style.display = 'flex';

  // Acquire audio and video hardware tracks
  try {
    localStream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
  } catch (err) {
    console.error("Failed to get media with optimized constraints, trying audio only...", err);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    } catch (audioErr) {
      console.error("Failed to get even audio...", audioErr);
      alert("Could not access microphone/camera. Please check permissions.");
      cleanUpVoice();
      return;
    }
  }

  addVideoNode('local', myName, localStream);

  socket.emit('join-voice', {
    serverId: currentServerId,
    channelId: currentVoiceChannelId,
    userName: myName
  });
}

socket.on('current-room-monkeys', (users) => {
  console.log(`[DEBUG] Received current-room-monkeys:`, users);
  // Add a small delay to ensure socket.id is properly set
  setTimeout(() => {
    users.forEach(user => {
      console.log(`[DEBUG] Initiating peer connection for existing user:`, user);
      initiatePeerConnection(user.id, user.name);
    });
  }, 100);
});

socket.on('peer-joined-voice', ({ id, name }) => {
  initiatePeerConnection(id, name);
});

async function initiatePeerConnection(peerId, peerName) {
  if (peerConnections[peerId]) {
    console.log(`⚠️ Connection to ${peerName} already exists, skipping`);
    return;
  }

  const pc = new RTCPeerConnection(rtcConfig);
  const isPolite = socket.id < peerId; // Lexicographic comparison for deterministic politeness

  peerConnections[peerId] = {
    pc,
    iceBuffer: [],
    makingOffer: false,
    ignoreOffer: false,
    isPolite,
    isSettingRemoteAnswerPending: false,
    peerName // Store name for debugging
  };

  // PRE-CREATE the remote MediaStream to avoid timing issues
  remoteStreams[peerId] = new MediaStream();

  console.log(`🤝 Initiating with ${peerName} (${peerId}). I am ${isPolite ? 'POLITE' : 'IMPOLITE'}`);

  // CONNECTION STATE MONITORING
  pc.oniceconnectionstatechange = () => {
    console.log(`❄️ ICE State with ${peerName}: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') {
      console.log(`🔄 Attempting ICE Restart for ${peerName}...`);
      pc.restartIce();
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`🔗 Connection State with ${peerName}: ${pc.connectionState}`);
  };

  // ICE CANDIDATES
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc-signal', { targetPeerId: peerId, signal: { candidate: e.candidate } });
    }
  };

  // TRACK HANDLING - THIS IS CRITICAL
  pc.ontrack = (e) => {
    console.log(`🎵 Incoming ${e.track.kind} track from ${peerName} (${peerId}), id: ${e.track.id}`);

    // Add track to the persistent MediaStream for this peer
    const existingTrack = remoteStreams[peerId].getTracks().find(t => t.id === e.track.id);
    if (!existingTrack) {
      remoteStreams[peerId].addTrack(e.track);
      console.log(`✅ Added ${e.track.kind} track to ${peerName}'s stream. Total tracks: ${remoteStreams[peerId].getTracks().length}`);
    }

    // Handle track ending (camera off, etc)
    e.track.onended = () => {
      console.log(`🛑 Track ${e.track.kind} ended from ${peerName}`);
      remoteStreams[peerId].removeTrack(e.track);
    };

    // Update/create video element with the stream
    addVideoNode(peerId, peerName, remoteStreams[peerId]);
  };

  // PERFECT NEGOTIATION PATTERN - CRITICAL FIXES
  let negotiationInProgress = false;

  pc.onnegotiationneeded = async () => {
    // Prevent overlapping negotiations
    if (negotiationInProgress) {
      console.log(`⏳ Negotiation already in progress for ${peerName}, queuing...`);
      return;
    }

    try {
      negotiationInProgress = true;
      peerConnections[peerId].makingOffer = true;

      console.log(`📤 Creating offer for ${peerName}...`);
      await pc.setLocalDescription();

      // Apply bitrate limits to the outgoing video sender
      applyBitrateLimits(pc);

      socket.emit('webrtc-signal', { targetPeerId: peerId, signal: { sdp: pc.localDescription } });
      console.log(`📤 Sent ${pc.localDescription.type} to ${peerName}`);
    } catch (err) {
      console.error(`❌ Negotiation error for ${peerName}:`, err);
    } finally {
      peerConnections[peerId].makingOffer = false;
      negotiationInProgress = false;
    }
  };

  // ADD LOCAL TRACKS - This triggers negotiationneeded
  if (localStream) {
    localStream.getTracks().forEach(track => {
      const sender = pc.addTrack(track, localStream);
      console.log(`📤 Added local ${track.kind} track to connection with ${peerName}`);
    });
  }
}

function applyBitrateLimits(pc) {
  pc.getSenders().forEach(sender => {
    if (sender.track && sender.track.kind === 'video') {
      const parameters = sender.getParameters();
      if (!parameters.encodings) parameters.encodings = [{}];
      parameters.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
      sender.setParameters(parameters).then(() => {
        console.log(`📉 Bitrate limited to ${MAX_VIDEO_BITRATE / 1000}kbps`);
      }).catch(e => console.error("Could not apply bitrate limits", e));
    }
  });
}

socket.on('webrtc-signal', async ({ senderPeerId, signal }) => {
  console.log(`[DEBUG] Received signal from ${senderPeerId}:`, signal);
  const conn = peerConnections[senderPeerId];
  if (!conn) {
    console.warn(`[DEBUG] Received signal from unknown peer ${senderPeerId}`);
    return;
  }
// ...

  const pc = conn.pc;
  const peerName = conn.peerName || senderPeerId;

  try {
    if (signal.sdp) {
      const offerCollision = signal.sdp.type === 'offer' && (conn.makingOffer || pc.signalingState !== 'stable');

      conn.ignoreOffer = !conn.isPolite && offerCollision;

      if (conn.ignoreOffer) {
        console.log(`⚠️ Collision detected. Impolite peer ignoring offer from ${peerName}`);
        return;
      }

      // CRITICAL: Set flag to prevent race condition with answers
      conn.isSettingRemoteAnswerPending = signal.sdp.type === 'answer';

      console.log(`📥 Received ${signal.sdp.type} from ${peerName}`);
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      console.log(`✅ Set remote ${signal.sdp.type} from ${peerName}`);

      conn.isSettingRemoteAnswerPending = false;

      // FLUSH ICE CANDIDATE BUFFER
      if (conn.iceBuffer.length > 0) {
        console.log(`🧊 Flushing ${conn.iceBuffer.length} buffered ICE candidates for ${peerName}`);
        for (const candidate of conn.iceBuffer) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error(`Failed to add buffered candidate for ${peerName}:`, e);
          }
        }
        conn.iceBuffer = [];
      }

      // If we received an offer, create and send answer
      if (signal.sdp.type === 'offer') {
        await pc.setLocalDescription();
        applyBitrateLimits(pc);
        socket.emit('webrtc-signal', { targetPeerId: senderPeerId, signal: { sdp: pc.localDescription } });
        console.log(`📤 Sent answer to ${peerName}`);
      }
    } else if (signal.candidate) {
      try {
        // Only add candidate if we have a remote description
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          console.log(`🧊 Added ICE candidate from ${peerName}`);
        } else {
          console.log(`🧊 Buffering ICE candidate from ${peerName} (no remote description yet)`);
          conn.iceBuffer.push(signal.candidate);
        }
      } catch (err) {
        if (!conn.ignoreOffer) {
          console.error(`❌ ICE candidate error for ${peerName}:`, err);
        }
      }
    }
  } catch (err) {
    console.error(`❌ Signaling error for ${peerName}:`, err);
  }
});

socket.on('peer-left-voice', (peerId) => {
  console.log(`👋 Peer left: ${peerId}`);

  if (peerConnections[peerId]) {
    peerConnections[peerId].pc.close();
    delete peerConnections[peerId];
  }
  if (remoteStreams[peerId]) {
    remoteStreams[peerId].getTracks().forEach(track => track.stop());
    delete remoteStreams[peerId];
  }
  const node = document.getElementById(`video-box-${peerId}`);
  if (node) node.remove();
});

// FIXED: Video/Audio Node Insertion with proper stream handling
function addVideoNode(id, labelName, stream) {
  let box = document.getElementById(`video-box-${id}`);

  // Create the box if it doesn't exist
  if (!box) {
    box = document.createElement('div');
    box.classList.add('video-box');
    box.id = `video-box-${id}`;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;

    const tag = document.createElement('div');
    tag.classList.add('user-tag');
    tag.innerText = labelName;

    box.appendChild(video);
    box.appendChild(tag);
    videoGrid.appendChild(box);
  }

  const videoEl = box.querySelector('video');

  // CRITICAL: Only assign srcObject if it's actually different
  if (videoEl.srcObject !== stream) {
    console.log(`📺 Assigning stream to video element for ${labelName}. Tracks: ${stream.getTracks().length} (${stream.getAudioTracks().length} audio, ${stream.getVideoTracks().length} video)`);
    videoEl.srcObject = stream;

    // CRITICAL: Set audio properties AFTER assignment
    videoEl.muted = (id === 'local');
    videoEl.volume = 1.0;

    // Force play for remote streams
    if (id !== 'local') {
      videoEl.play().catch(err => {
        console.log(`🔇 ${labelName} waiting for user interaction to play:`, err.message);
      });
    }
  }

  // Verify tracks are active
  const hasActiveAudio = stream.getAudioTracks().some(t => t.enabled && t.readyState === 'live');
  const hasActiveVideo = stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live');

  if (id !== 'local') {
    console.log(`🔍 ${labelName} track status: Audio ${hasActiveAudio ? '✅' : '❌'}, Video ${hasActiveVideo ? '✅' : '❌'}`);
  }
}

function cleanUpVoice() {
  socket.emit('leave-voice');

  Object.keys(peerConnections).forEach(id => {
    peerConnections[id].pc.close();
  });
  peerConnections = {};

  Object.keys(remoteStreams).forEach(id => {
    remoteStreams[id].getTracks().forEach(track => track.stop());
  });
  remoteStreams = {};

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  videoGrid.innerHTML = '';
  voiceDock.style.display = 'none';
}

document.getElementById('disconnectVoice').onclick = () => {
  cleanUpVoice();
  document.querySelectorAll('.channel-item').forEach(e => e.classList.remove('active-voice'));
};

// Toggle Controls
document.getElementById('toggleMic').onclick = () => {
  if (localStream) {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      document.getElementById('toggleMic').classList.toggle('active', !audioTrack.enabled);
    }
  }
};

document.getElementById('toggleVid').onclick = () => {
  if (localStream) {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      document.getElementById('toggleVid').classList.toggle('active', !videoTrack.enabled);
    }
  }
};
