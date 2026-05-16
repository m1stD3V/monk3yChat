/**
 * app.js - monkey.chat client-side logic
 * 
 * Handles WebRTC peer connection, media capture, socket signaling, 
 * and UI interactions for the jungle-themed video chat.
 */

const socket = io();

// WebRTC Configuration: Using Google's public STUN server for NAT traversal
const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// Application State
let localStream;      // Our camera/mic stream
let remoteStream;     // The other monkey's stream
let peerConnection;   // The RTCPeerConnection object
let currentRoom = "canopy-canale-9"; // Default room ID
let screenStream = null; // Holds screen share stream if active

// --- UI Elements ---
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const chatPanel = document.getElementById('chatPanel');
const toggleChatBtn = document.getElementById('toggleChat');
const peerStatusText = document.getElementById('peer-status-text');
const shareScreenBtn = document.getElementById('shareScreen');
const toggleMicBtn = document.getElementById('toggleMic');
const toggleVidBtn = document.getElementById('toggleVid');

// Initialize room label
document.getElementById('room-name-label').innerText = currentRoom;

/**
 * Starts the application by capturing local media and joining the signaling room.
 */
async function init() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    socket.emit('join-room', currentRoom);
  } catch (err) {
    console.error("Invasive tech blocked: Error accessing media devices.", err);
    peerStatusText.innerText = "Media permissions blocked.";
  }
}

/**
 * Creates and configures the RTCPeerConnection.
 * @param {string} targetSocketId - The socket ID of the peer to connect to.
 */
function createPeerConnection(targetSocketId) {
  peerConnection = new RTCPeerConnection(rtcConfig);

  // Add all local tracks (Audio/Video) to the connection
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  // Handle incoming remote media tracks
  peerConnection.ontrack = (event) => {
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
      peerStatusText.innerText = "Connected to Peer 🦍";
    }
    remoteStream.addTrack(event.track);
  };

  // Send ICE candidates to the peer via the signaling server
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { to: targetSocketId, signal: { candidate: event.candidate } });
    }
  };
}

// --- Socket Signaling Handlers ---

/**
 * When a new user connects to the room, we act as the 'caller' and create an offer.
 */
socket.on('user-connected', async (userId) => {
  peerStatusText.innerText = "Peer incoming...";
  createPeerConnection(userId);
  
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  
  socket.emit('signal', { to: userId, signal: { sdp: peerConnection.localDescription } });
});

/**
 * Handles incoming signaling data (SDP offers/answers and ICE candidates).
 */
socket.on('signal', async (data) => {
  // Initialize peer connection if it doesn't exist yet
  if (!peerConnection) createPeerConnection(data.from);

  if (data.signal.sdp) {
    // Handle SDP offer or answer
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));
    
    // If it's an offer, we must create and send an answer
    if (data.signal.sdp.type === 'offer') {
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('signal', { to: data.from, signal: { sdp: peerConnection.localDescription } });
    }
  } else if (data.signal.candidate) {
    // Handle ICE candidates
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate));
    } catch (e) {
      console.error("ICE mapping glitch:", e);
    }
  }
});

socket.on('user-disconnected', () => {
  peerStatusText.innerText = "Peer left back to trees.";
  if (remoteVideo) remoteVideo.srcObject = null;
  remoteStream = null;
  // Note: In a production app, we'd also close the peerConnection here
});

// --- UI Interaction Handlers ---

// Toggle Chat Sidebar
toggleChatBtn.addEventListener('click', () => {
  const isHidden = chatPanel.style.display === 'none';
  chatPanel.style.display = isHidden ? 'flex' : 'none';
  toggleChatBtn.classList.toggle('active-yellow', isHidden);
});

// Screen Sharing Logic
shareScreenBtn.addEventListener('click', async () => {
  if (!screenStream) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const videoTrack = screenStream.getVideoTracks()[0];
      
      // Replace the camera track with the screen track in the peer connection
      const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
      sender.replaceTrack(videoTrack);
      
      localVideo.srcObject = screenStream;
      shareScreenBtn.classList.add('active-yellow');

      // Revert back when screen sharing is stopped via browser UI
      videoTrack.onended = () => stopScreenShare();
    } catch (err) {
      console.error("Screen capture rejected:", err);
    }
  } else {
    stopScreenShare();
  }
});

function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach(track => track.stop());
  screenStream = null;

  const videoTrack = localStream.getVideoTracks()[0];
  const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
  sender.replaceTrack(videoTrack);
  
  localVideo.srcObject = localStream;
  shareScreenBtn.classList.remove('active-yellow');
}

// Media Control Toggles (Mic/Video)
toggleMicBtn.addEventListener('click', () => {
  const audioTrack = localStream.getAudioTracks()[0];
  audioTrack.enabled = !audioTrack.enabled;
  toggleMicBtn.innerText = audioTrack.enabled ? '🎙️' : '🚫';
  toggleMicBtn.classList.toggle('btn-danger', !audioTrack.enabled);
});

toggleVidBtn.addEventListener('click', () => {
  const videoTrack = localStream.getVideoTracks()[0];
  videoTrack.enabled = !videoTrack.enabled;
  toggleVidBtn.innerText = videoTrack.enabled ? '📹' : '❌';
  toggleVidBtn.classList.toggle('btn-danger', !videoTrack.enabled);
});

// --- Chat Functionality ---

sendBtn.addEventListener('click', sendTextMessage);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTextMessage(); });

function sendTextMessage() {
  const msg = chatInput.value.trim();
  if (msg) {
    socket.emit('chat-message', { roomId: currentRoom, text: msg, hostId: socket.id });
    chatInput.value = '';
  }
}

socket.on('chat-message', (data) => {
  const msgEl = document.createElement('div');
  msgEl.classList.add('msg-bubble');

  // Determine if we sent this message or if it's from a peer
  const isSelf = socket.id === data.senderId || (data.sender === 'Host 🐒' && !peerConnection);
  if (isSelf) {
    msgEl.classList.add('self');
  }

  msgEl.innerHTML = `
        <div class="msg-meta">${data.sender}</div>
        <div class="msg-text">${data.text}</div>
    `;
  chatMessages.appendChild(msgEl);
  chatMessages.scrollTop = chatMessages.scrollHeight; // Auto-scroll to bottom
});

// Entry point
init();
