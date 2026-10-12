import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function restore() {
  try {
    const backupDir = path.join(__dirname, '../backups');
    const latestFile = path.join(backupDir, 'latest-backup.json');

    if (!fs.existsSync(latestFile)) {
      console.error(`[RESTORE ERROR] Backup file not found at ${latestFile}`);
      return;
    }

    const backupData = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
    console.log(`[RESTORE] Restoring from backup created at ${backupData.backupDate}...`);

    // Restore Teams
    for (const t of backupData.teams) {
      const { squad, ...teamFields } = t;
      await prisma.team.upsert({
        where: { id: t.id },
        update: teamFields,
        create: teamFields,
      });
    }
    console.log(`[RESTORE] Restored ${backupData.teams.length} teams.`);

    // Restore Players
    for (const p of backupData.players) {
      const { teamPlayer, ...playerFields } = p;
      await prisma.player.upsert({
        where: { id: p.id },
        update: playerFields,
        create: playerFields,
      });
    }
    console.log(`[RESTORE] Restored ${backupData.players.length} players.`);

    // Restore TeamPlayers (squad associations)
    for (const tp of backupData.teamPlayers) {
      await prisma.teamPlayer.upsert({
        where: { id: tp.id },
        update: tp,
        create: tp,
      });
    }
    console.log(`[RESTORE] Restored ${backupData.teamPlayers.length} team player associations.`);

    // Restore Users (if any)
    if (backupData.users && backupData.users.length > 0) {
      for (const u of backupData.users) {
        await prisma.user.upsert({
          where: { id: u.id },
          update: u,
          create: u,
        });
      }
      console.log(`[RESTORE] Restored ${backupData.users.length} users.`);
    }

    console.log('[RESTORE COMPLETED SUCCESSFULLY]');
  } catch (error) {
    console.error('[RESTORE FAILED]', error);
  } finally {
    await prisma.$disconnect();
  }
}

restore();
