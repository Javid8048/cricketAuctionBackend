import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { restoreDatabaseIfEmpty } from '../src/utils/persistence';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Checking & Initializing System Records (Non-Destructive) ---');

  // 1. Ensure Primary Admin User exists without wiping other users
  const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || 'Admin@123';
  const adminPasswordHash = await bcrypt.hash(initialPassword, 10);

  const existingKhader = await prisma.user.findFirst({
    where: {
      OR: [{ username: 'KhaderMeeran' }, { email: 'khadermeeran' }],
    },
  });

  if (!existingKhader) {
    await prisma.user.create({
      data: {
        email: 'khadermeeran',
        username: 'KhaderMeeran',
        password: adminPasswordHash,
        name: 'KhaderMeeran',
        role: 'ADMIN',
      },
    });
    console.log('Created primary admin user: KhaderMeeran');
  } else {
    console.log('Primary admin user KhaderMeeran already exists.');
  }

  const existingDemoAdmin = await prisma.user.findFirst({
    where: {
      OR: [{ username: 'admin' }, { email: 'admin@demo.com' }],
    },
  });

  if (!existingDemoAdmin) {
    await prisma.user.create({
      data: {
        email: 'admin@demo.com',
        username: 'admin',
        password: adminPasswordHash,
        name: 'KhaderMeeran (Admin)',
        role: 'ADMIN',
      },
    });
    console.log('Created fallback admin user: admin@demo.com');
  }

  // 2. Ensure Tournament Auction Settings exist
  const existingAuction = await prisma.auction.findFirst({
    orderBy: { createdAt: 'desc' },
  });

  if (!existingAuction) {
    const auction = await prisma.auction.create({
      data: {
        name: 'Premier Cricket Tournament Mega Auction 2026',
        status: 'IDLE',
        currentRound: 1,
        defaultTimerSec: 10,
        autoSell: true,
        timerEnabled: true,
        defaultPurse: 15000,
        defaultSquadLimit: 12,
        iconPlayerPrice: 2500,
        defaultBasePrice: 100,
      },
    });
    console.log(`Initialized auction "${auction.name}".`);
  } else {
    console.log(`Auction "${existingAuction.name}" already present.`);
  }

  // 3. Auto-restore players and teams from backup if DB is empty
  const restored = await restoreDatabaseIfEmpty();
  if (restored) {
    console.log('Auto-restored players and teams from backup successfully.');
  } else {
    const pCount = await prisma.player.count();
    const tCount = await prisma.team.count();
    console.log(`Database state verified: ${pCount} players, ${tCount} teams.`);
  }

  console.log('--- Database initialization completed safely with 100% data preservation! ---');
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
