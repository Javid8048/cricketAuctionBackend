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


let inMemoryPlayers: any[] | null = null;
let inMemoryTeams: any[] | null = null;

function initLiveState(): void {
  if (!inMemoryPlayers || !inMemoryTeams) {
    try {
      const backupDir = path.join(__dirname, '../../backups');
      const latestFile = path.join(backupDir, 'latest-backup.json');
      if (fs.existsSync(latestFile)) {
        const raw = fs.readFileSync(latestFile, 'utf8');
        const data = JSON.parse(raw);
        inMemoryPlayers = Array.isArray(data.players?.value)
          ? data.players.value
          : Array.isArray(data.players)
          ? data.players
          : [];
        inMemoryTeams = Array.isArray(data.teams?.value)
          ? data.teams.value
          : Array.isArray(data.teams)
          ? data.teams
          : [];
      } else {
        inMemoryPlayers = [];
        inMemoryTeams = [];
      }
    } catch (err: any) {
      console.error('[PERSISTENCE ERROR] Loading live state from backup:', err.message);
      inMemoryPlayers = inMemoryPlayers || [];
      inMemoryTeams = inMemoryTeams || [];
    }
  }
}

export function getRawLiveTeams(): any[] {
  initLiveState();
  return inMemoryTeams || [];
}

export function getLivePlayers(): any[] {
  initLiveState();
  return inMemoryPlayers || [];
}

/**
 * Returns teams with dynamically computed squads, squad sizes, and role counts.
 * Fixes the issue where team count was not updating.
 */
export function getLiveTeams(): any[] {
  const teams = getRawLiveTeams();
  const players = getLivePlayers();

  return teams.map((t) => {
    // Find all players assigned or sold to this team
    const teamSquad = players
      .filter((p) => {
        const tp = p.teamPlayer;
        return (
          p.status === 'SOLD' &&
          ((tp && (tp.teamId === t.id || tp.team?.id === t.id)) ||
            p.soldToTeamId === t.id)
        );
      })
      .map((p) => {
        const tp = p.teamPlayer || {};
        return {
          id: tp.id || `tp-${p.id}`,
          teamId: t.id,
          playerId: p.id,
          price: tp.price || p.currentPrice || p.basePrice || 100,
          isIcon: Boolean(tp.isIcon || p.isIcon || p.category === 'Icon Player'),
          acquiredAt: tp.acquiredAt || p.updatedAt || new Date().toISOString(),
          player: p,
        };
      });

    const overseasCount = teamSquad.filter((sp) => sp.player?.isOverseas).length;
    const batters = teamSquad.filter((sp) => sp.player?.role === 'Batter').length;
    const bowlers = teamSquad.filter((sp) => sp.player?.role === 'Bowler').length;
    const allRounders = teamSquad.filter((sp) => sp.player?.role === 'All-Rounder').length;
    const wicketkeepers = teamSquad.filter((sp) => sp.player?.role === 'Wicketkeeper').length;
    const iconPlayersCount = teamSquad.filter((sp) => sp.isIcon || sp.player?.isIcon).length;
    const spentOnSquad = teamSquad.reduce((sum, sp) => sum + (sp.price || 0), 0);
    const safeRemaining = Math.max(0, t.totalPurse - spentOnSquad);
    const totalSpent = spentOnSquad;

    return {
      ...t,
      squad: teamSquad,
      remainingPurse: safeRemaining,
      squadSize: teamSquad.length,
      iconPlayersCount,
      overseasCount,
      batters,
      bowlers,
      allRounders,
      wicketkeepers,
      totalSpent,
    };
  });
}

/**
 * Synchronizes the current in-memory players and teams to latest-backup.json
 */
export function persistLiveState(): void {
  try {
    const backupDir = path.join(__dirname, '../../backups');
    const latestFile = path.join(backupDir, 'latest-backup.json');
    const players = getLivePlayers();
    const teams = getRawLiveTeams();

    const auction = getLiveAuction();
    const data = {
      backupDate: new Date().toISOString(),
      counts: {
        players: players.length,
        teams: teams.length,
        auctions: 1,
      },
      players,
      teams,
      auctions: [auction],
    };

    fs.writeFileSync(latestFile, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[PERSISTENCE] Successfully synced ${players.length} players and ${teams.length} teams to backup.`);
  } catch (err: any) {
    console.error('[PERSISTENCE ERROR] Failed to persist live state:', err.message);
  }
}

/**
 * Updates a player in the live state and persists to latest-backup.json
 */
export function updateLivePlayer(id: string, updates: any): any {
  const players = getLivePlayers();
  const searchStr = String(id).trim();
  const index = players.findIndex((p) => p.id === searchStr || String(p.sNo) === searchStr);

  if (index === -1) {
    throw new Error(`Player ${id} not found.`);
  }

  const existing = players[index];
  const updatedPlayer = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  // Option 1: Belonging team affiliation
  if (updates.belongingTeamId !== undefined || updates.belongingTeamName !== undefined) {
    const rawTeam = updates.belongingTeamId !== undefined ? updates.belongingTeamId : updates.belongingTeamName;
    const teamVal = rawTeam && rawTeam !== 'NONE' && String(rawTeam).trim() !== '' ? String(rawTeam).trim() : null;
    updatedPlayer.belongingTeamId = teamVal;
    updatedPlayer.belongingTeamName = teamVal;
  }

  // Option 2: Sold to team assignment
  if (updates.soldToTeamId !== undefined) {
    const targetTeamId = updates.soldToTeamId && updates.soldToTeamId !== 'NONE' && String(updates.soldToTeamId).trim() !== ''
      ? String(updates.soldToTeamId).trim()
      : null;
    const priceToUse = Number(
      updates.soldPrice || updates.currentPrice || existing.currentPrice || updates.basePrice || existing.basePrice || 100
    );

    if (targetTeamId) {
      updatedPlayer.status = 'SOLD';
      updatedPlayer.currentPrice = priceToUse;
      const targetTeam = getRawLiveTeams().find((t) => t.id === targetTeamId);
      updatedPlayer.teamPlayer = {
        id: existing.teamPlayer?.id || `tp-${existing.id}`,
        teamId: targetTeamId,
        playerId: existing.id,
        price: priceToUse,
        isIcon: Boolean(updates.isIcon || updates.category === 'Icon Player'),
        acquiredAt: existing.teamPlayer?.acquiredAt || new Date().toISOString(),
        team: targetTeam || existing.teamPlayer?.team,
      };
    } else {
      updatedPlayer.status = 'UPCOMING';
      updatedPlayer.currentPrice = null;
      delete updatedPlayer.teamPlayer;
    }
  }

  if (updates.country !== undefined) {
    updatedPlayer.isOverseas = updates.country !== 'India';
  }

  players[index] = updatedPlayer;
  persistLiveState();
  return updatedPlayer;
}

/**
 * Deletes a player from the live state and persists to latest-backup.json
 */
export function deleteLivePlayer(idOrSNo: string | number): boolean {
  const players = getLivePlayers();
  const searchStr = String(idOrSNo).trim();
  const index = players.findIndex((p) => p.id === searchStr || String(p.sNo) === searchStr);

  if (index === -1) {
    return false;
  }

  const removed = players.splice(index, 1)[0];
  console.log(`[PERSISTENCE] Successfully removed player #${removed.sNo} (${removed.name})`);
  persistLiveState();
  return true;
}

/**
 * Creates a player in the live state and persists to latest-backup.json
 */
export function createLivePlayer(createData: any): any {
  const players = getLivePlayers();
  const maxSNo = players.reduce((max, p) => (p.sNo && p.sNo > max ? p.sNo : max), 0);
  const sNo = createData.sNo ? Number(createData.sNo) : maxSNo + 1;

  const newPlayer = {
    id: createData.id || `player-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    ...createData,
    sNo,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  players.push(newPlayer);
  persistLiveState();
  return newPlayer;
}

/**
 * Updates a team in live state and persists to latest-backup.json
 */
export function updateLiveTeam(id: string, updates: any): any {
  const teams = getRawLiveTeams();
  const index = teams.findIndex((t) => t.id === id);
  if (index === -1) {
    throw new Error(`Team ${id} not found.`);
  }

  const existing = teams[index];
  const updatedTeam = {
    ...existing,
    ...updates,
    logoUrl: updates.logoUrl !== undefined ? (updates.logoUrl || null) : existing.logoUrl,
    updatedAt: new Date().toISOString(),
  };

  teams[index] = updatedTeam;
  persistLiveState();
  return updatedTeam;
}

/**
 * Creates a team in live state and persists to latest-backup.json
 */
export function createLiveTeam(createData: any): any {
  const teams = getRawLiveTeams();
  const newTeam = {
    id: createData.id || `team-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    ...createData,
    logoUrl: createData.logoUrl || null,
    totalPurse: Number(createData.totalPurse) || 15000,
    remainingPurse: Number(createData.remainingPurse || createData.totalPurse) || 15000,
    maxSquadSize: Number(createData.maxSquadSize) || 12,
    maxOverseas: Number(createData.maxOverseas) || 4,
    squad: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  teams.push(newTeam);
  persistLiveState();
  return newTeam;
}

/**
 * Safely reads the durable snapshot from latest-backup.json as a high-availability fallback.
 */
let inMemoryAuction: any = null;

export function getLiveAuction(): any {
  if (!inMemoryAuction) {
    const backupDir = path.join(__dirname, '../../backups');
    const latestFile = path.join(backupDir, 'latest-backup.json');
    if (fs.existsSync(latestFile)) {
      try {
        const raw = fs.readFileSync(latestFile, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.auctions) && data.auctions.length > 0) {
          inMemoryAuction = { ...data.auctions[0], bids: data.auctions[0].bids || [] };
        }
      } catch (_) {}
    }

    if (!inMemoryAuction) {
      inMemoryAuction = {
        id: 'd7fd259c-befe-408a-a1bc-1b2b1a6888ff',
        name: 'Premier Cricket Tournament Mega Auction 2026',
        status: 'ACTIVE',
        currentRound: 1,
        defaultTimerSec: 10,
        autoSell: true,
        timerEnabled: false,
        defaultPurse: 15000,
        defaultSquadLimit: 12,
        iconPlayerPrice: 2500,
        defaultBasePrice: 100,
        activePlayerId: null,
        activePlayerPrice: 100,
        highestBidTeamId: null,
        bids: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  return inMemoryAuction;
}

export function updateLiveAuction(updates: any): any {
  const current = getLiveAuction();
  inMemoryAuction = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  persistLiveState();
  return inMemoryAuction;
}

export function getFallbackBackupData(): { players: any[]; teams: any[] } {
  return {
    players: getLivePlayers(),
    teams: getLiveTeams(),
  };
}
