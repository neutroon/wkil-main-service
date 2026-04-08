import { createServer } from "http";
import app from "./app";
import dotenv from "dotenv";
import { initSocket } from "./utils/socket";

dotenv.config();

const PORT = Number(process.env.PORT) || 8080;

const httpServer = createServer(app);
initSocket(httpServer);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
