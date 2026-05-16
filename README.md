# 🐒 monkey.chat | Premium Jungle Call

A modern, high-performance video chat application built with **WebRTC** and **Socket.io**. Experience seamless communication with a unique jungle-themed aesthetic.

## 🌟 Features

- **Peer-to-Peer Video/Audio:** Low-latency 1-on-1 calls using WebRTC.
- **Screen Sharing:** Share your jungle intel with high-quality screen capture.
- **Real-time Chat:** Instant messaging with custom monkey/gorilla avatars.
- **Media Controls:** Easily toggle your microphone and camera on the fly.
- **Jungle UI:** A polished, dark-themed interface with responsive sidebars and a floating controls dock.
- **No-Install Necessary:** Works directly in any modern web browser.

## 🛠️ Technical Stack

- **Frontend:** HTML5, Vanilla CSS, JavaScript (ES6+)
- **Backend:** Node.js, Express
- **Signaling:** Socket.io
- **P2P Connection:** WebRTC (RTCPeerConnection)
- **STUN Servers:** Google Public STUN

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v14 or higher recommended)
- npm (comes with Node.js)

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/m1stD3V/monk3yChat.git
    cd monk3yChat
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Start the jungle server:**
    ```bash
    npm start
    ```

4.  **Open in your browser:**
    Navigate to `http://localhost:3000` to start your call. Open the same link in another tab or on a different device to test the peer connection.

## 🍌 How it Works (Signaling)

WebRTC is used for direct peer-to-peer media streaming. However, peers need a way to find each other and exchange connection details. `monkey.chat` uses a Node.js server with Socket.io as a **signaling channel**:

1.  **Join Room:** Peer A joins a specific room ID.
2.  **Notification:** When Peer B joins, the server notifies Peer A.
3.  **Offer/Answer:** Peer A creates an SDP Offer and sends it to Peer B via the server. Peer B responds with an SDP Answer.
4.  **ICE Candidates:** Both peers exchange network information (ICE candidates) until a direct connection is established.
5.  **Direct Stream:** Once connected, the server is no longer involved in the video/audio stream!

---
*Created with 🍌 in the canopy.*
