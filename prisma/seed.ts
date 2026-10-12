import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Cleaning database (Removing all teams and players) ---');
  await prisma.bid.deleteMany();
  await prisma.teamPlayer.deleteMany();
  await prisma.auctionEvent.deleteMany();
  await prisma.auctionPlayer.deleteMany();
  await prisma.auction.deleteMany();
  await prisma.user.deleteMany();
  await prisma.player.deleteMany();
  await prisma.team.deleteMany();

  console.log('--- Initializing Primary Admin User: KhaderMeeran ---');
  const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || 'Admin@123';
  const adminPasswordHash = await bcrypt.hash(initialPassword, 10);

  await prisma.user.create({
    data: {
      email: 'khadermeeran',
      username: 'KhaderMeeran',
      password: adminPasswordHash,
      name: 'KhaderMeeran',
      role: 'ADMIN',
    },
  });

  // Also support admin@demo.com with same password for backwards compatibility
  await prisma.user.create({
    data: {
      email: 'admin@demo.com',
      username: 'admin',
      password: adminPasswordHash,
      name: 'KhaderMeeran (Admin)',
      role: 'ADMIN',
    },
  });
  console.log('Admin user initialized securely in Database.');

  console.log('--- Initializing Tournament Auction Settings (Purse: ₹15,000, Squad Limit: 12) ---');
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

  console.log(`Initialized clean auction "${auction.name}" (0 Teams, 0 Players).`);
  console.log('Admin can now add teams with custom username/password, and players can register publicly!');
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
