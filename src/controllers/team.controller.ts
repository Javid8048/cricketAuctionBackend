import { Request, Response } from 'express';
import { prisma } from '../prisma';
import bcrypt from 'bcryptjs';
import { formatRupees } from '../utils/currency';
import { auctionEngine } from './auction.controller';
import { triggerDebouncedSnapshot } from '../utils/persistence';

// In-memory cache for ultra-fast teams list retrieval
let cachedTeamsData: any[] | null = null;
let teamsCacheTimestamp: number = 0;
const TEAMS_CACHE_TTL_MS = 15000; // 15 seconds

export function invalidateTeamsCache() {
  cachedTeamsData = null;
  teamsCacheTimestamp = 0;
}

// Automatically clear cache whenever auction engine invalidates
auctionEngine.onInvalidate(invalidateTeamsCache);

export async function getTeams(req: Request, res: Response) {
  try {
    if (cachedTeamsData && (Date.now() - teamsCacheTimestamp < TEAMS_CACHE_TTL_MS)) {
      return res.json(cachedTeamsData);
    }

    const teams = await prisma.team.findMany({
      include: {
        squad: {
          include: {
            player: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const formatted = teams.map((t) => {
      const overseasCount = t.squad.filter((sp) => sp.player.isOverseas).length;
      const batters = t.squad.filter((sp) => sp.player.role === 'Batter').length;
      const bowlers = t.squad.filter((sp) => sp.player.role === 'Bowler').length;
      const allRounders = t.squad.filter((sp) => sp.player.role === 'All-Rounder').length;
      const wicketkeepers = t.squad.filter((sp) => sp.player.role === 'Wicketkeeper').length;
      const iconPlayersCount = t.squad.filter((sp) => sp.isIcon || sp.player.isIcon).length;
      const spentOnSquad = t.squad.reduce((sum, sp) => sum + (sp.price || 0), 0);
      const safeRemaining = t.remainingPurse > t.totalPurse ? Math.max(0, t.totalPurse - spentOnSquad) : t.remainingPurse;
      const totalSpent = Math.max(0, t.totalPurse - safeRemaining);

      return {
        ...t,
        remainingPurse: safeRemaining,
        squadSize: t.squad.length,
        iconPlayersCount,
        overseasCount,
        batters,
        bowlers,
        allRounders,
        wicketkeepers,
        totalSpent,
      };
    });

    cachedTeamsData = formatted;
    teamsCacheTimestamp = Date.now();

    res.json(formatted);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch teams.' });
  }
}

export async function getTeamById(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const team = await prisma.team.findUnique({
      where: { id },
      include: {
        squad: {
          include: {
            player: true,
          },
        },
        bids: {
          orderBy: { createdAt: 'desc' },
          take: 30,
          include: {
            player: true,
          },
        },
      },
    });

    if (!team) {
      return res.status(404).json({ error: 'Team not found.' });
    }

    const overseasCount = team.squad.filter((sp) => sp.player.isOverseas).length;
    const batters = team.squad.filter((sp) => sp.player.role === 'Batter').length;
    const bowlers = team.squad.filter((sp) => sp.player.role === 'Bowler').length;
    const allRounders = team.squad.filter((sp) => sp.player.role === 'All-Rounder').length;
    const wicketkeepers = team.squad.filter((sp) => sp.player.role === 'Wicketkeeper').length;
    const iconPlayersCount = team.squad.filter((sp) => sp.isIcon || sp.player.isIcon).length;
    const spentOnSquad = team.squad.reduce((sum, sp) => sum + (sp.price || 0), 0);
    const safeRemaining = team.remainingPurse > team.totalPurse ? Math.max(0, team.totalPurse - spentOnSquad) : team.remainingPurse;
    const totalSpent = Math.max(0, team.totalPurse - safeRemaining);
    const avgPlayerPrice = team.squad.length > 0 ? totalSpent / team.squad.length : 0;
    const highestPurchase = team.squad.reduce((max, curr) => (curr.price > max ? curr.price : max), 0);

    res.json({
      ...team,
      remainingPurse: safeRemaining,
      squadSize: team.squad.length,
      iconPlayersCount,
      overseasCount,
      batters,
      bowlers,
      allRounders,
      wicketkeepers,
      totalSpent,
      avgPlayerPrice,
      highestPurchase,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch team.' });
  }
}

export async function createTeam(req: Request, res: Response) {
  try {
    const data = req.body;
    const initialPurse = Number(data.totalPurse || 15000);
    const squadLimit = Number(data.maxSquadSize || 12);
    const loginUsername = (data.loginUsername || data.username || '').trim();
    const loginPassword = (data.loginPassword || data.password || '').trim();

    const team = await prisma.team.create({
      data: {
        name: data.name,
        shortName: data.shortName || data.name.substring(0, 3).toUpperCase(),
        ownerName: data.ownerName || null,
        phone: data.phone || null,
        address: data.address || null,
        loginUsername: loginUsername || null,
        loginPassword: loginPassword || null,
        primaryColor: data.primaryColor || '#3B82F6',
        secondaryColor: data.secondaryColor || '#1E40AF',
        logoText: data.shortName || data.name.substring(0, 2).toUpperCase(),
        totalPurse: initialPurse,
        remainingPurse: initialPurse,
        maxSquadSize: squadLimit,
        maxOverseas: Number(data.maxOverseas || 4),
      },
    });

    // Create User login if credentials were provided
    if (loginUsername && loginPassword) {
      const hashedPassword = await bcrypt.hash(loginPassword, 10);
      const email = loginUsername.includes('@') ? loginUsername.toLowerCase() : `${loginUsername.toLowerCase()}@team.local`;

      // Check if user already exists
      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [{ username: loginUsername }, { email: email }],
        },
      });

      if (existingUser) {
        await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            username: loginUsername,
            email: email,
            password: hashedPassword,
            name: data.name,
            role: 'TEAM',
            teamId: team.id,
          },
        });
      } else {
        await prisma.user.create({
          data: {
            username: loginUsername,
            email: email,
            password: hashedPassword,
            name: data.name,
            role: 'TEAM',
            teamId: team.id,
          },
        });
      }
    }

    auctionEngine.invalidateCache();

    res.status(201).json(team);

    setImmediate(async () => {
      try {
        const state = await auctionEngine.getAuctionState();
        if (state) {
          auctionEngine.broadcast('auction:settings_updated', state);
        }
      } catch (_) {}
      triggerDebouncedSnapshot();
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to create team.' });
  }
}

export async function updateTeam(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const data = req.body;

    const existing = await prisma.team.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Team not found.' });
    }

    const newTotalPurse = data.totalPurse !== undefined ? Number(data.totalPurse) : existing.totalPurse;
    const purseDiff = newTotalPurse - existing.totalPurse;
    const newRemainingPurse = data.remainingPurse !== undefined ? Number(data.remainingPurse) : existing.remainingPurse + purseDiff;

    const loginUsername = data.loginUsername !== undefined ? data.loginUsername : (data.username !== undefined ? data.username : existing.loginUsername);
    const loginPassword = data.loginPassword !== undefined ? data.loginPassword : (data.password !== undefined ? data.password : existing.loginPassword);

    const team = await prisma.team.update({
      where: { id },
      data: {
        name: data.name,
        shortName: data.shortName,
        ownerName: data.ownerName !== undefined ? data.ownerName : existing.ownerName,
        phone: data.phone !== undefined ? data.phone : existing.phone,
        address: data.address !== undefined ? data.address : existing.address,
        loginUsername: loginUsername || null,
        loginPassword: loginPassword || null,
        primaryColor: data.primaryColor,
        secondaryColor: data.secondaryColor,
        logoText: data.logoText,
        totalPurse: newTotalPurse,
        remainingPurse: newRemainingPurse,
        maxSquadSize: data.maxSquadSize !== undefined ? Number(data.maxSquadSize) : existing.maxSquadSize,
        maxOverseas: data.maxOverseas !== undefined ? Number(data.maxOverseas) : existing.maxOverseas,
      },
    });

    if (loginUsername && loginPassword) {
      const hashedPassword = await bcrypt.hash(loginPassword, 10);
      const email = loginUsername.includes('@') ? loginUsername.toLowerCase() : `${loginUsername.toLowerCase()}@team.local`;

      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [{ teamId: id }, { username: loginUsername }, { email: email }],
        },
      });

      if (existingUser) {
        await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            username: loginUsername,
            email: email,
            password: hashedPassword,
            name: data.name || existingUser.name,
            role: 'TEAM',
            teamId: id,
          },
        });
      } else {
        await prisma.user.create({
          data: {
            username: loginUsername,
            email: email,
            password: hashedPassword,
            name: team.name,
            role: 'TEAM',
            teamId: id,
          },
        });
      }
    }

    auctionEngine.invalidateCache();

    res.json(team);

    setImmediate(async () => {
      try {
        const state = await auctionEngine.getAuctionState();
        if (state) {
          auctionEngine.broadcast('auction:settings_updated', state);
        }
      } catch (_) {}
      triggerDebouncedSnapshot();
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update team.' });
  }
}

export async function deleteTeam(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const team = await prisma.team.findUnique({
      where: { id },
      select: { name: true },
    });

    if (!team) {
      return res.status(404).json({ error: 'Team not found.' });
    }

    // 1. Revert all squad players to UPCOMING in a single batch query
    const squadPlayers = await prisma.teamPlayer.findMany({
      where: { teamId: id },
      select: { playerId: true },
    });

    const playerIds = squadPlayers.map((sp) => sp.playerId);
    if (playerIds.length > 0) {
      await prisma.player.updateMany({
        where: { id: { in: playerIds } },
        data: {
          status: 'UPCOMING',
          currentPrice: null,
          isIcon: false,
          iconPrice: null,
        },
      });
    }

    // 2. Parallel cleanup of related records and team deletion
    await Promise.all([
      prisma.player.updateMany({
        where: { belongingTeamId: id },
        data: { belongingTeamId: null },
      }),
      prisma.teamPlayer.deleteMany({
        where: { teamId: id },
      }),
      prisma.user.deleteMany({
        where: { teamId: id },
      }),
      prisma.bid.deleteMany({
        where: { teamId: id },
      }),
      prisma.auctionPlayer.updateMany({
        where: { winningTeamId: id },
        data: {
          winningTeamId: null,
          status: 'PENDING',
          finalPrice: null,
        },
      }),
      prisma.auction.updateMany({
        where: { highestBidTeamId: id },
        data: {
          highestBidTeamId: null,
        },
      }),
    ]);

    await prisma.team.delete({
      where: { id },
    });

    // Invalidate auction engine cache for fast updates
    auctionEngine.invalidateCache();

    // Return instant HTTP response
    res.json({ success: true, message: `Team ${team.name} deleted successfully.` });

    // Asynchronous broadcast & debounced snapshot in background
    setImmediate(async () => {
      try {
        await auctionEngine.broadcastState();
      } catch (_) {}
      triggerDebouncedSnapshot();
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to delete team.' });
  }
}

export async function deleteAllTeams(req: Request, res: Response) {
  try {
    const teams = await prisma.team.findMany({
      include: { squad: true },
    });

    if (teams.length === 0) {
      return res.json({ success: true, message: 'No teams to delete.' });
    }

    await prisma.$transaction(async (tx) => {
      // 1. Release all rostered players back to UPCOMING
      await tx.player.updateMany({
        where: { status: 'SOLD' },
        data: {
          status: 'UPCOMING',
          currentPrice: null,
        },
      });

      // 2. Delete all squad links
      await tx.teamPlayer.deleteMany();

      // 3. Delete all bids
      await tx.bid.deleteMany();

      // 4. Clear winningTeamId on AuctionPlayer
      await tx.auctionPlayer.updateMany({
        data: { winningTeamId: null },
      });

      // 5. Reset highest bidder on active auctions
      await tx.auction.updateMany({
        data: { highestBidTeamId: null },
      });

      // 6. Delete all franchise user accounts
      await tx.user.deleteMany({
        where: { role: 'TEAM' },
      });

      // 7. Delete all teams
      await tx.team.deleteMany();
    });

    auctionEngine.invalidateCache();

    res.json({
      success: true,
      message: `Successfully deleted all ${teams.length} teams. Players returned to draft pool.`,
    });

    setImmediate(async () => {
      try {
        await auctionEngine.broadcastState();
      } catch (_) {}
      triggerDebouncedSnapshot();
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to delete all teams.' });
  }
}

/**
 * Assign an Icon Player to a team before bidding starts
 * Limit: 2 Icon Players per team, deduction default: ₹2,500 (customizable by Admin)
 */
export async function assignIconPlayer(req: Request, res: Response) {
  try {
    const { id: teamId } = req.params;
    const { playerId, iconPrice = 2500 } = req.body;

    const deductionAmount = Number(iconPrice) > 0 ? Number(iconPrice) : 2500;

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: { squad: { include: { player: true } } },
    });

    if (!team) {
      return res.status(404).json({ error: 'Team not found.' });
    }

    const player = await prisma.player.findUnique({
      where: { id: playerId },
    });

    if (!player) {
      return res.status(404).json({ error: 'Player not found.' });
    }

    if (player.status !== 'UPCOMING') {
      return res.status(400).json({ error: `Player is already ${player.status.toLowerCase()} and cannot be selected as an Icon player.` });
    }

    // 1. Max 2 Icon players rule
    const currentIconCount = team.squad.filter((sp) => sp.isIcon || sp.player.isIcon).length;
    if (currentIconCount >= 2) {
      return res.status(400).json({ error: `Team ${team.name} already has the maximum of 2 Icon players.` });
    }

    // 2. Max squad limit rule
    if (team.squad.length >= team.maxSquadSize) {
      return res.status(400).json({ error: `Team squad limit of ${team.maxSquadSize} members is reached.` });
    }

    // 3. Sufficient purse rule
    if (team.remainingPurse < deductionAmount) {
      return res.status(400).json({
        error: `Insufficient purse! Team has ${formatRupees(team.remainingPurse)}, required ${formatRupees(deductionAmount)} for Icon Player.`,
      });
    }

    const auction = await prisma.auction.findFirst({ orderBy: { createdAt: 'desc' } });

    // Execute atomic transaction
    await prisma.$transaction(async (tx) => {
      // Deduct purse
      await tx.team.update({
        where: { id: teamId },
        data: { remainingPurse: { decrement: deductionAmount } },
      });

      // Add to squad
      await tx.teamPlayer.create({
        data: {
          teamId,
          playerId,
          price: deductionAmount,
          isIcon: true,
        },
      });

      // Mark player as sold icon
      await tx.player.update({
        where: { id: playerId },
        data: {
          status: 'SOLD',
          isIcon: true,
          iconPrice: deductionAmount,
          currentPrice: deductionAmount,
        },
      });

      // Update auction player entry
      if (auction) {
        await tx.auctionPlayer.updateMany({
          where: { auctionId: auction.id, playerId },
          data: {
            status: 'SOLD',
            winningTeamId: teamId,
            finalPrice: deductionAmount,
            soldAt: new Date(),
          },
        });

        await tx.auctionEvent.create({
          data: {
            auctionId: auction.id,
            type: 'SOLD',
            message: `ICON PLAYER! ${player.name} (S.No #${player.sNo}) assigned to ${team.name} for ${formatRupees(deductionAmount)}.`,
            metadata: JSON.stringify({
              playerId: player.id,
              playerName: player.name,
              teamId: team.id,
              teamName: team.name,
              amount: deductionAmount,
              isIcon: true,
            }),
          },
        });
      }
    }, { maxWait: 15000, timeout: 30000 });

    auctionEngine.invalidateCache();
    triggerDebouncedSnapshot();

    res.json({
      success: true,
      message: `${player.name} assigned as Icon player for ${team.name} (-${formatRupees(deductionAmount)} deducted from purse).`,
    });
  } catch (error: any) {
    console.error('Assign Icon player error:', error);
    res.status(500).json({ error: error.message || 'Failed to assign Icon player.' });
  }
}

/**
 * Remove an Icon Player from a team (Refunds purse back)
 */
export async function removeIconPlayer(req: Request, res: Response) {
  try {
    const { id: teamId } = req.params;
    const { playerId } = req.body;

    const teamPlayer = await prisma.teamPlayer.findFirst({
      where: { teamId, playerId },
      include: { player: true, team: true },
    });

    if (!teamPlayer) {
      return res.status(404).json({ error: 'Player is not in this team squad.' });
    }

    const refundPrice = teamPlayer.price;
    const auction = await prisma.auction.findFirst({ orderBy: { createdAt: 'desc' } });

    await prisma.$transaction(async (tx) => {
      // Refund purse
      await tx.team.update({
        where: { id: teamId },
        data: { remainingPurse: { increment: refundPrice } },
      });

      // Remove from squad
      await tx.teamPlayer.delete({
        where: { id: teamPlayer.id },
      });

      // Reset player to upcoming
      await tx.player.update({
        where: { id: playerId },
        data: {
          status: 'UPCOMING',
          isIcon: false,
          iconPrice: null,
          currentPrice: null,
        },
      });

      if (auction) {
        await tx.auctionPlayer.updateMany({
          where: { auctionId: auction.id, playerId },
          data: {
            status: 'PENDING',
            winningTeamId: null,
            finalPrice: null,
            soldAt: null,
          },
        });
      }
    }, { maxWait: 15000, timeout: 30000 });

    auctionEngine.invalidateCache();
    triggerDebouncedSnapshot();

    res.json({
      success: true,
      message: `${teamPlayer.player.name} removed from ${teamPlayer.team.name} (+${formatRupees(refundPrice)} refunded to purse).`,
    });
  } catch (error: any) {
    console.error('Remove Icon player error:', error);
    res.status(500).json({ error: error.message || 'Failed to remove Icon player.' });
  }
}

/**
 * Get credentials of all teams (Admin only)
 */
export async function getFranchiseCredentials(req: Request, res: Response) {
  try {
    const caller = (req as any).user;
    if (!caller || caller.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access forbidden. Administrator role required.' });
    }

    const teams = await prisma.team.findMany({
      select: {
        id: true,
        name: true,
        shortName: true,
        ownerName: true,
        phone: true,
        primaryColor: true,
        loginUsername: true,
        loginPassword: true,
        totalPurse: true,
        remainingPurse: true,
      },
      orderBy: { name: 'asc' },
    });
    res.json(teams);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch team credentials.' });
  }
}

/**
 * Update credentials of a team (Admin only)
 */
export async function updateFranchiseCredentials(req: Request, res: Response) {
  try {
    const caller = (req as any).user;
    if (!caller || caller.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access forbidden. Administrator role required.' });
    }

    const { id } = req.params;
    const { loginUsername, loginPassword } = req.body;

    if (!loginUsername || !loginPassword) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const team = await prisma.team.findUnique({ where: { id } });
    if (!team) {
      return res.status(404).json({ error: 'Team not found.' });
    }

    const hashedPassword = await bcrypt.hash(loginPassword.trim(), 10);
    const email = loginUsername.includes('@')
      ? loginUsername.toLowerCase().trim()
      : `${loginUsername.toLowerCase().trim()}@team.local`;

    await prisma.team.update({
      where: { id },
      data: {
        loginUsername: loginUsername.trim(),
        loginPassword: loginPassword.trim(),
      },
    });

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ teamId: id }, { username: loginUsername.trim() }, { email }],
      },
    });

    if (existingUser) {
      await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          username: loginUsername.trim(),
          email,
          password: hashedPassword,
          role: 'TEAM',
          teamId: id,
        },
      });
    } else {
      await prisma.user.create({
        data: {
          username: loginUsername.trim(),
          email,
          password: hashedPassword,
          name: team.name,
          role: 'TEAM',
          teamId: id,
        },
      });
    }

    res.json({
      success: true,
      message: `Credentials updated for ${team.name}.`,
      loginUsername: loginUsername.trim(),
      loginPassword: loginPassword.trim(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update credentials.' });
  }
}

export const getTeamCredentials = getFranchiseCredentials;
export const updateTeamCredentials = updateFranchiseCredentials;
