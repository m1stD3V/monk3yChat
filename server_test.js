const process = { env: { AUTH_CREDENTIALS: "user1:pass1;user2:pass2" } };
// Copy of the logic from server.js
const loadCredentials = () => {
    const authEnv = process.env.AUTH_CREDENTIALS;
    return authEnv.split(';').filter(line => line.includes(':')).map(line => {
        const [username, password] = line.split(':');
        return { username: username.trim(), password: password.trim() };
    });
};
const credentials = loadCredentials();
const attempt = (u, p) => console.log("Attempt", u, p, !!credentials.find(c => c.username === u && c.password === p));
attempt("user1", "pass1");
