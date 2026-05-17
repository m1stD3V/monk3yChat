const { io } = require("socket.io-client");
const socket = io("http://localhost:3000");

socket.on("connect", () => {
    console.log("Connected. Authenticating...");
    socket.emit("authenticate", { username: "user1", password: "pass1" });
});

socket.on("auth-result", (data) => {
    console.log("Auth result:", data);
    if (data.success && data.token) {
        console.log("✅ SUCCESS: Authenticated and received token.");
        
        // Test token login
        console.log("Disconnecting and reconnecting with token...");
        const token = data.token;
        socket.disconnect();
        
        const socket2 = io("http://localhost:3000");
        socket2.on("connect", () => {
            socket2.emit("authenticate", { token });
        });
        
        socket2.on("auth-result", (data2) => {
            console.log("Token auth result:", data2);
            if (data2.success) {
                console.log("✅ SUCCESS: Re-authenticated with token.");
            } else {
                console.log("❌ FAILURE: Token authentication failed.");
            }
            process.exit(0);
        });
        
        setTimeout(() => {
            console.log("❌ FAILURE: Token auth timed out.");
            process.exit(1);
        }, 5000);
    } else {
        console.log("❌ FAILURE: Initial authentication failed.");
        process.exit(1);
    }
});
