import { Server, Socket } from 'socket.io';
import { auctionEngine } from '../controllers/auction.controller';
import { verifyToken } from '../utils/token';

export function setupSocketHandlers(io: Server) {
  auctionEngine.setSocketServer(io);

  io.on('connection', async (socket: Socket) => {
    console.log(`[Socket Connected]: ${socket.id}`);

    // Send initial auction state immediately on connection
    try {
      const state = await auctionEngine.getAuctionState();
      socket.emit('auction:init', state);
    } catch (err) {
      console.error('Error sending init state to socket:', err);
    }

    // Optional direct socket bid handling
    socket.on('bid:place', async (data: { token?: string; amount?: number }) => {
      try {
        let teamId: string | null = null;
        if (data.token) {
          const payload = verifyToken(data.token);
          if (payload.teamId) {
            teamId = payload.teamId;
          }
        }

        if (!teamId) {
          socket.emit('bid:error', { message: 'Must be logged in as a team to place a bid.' });
          return;
        }

        const result = await auctionEngine.placeBid(teamId, data.amount);
        socket.emit('bid:success', result);
      } catch (err: any) {
        socket.emit('bid:error', { message: err.message || 'Bid failed' });
      }
    });

    // Keepalive ping for long-lasting WebSocket connection (prevents proxy timeouts)
    socket.on('ping:keepalive', () => {
      socket.emit('pong:keepalive', { time: Date.now() });
    });

    // Client auth synchronization upon login
    socket.on('auth:sync', (data: { token?: string }) => {
      if (data?.token) {
        try {
          const payload = verifyToken(data.token);
          (socket as any).userId = payload.userId;
          (socket as any).teamId = payload.teamId;
          socket.emit('auth:synced', { success: true, teamId: payload.teamId });
        } catch (e) {
          // invalid token
        }
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Socket Disconnected]: ${socket.id}`);
    });
  });
}
