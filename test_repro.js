const { io } = require("socket.io-client");
const socket = io("http://localhost:3000");

let initReceived = false;
let monkeysReceived = false;

socket.on("init-discord-data", () => {
    console.log("❌ ERROR: Received init data without authentication!");
    initReceived = true;
});

socket.on("current-room-monkeys", (data) => {
    console.log("❌ ERROR: Received room data without authentication!", data);
    monkeysReceived = true;
});

socket.on("connect", () => {
    console.log("Connected to server. Attempting unauthorized join-voice...");
    socket.emit("join-voice", { serverId: "canopy-hub", channelId: "lounge" });
    
    setTimeout(() => {
        if (!initReceived && !monkeysReceived) {
            console.log("✅ SUCCESS: No unauthorized data received.");
        } else {
            console.log("❌ FAILURE: Unauthorized data was leaked.");
        }
        process.exit(0);
    }, 2000);
});
