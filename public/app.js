// public/app.js
const socket = io();

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
  bundlePolicy: 'max-bundle'
};

let localStream = null;
let peerConnections = {}; // Format: { [socketId]: RTCPeerConnection }
let remoteStreams = {};   // Format: { [socketId]: MediaStream }
let activeServers = {};
let currentServerId = null;
let currentTextChannelId = null;
let currentVoiceChannelId = null;
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
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    console.error("Failed to get media with video and audio, trying audio only...", err);
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
  users.forEach(user => {
    initiatePeerConnection(user.id, user.name, true);
  });
});

socket.on('peer-joined-voice', ({ id, name }) => {
  initiatePeerConnection(id, name, false);
});

async function initiatePeerConnection(peerId, peerName, isCaller) {
  if (peerConnections[peerId]) {
    console.log(`⚠️ Connection with ${peerId} already exists, skipping...`);
    return;
  }

  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[peerId] = pc;

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc-signal', { targetPeerId: peerId, signal: { candidate: e.candidate } });
    }
  };

  // Robust multi-track collector for audio & video streams
  pc.ontrack = (e) => {
    console.log(`🎵 Incoming track from ${peerName} (${peerId}):`, e.track.kind);
    
    // Use or create a persistent MediaStream for this specific peer
    if (!remoteStreams[peerId]) {
      remoteStreams[peerId] = new MediaStream();
    }
    
    remoteStreams[peerId].addTrack(e.track);

    // Build or update the video slot in the DOM matrix
    addVideoNode(peerId, peerName, remoteStreams[peerId]);
  };

  if (isCaller) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { targetPeerId: peerId, signal: { sdp: pc.localDescription } });
  }
}

socket.on('webrtc-signal', async ({ senderPeerId, signal }) => {
  const pc = peerConnections[senderPeerId];
  if (!pc) return;

  if (signal.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    if (signal.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc-signal', { targetPeerId: senderPeerId, signal: { sdp: pc.localDescription } });
    }
  } else if (signal.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } catch (err) { /* Ice mapping safety check */ }
  }
});

socket.on('peer-left-voice', (peerId) => {
  if (peerConnections[peerId]) {
    peerConnections[peerId].close();
    delete peerConnections[peerId];
  }
  if (remoteStreams[peerId]) {
    delete remoteStreams[peerId];
  }
  const node = document.getElementById(`video-box-${peerId}`);
  if (node) node.remove();
});

// Overhauled Video/Audio Matrix Node Insertion 
function addVideoNode(id, labelName, stream) {
  let box = document.getElementById(`video-box-${id}`);

  // If the container exists, make sure the current active stream configuration matches
  if (box) {
    const videoEl = box.querySelector('video');
    if (videoEl && videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
    }
    return;
  }

  box = document.createElement('div');
  box.classList.add('video-box');
  box.id = `video-box-${id}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;

  // CRITICAL AUDIO HARDWARE MATCHING RULES:
  if (id === 'local') {
    video.muted = true; // Avoid user hearing self microphone feedback echo loops
  } else {
    video.muted = false; // Force remote peer video elements to be completely unmuted
    video.volume = 1.0;   // Set full system capability volume values
  }

  const tag = document.createElement('div');
  tag.classList.add('user-tag');
  tag.innerText = labelName;

  box.appendChild(video);
  box.appendChild(tag);
  videoGrid.appendChild(box);

  // Modern browser failsafe: Trigger programmatic track activation to bypass strict autoplay policy blocks
  video.play().catch(err => {
    console.log("Browser blocked initial sound. Awaiting any dashboard click from user interaction...", err);
  });
}

function cleanUpVoice() {
  socket.emit('leave-voice');

  Object.keys(peerConnections).forEach(id => {
    peerConnections[id].close();
  });
  peerConnections = {};
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
    audioTrack.enabled = !audioTrack.enabled;
    document.getElementById('toggleMic').classList.toggle('active', !audioTrack.enabled);
  }
};

document.getElementById('toggleVid').onclick = () => {
  if (localStream) {
    const videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = !videoTrack.enabled;
    document.getElementById('toggleVid').classList.toggle('active', !videoTrack.enabled);
  }
};
