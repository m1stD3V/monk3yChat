const { io } = require("socket.io-client");
const socket = io("http://localhost:3000");

socket.on("connect", () => {
    socket.emit("authenticate", { username: "user1", password: "pass1" });
});

socket.on("auth-result", (data) => {
    console.log("Auth result:", data);
    process.exit(0);
});
