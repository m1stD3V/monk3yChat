/**
 * server.js - monkey.chat signaling server
 * 
 * This server facilitates the WebRTC connection by acting as a signaling channel.
 * It handles room management and relays SDP offers, answers, and ICE candidates
 * between peers. It also manages a simple text chat.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Initialize Socket.io with CORS allowing all origins for development flexibility
const io = new Server(server, {
  cors: { origin: "*" }
});

// Serve static frontend assets from the /public directory
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log(`🐒 Monkey connected: ${socket.id}`);

  /**
   * Room Management:
   * When a client joins a room, they are put into a Socket.io room.
   * We notify existing room members that a new user has connected,
   * triggering the WebRTC offer process on the client side.
   */
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log(`🍌 Monkey ${socket.id} joined room: ${roomId}`);
    // Alert existing room occupants that a new peer has initialized
    socket.to(roomId).emit('user-connected', socket.id);
  });

  /**
   * Signaling Relay:
   * WebRTC requires peers to exchange Session Description Protocol (SDP) and 
   * Interactive Connectivity Establishment (ICE) candidates. 
   * This event relays that data between specific peers.
   */
  socket.on('signal', (data) => {
    io.to(data.to).emit('signal', {
      from: socket.id,
      signal: data.signal
    });
  });

  /**
   * Text Chat:
   * Relays text messages to everyone in the room.
   * Includes sender identification to allow the UI to style local vs remote messages.
   */
  socket.on('chat-message', (data) => {
    io.to(data.roomId).emit('chat-message', {
      senderId: socket.id, 
      sender: socket.id === data.hostId ? 'Host 🐒' : 'Peer 🦍',
      text: data.text
    });
  });

  socket.on('disconnect', () => {
    console.log(`🙈 Monkey disconnected: ${socket.id}`);
    // Notify others in all rooms this socket was in
    io.emit('user-disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🍌 Jungle server successfully deployed at http://localhost:${PORT}`);
});
