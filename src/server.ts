import dns from 'dns';
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createApp } from './app';
import { setupSocketHandlers } from './websocket/socket.handler';

const PORT = process.env.PORT || 5000;
const app = createApp();
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

setupSocketHandlers(io);

// Auto-restore data durability check
import('./utils/persistence').then(({ restoreDatabaseIfEmpty }) => {
  restoreDatabaseIfEmpty().catch((err) => {
    console.error('[STARTUP PERSISTENCE CHECK ERROR]', err);
  });
});

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🏏 CRICKET AUCTION ARENA - BACKEND SERVER RUNNING 🏏`);
  console.log(`📡 Local:   http://localhost:${PORT}`);
  console.log(`🌐 Network: http://192.168.29.136:${PORT}`);
  console.log(`⚡ WebSocket Server: Ready for real-time auction bids`);
  console.log(`====================================================`);
});

export { server, io };
