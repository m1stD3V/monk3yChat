const { io } = require("socket.io-client");
const socket = io("http://localhost:3000");

// Emulate receiving data before auth
socket.on("init-discord-data", () => console.log("Init received"));
// Emulate sending join-voice
socket.emit("join-voice", { serverId: "canopy-hub", channelId: "lounge", userName: "test" });
