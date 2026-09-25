import "dotenv/config";
import http from "http";
import app from "./app.js";
import { initSockets } from "./core/sockets/index.js";

const PORT = Number(process.env.PORT) || 4000;
const server = http.createServer(app);

// Mount Socket.io on the HTTP server
initSockets(server);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MoveX API & Socket server running on http://127.0.0.1:${PORT}`);
});

export { server, app };
