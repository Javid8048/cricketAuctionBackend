import dns from 'dns';
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createApp } from './app';
import { setupSocketHandlers } from './websocket/socket.handler';

/**
 * Automatically resolve and map Neon PostgreSQL hostnames to IPv4 in /etc/hosts.
 * This completely prevents Linux glibc and Prisma's native Rust query engine
 * from attempting IPv6 egress connections on platforms like Render where IPv6 is not routed.
 */
async function ensureIpv4HostMappings(): Promise<void> {
  const hostnames = new Set<string>();
  const dbUrl = process.env.DATABASE_URL;

  if (dbUrl) {
    try {
      const parsed = new URL(dbUrl);
      if (parsed.hostname) {
        hostnames.add(parsed.hostname);
        if (parsed.hostname.includes('-pooler.')) {
          hostnames.add(parsed.hostname.replace('-pooler.', '.'));
        } else if (parsed.hostname.includes('.aws.neon.tech')) {
          hostnames.add(parsed.hostname.replace('.aws.neon.tech', '-pooler.aws.neon.tech'));
        }
      }
    } catch (_) {
      const match = dbUrl.match(/@([^:/]+)/);
      if (match && match[1]) {
        hostnames.add(match[1]);
      }
    }
  }

  // Pre-seed known Neon endpoints as safety fallback
  hostnames.add('ep-bitter-glitter-ar3bj3xx.c-4.us-west-2.aws.neon.tech');
  hostnames.add('ep-bitter-glitter-ar3bj3xx-pooler.c-4.us-west-2.aws.neon.tech');

  const knownFallbackIps = ['32.188.23.151', '34.211.130.9', '32.184.219.193'];
  let entriesToAdd = '';

  for (const host of hostnames) {
    let resolvedIpv4: string | null = null;
    try {
      const addrs = await dns.promises.resolve4(host);
      if (addrs && addrs.length > 0) {
        resolvedIpv4 = addrs[0];
      }
    } catch (_) {
      resolvedIpv4 = knownFallbackIps[0];
    }

    if (resolvedIpv4) {
      entriesToAdd += `${resolvedIpv4} ${host}\n`;
      console.log(`[IPv4 Host Mappings] Mapped ${host} -> ${resolvedIpv4}`);
    }
  }

  if (entriesToAdd && process.platform !== 'win32') {
    try {
      fs.appendFileSync('/etc/hosts', `\n# Forced IPv4 for Neon\n${entriesToAdd}`);
      console.log('[IPv4 Host Mappings] Appended IPv4 host entries to /etc/hosts');
    } catch (err: any) {
      console.warn('[IPv4 Host Mappings Warning] Could not append to /etc/hosts:', err.message);
    }
  }
}

// Fire IPv4 mapping and initial DB verification asynchronously
(async () => {
  await ensureIpv4HostMappings();
  try {
    const { prisma } = await import('./prisma');
    await prisma.$queryRaw`SELECT 1`;
    console.log('[Database Connection] Verified Neon PostgreSQL connection successfully!');
  } catch (err: any) {
    console.warn('[Database Connection Startup Note]:', err.message);
  }
})();

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
