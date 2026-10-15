import { prisma } from '../prisma';
import fs from 'fs';
import path from 'path';

let snapshotDebounceTimer: NodeJS.Timeout | null = null;

/**
 * Triggers a debounced database snapshot in background.
 * Collapses rapid mutations (create, update, delete) into a single snapshot 5 seconds after activity stops.
 */
export function triggerDebouncedSnapshot(): void {
  if (snapshotDebounceTimer) {
    clearTimeout(snapshotDebounceTimer);
  }
  snapshotDebounceTimer = setTimeout(() => {
    saveDatabaseSnapshot().catch(() => {});
  }, 5000);
}

/**
 * Creates a durable backup snapshot of players, teams, squads, and users.
 * Automatically saves to latest-backup.json and a timestamped file.
 */
export async function saveDatabaseSnapshot(): Promise<void> {
  try {
    const backupDir = path.join(__dirname, '../../backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // Query all entities concurrently in parallel
    const [players, teams, teamPlayers, users, auctions, auctionPlayers, bids] = await Promise.all([
      prisma.player.findMany({ include: { teamPlayer: true, belongingTeam: true } }),
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

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const timestampFile = path.join(backupDir, `backup-${timestamp}.json`);
    const latestFile = path.join(backupDir, 'latest-backup.json');

    fs.writeFileSync(latestFile, JSON.stringify(backupData, null, 2), 'utf8');
    fs.writeFileSync(timestampFile, JSON.stringify(backupData, null, 2), 'utf8');

    // Keep only the latest 15 timestamped files to save disk space
    try {
      const files = fs.readdirSync(backupDir)
        .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
        .map((f) => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);

      if (files.length > 15) {
        for (const file of files.slice(15)) {
          fs.unlinkSync(path.join(backupDir, file.name));
        }
      }
    } catch (_) {
      // Non-fatal cleanup
    }

    console.log(`[PERSISTENCE] Snapshot created: ${players.length} players, ${teams.length} teams.`);
  } catch (error) {
    console.error('[PERSISTENCE ERROR] Failed to save database snapshot:', error);
  }
}

/**
 * Restores database from latest-backup.json if database is currently empty (0 players & 0 teams).
 * Guarantees data durability on ephemeral containers or unexpected resets.
 */
export async function restoreDatabaseIfEmpty(): Promise<boolean> {
  try {
    const [playerCount, teamCount] = await Promise.all([
      prisma.player.count(),
      prisma.team.count(),
    ]);

    if (playerCount > 0 || teamCount > 0) {
      console.log(`[PERSISTENCE CHECK] Database has existing data (${playerCount} players, ${teamCount} teams). Auto-restore not needed.`);
      return false;
    }

    const backupDir = path.join(__dirname, '../../backups');
    const latestFile = path.join(backupDir, 'latest-backup.json');

    if (!fs.existsSync(latestFile)) {
      console.log('[PERSISTENCE CHECK] No backup snapshot found at latest-backup.json.');
      return false;
    }

    console.log('[PERSISTENCE AUTO-RESTORE] Database is empty! Restoring from latest-backup.json...');
    const raw = fs.readFileSync(latestFile, 'utf8');
    const backupData = JSON.parse(raw);

    // 1. Restore Teams
    if (Array.isArray(backupData.teams)) {
      for (const t of backupData.teams) {
        const { squad, nominatedPlayers, bids, wonAuctions, user, ...teamFields } = t;
        await prisma.team.upsert({
          where: { id: t.id },
          update: teamFields,
          create: teamFields,
        });
      }
      console.log(`[PERSISTENCE AUTO-RESTORE] Restored ${backupData.teams.length} teams.`);
    }

    // 2. Restore Players
    if (Array.isArray(backupData.players)) {
      for (const p of backupData.players) {
        const { teamPlayer, belongingTeam, bids, auctionPlayers, ...playerFields } = p;
        await prisma.player.upsert({
          where: { id: p.id },
          update: playerFields,
          create: playerFields,
        });
      }
      console.log(`[PERSISTENCE AUTO-RESTORE] Restored ${backupData.players.length} players.`);
    }

    // 3. Restore TeamPlayers
    if (Array.isArray(backupData.teamPlayers)) {
      for (const tp of backupData.teamPlayers) {
        const { player, team, ...tpFields } = tp;
        await prisma.teamPlayer.upsert({
          where: { id: tp.id },
          update: tpFields,
          create: tpFields,
        });
      }
      console.log(`[PERSISTENCE AUTO-RESTORE] Restored ${backupData.teamPlayers.length} team player associations.`);
    }

    // 4. Restore Users
    if (Array.isArray(backupData.users)) {
      for (const u of backupData.users) {
        const { team, ...userFields } = u;
        const existing = await prisma.user.findFirst({
          where: {
            OR: [
              { id: u.id },
              { email: u.email },
              ...(u.username ? [{ username: u.username }] : []),
            ],
          },
        });
        if (existing) {
          await prisma.user.update({
            where: { id: existing.id },
            data: userFields,
          });
        } else {
          await prisma.user.create({
            data: userFields,
          });
        }
      }
      console.log(`[PERSISTENCE AUTO-RESTORE] Restored ${backupData.users.length} users.`);
    }

    // 5. Restore Auction if exists
    if (Array.isArray(backupData.auctions) && backupData.auctions.length > 0) {
      for (const a of backupData.auctions) {
        const { auctionPlayers, bids, events, ...auctionFields } = a;
        await prisma.auction.upsert({
          where: { id: a.id },
          update: auctionFields,
          create: auctionFields,
        });
      }
    }

    console.log('[PERSISTENCE AUTO-RESTORE] Complete! Database restored successfully.');
    return true;
  } catch (error) {
    console.error('[PERSISTENCE AUTO-RESTORE ERROR] Failed to restore database:', error);
    return false;
  }
}
