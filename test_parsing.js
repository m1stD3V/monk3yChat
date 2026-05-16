const authEnv = "user1:pass1;user2:pass2";
const loadCredentials = (env) => {
    return env.split(';').filter(line => line.includes(':')).map(line => {
        const [username, password] = line.split(':');
        return { username: username.trim(), password: password.trim() };
    });
};
const creds = loadCredentials(authEnv);
console.log("Parsed credentials:", creds);

const testAuth = (username, password) => {
    const user = creds.find(c => c.username === username && c.password === password);
    console.log("Auth attempt for " + username + ":", !!user);
};

testAuth("user1", "pass1");
testAuth("wrong", "wrong");
