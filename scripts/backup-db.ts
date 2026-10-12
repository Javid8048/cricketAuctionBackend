import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function backup() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const [players, teams, teamPlayers, users, auctions, auctionPlayers, bids] = await Promise.all([
      prisma.player.findMany({ include: { teamPlayer: true } }),
      prisma.team.findMany({ include: { squad: true } }),
      prisma.teamPlayer.findMany(),
      prisma.user.findMany(),
      prisma.auction.findMany(),
      prisma.auctionPlayer.findMany(),
      prisma.bid.findMany(),
    ]);

    const backupData = {
      backupDate: new Date().toISOString(),
      counts: {
        players: players.length,
        teams: teams.length,
        teamPlayers: teamPlayers.length,
        users: users.length,
        auctions: auctions.length,
        auctionPlayers: auctionPlayers.length,
        bids: bids.length,
      },
      players,
      teams,
      teamPlayers,
      users,
      auctions,
      auctionPlayers,
      bids,
    };

    // Save timestamped backup and latest backup
    const timestampFile = path.join(backupDir, `backup-${timestamp}.json`);
    const latestFile = path.join(backupDir, 'latest-backup.json');

    fs.writeFileSync(timestampFile, JSON.stringify(backupData, null, 2), 'utf8');
    fs.writeFileSync(latestFile, JSON.stringify(backupData, null, 2), 'utf8');

    console.log(`[BACKUP SUCCESSFUL] Saved ${players.length} players and ${teams.length} teams to:`);
    console.log(`- ${timestampFile}`);
    console.log(`- ${latestFile}`);
  } catch (error) {
    console.error('[BACKUP FAILED]', error);
  } finally {
    await prisma.$disconnect();
  }
}

backup();
