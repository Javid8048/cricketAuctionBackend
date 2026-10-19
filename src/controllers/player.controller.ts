import { Request, Response } from 'express';
import { prisma } from '../prisma';
import { auctionEngine } from './auction.controller';
import { triggerDebouncedSnapshot } from '../utils/persistence';

// In-memory cache for ultra-fast player list retrieval
let cachedPlayersData: any[] | null = null;
let playersCacheTimestamp: number = 0;
const PLAYERS_CACHE_TTL_MS = 15000; // 15 seconds

export function invalidatePlayersCache() {
  cachedPlayersData = null;
  playersCacheTimestamp = 0;
}

// Automatically clear cache whenever auction engine invalidates
auctionEngine.onInvalidate(invalidatePlayersCache);

export async function getPlayers(req: Request, res: Response) {
  try {
    const { role, country, category, status, search } = req.query;

    const isUnfiltered =
      (!role || role === 'ALL') &&
      (!country || country === 'ALL') &&
      (!category || category === 'ALL') &&
      (!status || status === 'ALL') &&
      !search;

    if (isUnfiltered && cachedPlayersData && (Date.now() - playersCacheTimestamp < PLAYERS_CACHE_TTL_MS)) {
      return res.json(cachedPlayersData);
    }

    const where: any = {};

    if (role && role !== 'ALL') {
      where.role = String(role);
    }
    if (country && country !== 'ALL') {
      where.country = String(country);
    }
    if (category && category !== 'ALL') {
      where.category = String(category);
    }
    if (status && status !== 'ALL') {
      where.status = String(status);
    }

    if (search) {
      const searchStr = String(search).trim();
      const sNoNum = parseInt(searchStr, 10);
      if (!isNaN(sNoNum) && String(sNoNum) === searchStr) {
        where.OR = [
          { sNo: sNoNum },
          { name: { contains: searchStr } },
        ];
      } else {
        where.name = { contains: searchStr };
      }
    }

    const players = await prisma.player.findMany({
      where,
      orderBy: [{ sNo: 'asc' }, { name: 'asc' }],
      include: {
        teamPlayer: {
          include: {
            team: true,
          },
        },
        belongingTeam: true,
      },
    });

    if (isUnfiltered) {
      cachedPlayersData = players;
      playersCacheTimestamp = Date.now();
    }

    res.json(players);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch players.' });
  }
}

export async function getPlayerById(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const player = await prisma.player.findUnique({
      where: { id },
      include: {
        teamPlayer: {
          include: {
            team: true,
          },
        },
        belongingTeam: true,
        bids: {
          orderBy: { createdAt: 'desc' },
          include: {
            team: true,
          },
        },
        auctionPlayers: {
          orderBy: { createdAt: 'desc' },
          include: {
            winningTeam: true,
          },
        },
      },
    });

    if (!player) {
      return res.status(404).json({ error: 'Player not found.' });
    }

    res.json(player);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch player.' });
  }
}

/**
 * Public registration endpoint for players via shared link (No Login Required)
 */
export async function registerPlayerPublic(req: Request, res: Response) {
  try {
    const data = req.body;

    if (!data.name || !data.name.trim()) {
      return res.status(400).json({ error: 'Player name is required.' });
    }

    // Auto-calculate next sequential S.No
    const lastPlayer = await prisma.player.findFirst({
      orderBy: { sNo: 'desc' },
      select: { sNo: true },
    });
    const sNo = (lastPlayer?.sNo || 0) + 1;

    const basePrice = Number(data.basePrice) > 0 ? Number(data.basePrice) : 100;
    const age = Number(data.age) || (data.dob ? new Date().getFullYear() - new Date(data.dob).getFullYear() : 22);

    const manualTeamName = (data.belongingTeamName && String(data.belongingTeamName).trim() !== '')
      ? String(data.belongingTeamName).trim()
      : null;

    let effectiveBelongingTeamId = (data.belongingTeamId && data.belongingTeamId !== 'NONE' && String(data.belongingTeamId).trim() !== '')
      ? String(data.belongingTeamId).trim()
      : (data.teamId && data.teamId !== 'NONE' && String(data.teamId).trim() !== '' ? String(data.teamId).trim() : null);

    if (manualTeamName && !effectiveBelongingTeamId) {
      const matchedTeam = await prisma.team.findFirst({
        where: {
          OR: [
            { name: { equals: manualTeamName } },
            { shortName: { equals: manualTeamName } },
          ],
        },
      });
      if (matchedTeam) effectiveBelongingTeamId = matchedTeam.id;
    }

    const player = await prisma.player.create({
      data: {
        sNo: sNo,
        name: data.name.trim(),
        profileImage: data.profileImage || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&auto=format&fit=crop&q=80',
        country: data.country || 'India',
        isOverseas: data.country ? data.country !== 'India' : false,
        age: age,
        dob: data.dob || null,
        place: data.place || null,
        phone: data.phone || null,
        role: data.role || 'All-Rounder',
        battingStyle: data.battingStyle || 'Right-hand bat',
        bowlingStyle: data.bowlingStyle || 'Right-arm medium',
        basePrice: basePrice,
        category: data.category || 'Local Talent',
        matches: Number(data.matches || 0),
        runs: Number(data.runs || 0),
        battingAvg: Number(data.battingAvg || 0),
        strikeRate: Number(data.strikeRate || 0),
        highestScore: Number(data.highestScore || 0),
        wickets: Number(data.wickets || 0),
        economy: Number(data.economy || 0),
        bowlingAvg: Number(data.bowlingAvg || 0),
        bestBowling: data.bestBowling || '0/0',
        status: 'UPCOMING',
        currentPrice: null,
        belongingTeamName: manualTeamName,
        belongingTeamId: effectiveBelongingTeamId,
      },
      include: {
        teamPlayer: {
          include: {
            team: true,
          },
        },
        belongingTeam: true,
      },
    });

    // Invalidate auction engine cache for fast updates
    auctionEngine.invalidateCache();

    // Automatically enqueue to the current auction as PENDING if one exists
    const auction = await prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (auction) {
      await prisma.auctionPlayer.create({
        data: {
          auctionId: auction.id,
          playerId: player.id,
          status: 'PENDING',
          winningTeamId: null,
          finalPrice: null,
          orderIndex: 999,
          basePrice: player.basePrice,
        },
      });
    }

    res.status(201).json({
      success: true,
      message: `Registration successful! Your S.No is #${sNo}`,
      player,
    });

    // Invalidate cache & asynchronous broadcast & debounced snapshot in background
    auctionEngine.invalidateCache();
    setImmediate(async () => {
      try {
        await auctionEngine.broadcastState();
      } catch (_) {}
      triggerDebouncedSnapshot();
    });
  } catch (error: any) {
    console.error('Public player registration error:', error);
    res.status(500).json({ error: error.message || 'Player registration failed.' });
  }
}

export async function createPlayer(req: Request, res: Response) {
  try {
    const data = req.body;
    const { teamId, ...playerData } = data;

    const lastPlayer = await prisma.player.findFirst({
      orderBy: { sNo: 'desc' },
      select: { sNo: true },
    });
    const sNo = playerData.sNo ? Number(playerData.sNo) : (lastPlayer?.sNo || 0) + 1;
    const basePrice = Number(playerData.basePrice) > 0 ? Number(playerData.basePrice) : 100;
    const manualTeamName = (data.belongingTeamName && String(data.belongingTeamName).trim() !== '')
      ? String(data.belongingTeamName).trim()
      : (data.teamName && String(data.teamName).trim() !== '' ? String(data.teamName).trim() : null);

    let effectiveBelongingTeamId = (data.belongingTeamId && data.belongingTeamId !== 'NONE' && String(data.belongingTeamId).trim() !== '')
      ? String(data.belongingTeamId).trim()
      : (teamId && teamId !== 'NONE' && String(teamId).trim() !== '' ? String(teamId).trim() : null);

    if (manualTeamName && !effectiveBelongingTeamId) {
      const matchedTeam = await prisma.team.findFirst({
        where: {
          OR: [
            { name: { equals: manualTeamName } },
            { shortName: { equals: manualTeamName } },
          ],
        },
      });
      if (matchedTeam) effectiveBelongingTeamId = matchedTeam.id;
    }

    const player = await prisma.player.create({
      data: {
        sNo: sNo,
        name: playerData.name,
        profileImage:
          playerData.profileImage ||
          'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&auto=format&fit=crop&q=80',
        country: playerData.country || 'India',
        isOverseas: playerData.country ? playerData.country !== 'India' : false,
        age: Number(playerData.age || 24),
        dob: playerData.dob || null,
        place: playerData.place || null,
        phone: playerData.phone || null,
        role: playerData.role || 'Batter',
        battingStyle: playerData.battingStyle || 'Right-hand bat',
        bowlingStyle: playerData.bowlingStyle || 'Right-arm medium',
        basePrice: basePrice,
        category: playerData.category || 'General',
        matches: Number(playerData.matches || 0),
        runs: Number(playerData.runs || 0),
        battingAvg: Number(playerData.battingAvg || 0),
        strikeRate: Number(playerData.strikeRate || 0),
        highestScore: Number(playerData.highestScore || 0),
        wickets: Number(playerData.wickets || 0),
        economy: Number(playerData.economy || 0),
        bowlingAvg: Number(playerData.bowlingAvg || 0),
        bestBowling: playerData.bestBowling || '0/0',
        status: 'UPCOMING',
        currentPrice: null,
        belongingTeamName: manualTeamName,
        belongingTeamId: effectiveBelongingTeamId,
      },
      include: {
        teamPlayer: {
          include: {
            team: true,
          },
        },
        belongingTeam: true,
      },
    });

    // Invalidate auction engine cache for fast updates
    auctionEngine.invalidateCache();

    const auction = await prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (auction) {
      await prisma.auctionPlayer.create({
        data: {
          auctionId: auction.id,
          playerId: player.id,
          status: 'PENDING',
          orderIndex: 999,
          basePrice: player.basePrice,
          finalPrice: null,
          winningTeamId: null,
        },
      });
    }

    // Invalidate auction engine cache for fast updates
    auctionEngine.invalidateCache();

    // Return instant HTTP response
    res.status(201).json(player);

    // Asynchronous broadcast & debounced snapshot in background
    setImmediate(async () => {
      try {
        await auctionEngine.broadcastState();
      } catch (_) {}
      triggerDebouncedSnapshot();
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to create player.' });
  }
}

export async function updatePlayer(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const {
      teamPlayer,
      bids,
      auctionPlayers,
      createdAt,
      updatedAt,
      id: _id,
      teamId,
      belongingTeamId,
      soldToTeamId,
      soldPrice,
      ...playerData
    } = req.body;

    const existingPlayer = await prisma.player.findUnique({
      where: { id },
      include: { teamPlayer: true },
    });

    if (!existingPlayer) {
      return res.status(404).json({ error: 'Player not found.' });
    }

    // Option 1: Player belongs to (Home Team Affiliation - independent of auction bidding)
    if (req.body.belongingTeamName !== undefined) {
      const bName = req.body.belongingTeamName && String(req.body.belongingTeamName).trim() !== ''
        ? String(req.body.belongingTeamName).trim()
        : null;
      playerData.belongingTeamName = bName;

      if (bName && !belongingTeamId) {
        const matchedTeam = await prisma.team.findFirst({
          where: {
            OR: [
              { name: { equals: bName } },
              { shortName: { equals: bName } },
            ],
          },
        });
        if (matchedTeam) playerData.belongingTeamId = matchedTeam.id;
        else playerData.belongingTeamId = null;
      } else if (!bName) {
        playerData.belongingTeamId = null;
      }
    }

    const effectiveBelongingTeamId = belongingTeamId !== undefined
      ? (belongingTeamId && belongingTeamId !== 'NONE' && String(belongingTeamId).trim() !== '' ? String(belongingTeamId).trim() : null)
      : (teamId !== undefined && soldToTeamId === undefined
          ? (teamId && teamId !== 'NONE' && String(teamId).trim() !== '' ? String(teamId).trim() : null)
          : undefined);

    if (effectiveBelongingTeamId !== undefined) {
      playerData.belongingTeamId = effectiveBelongingTeamId;
    }

    // Option 2: Player sold to (Tournament Drafted Team in Auction with purse deduction)
    if (soldToTeamId !== undefined) {
      const currentTeamPlayer = existingPlayer.teamPlayer;
      const targetSoldTeamId = soldToTeamId && soldToTeamId !== 'NONE' && String(soldToTeamId).trim() !== ''
        ? String(soldToTeamId).trim()
        : null;
      const priceToUse = Number(
        soldPrice || playerData.currentPrice || existingPlayer.currentPrice || playerData.basePrice || existingPlayer.basePrice || 100
      );

      if (targetSoldTeamId) {
        if (currentTeamPlayer) {
          if (currentTeamPlayer.teamId !== targetSoldTeamId) {
            // Refund old team
            await prisma.team.update({
              where: { id: currentTeamPlayer.teamId },
              data: { remainingPurse: { increment: currentTeamPlayer.price } },
            });
            // Deduct new team
            await prisma.team.update({
              where: { id: targetSoldTeamId },
              data: { remainingPurse: { decrement: priceToUse } },
            });
            // Update teamPlayer row
            await prisma.teamPlayer.update({
              where: { id: currentTeamPlayer.id },
              data: {
                teamId: targetSoldTeamId,
                price: priceToUse,
                isIcon: Boolean(playerData.isIcon || playerData.category === 'Icon Player'),
              },
            });
          } else {
            // Price updated on same team
            const priceDiff = priceToUse - currentTeamPlayer.price;
            if (priceDiff !== 0) {
              await prisma.team.update({
                where: { id: targetSoldTeamId },
                data: { remainingPurse: { decrement: priceDiff } },
              });
              await prisma.teamPlayer.update({
                where: { id: currentTeamPlayer.id },
                data: {
                  price: priceToUse,
                  isIcon: Boolean(playerData.isIcon || playerData.category === 'Icon Player'),
                },
              });
            }
          }
        } else {
          // Newly assigned / sold to a team
          await prisma.team.update({
            where: { id: targetSoldTeamId },
            data: { remainingPurse: { decrement: priceToUse } },
          });
          await prisma.teamPlayer.create({
            data: {
              teamId: targetSoldTeamId,
              playerId: id,
              price: priceToUse,
              isIcon: Boolean(playerData.isIcon || playerData.category === 'Icon Player'),
            },
          });
        }
        playerData.status = 'SOLD';
        playerData.currentPrice = priceToUse;
      } else {
        // Player is unassigned / released from squad -> returns to auction pool
        if (currentTeamPlayer) {
          await prisma.team.update({
            where: { id: currentTeamPlayer.teamId },
            data: { remainingPurse: { increment: currentTeamPlayer.price } },
          });
          await prisma.teamPlayer.delete({
            where: { id: currentTeamPlayer.id },
          });
        }
        playerData.status = 'UPCOMING';
        playerData.currentPrice = null;
      }
    }

    if (playerData.country !== undefined) {
      playerData.isOverseas = playerData.country !== 'India';
    }
    if (playerData.basePrice !== undefined) playerData.basePrice = Number(playerData.basePrice);
    if (playerData.age !== undefined) playerData.age = Number(playerData.age);
    if (playerData.matches !== undefined) playerData.matches = Number(playerData.matches);
    if (playerData.runs !== undefined) playerData.runs = Number(playerData.runs);
    if (playerData.wickets !== undefined) playerData.wickets = Number(playerData.wickets);
    if (playerData.highestScore !== undefined) playerData.highestScore = Number(playerData.highestScore);
    if (playerData.battingAvg !== undefined) playerData.battingAvg = Number(playerData.battingAvg);
    if (playerData.strikeRate !== undefined) playerData.strikeRate = Number(playerData.strikeRate);
    if (playerData.economy !== undefined) playerData.economy = Number(playerData.economy);
    if (playerData.bowlingAvg !== undefined) playerData.bowlingAvg = Number(playerData.bowlingAvg);

    const player = await prisma.player.update({
      where: { id },
      data: playerData,
      include: {
        teamPlayer: {
          include: {
            team: true,
          },
        },
        belongingTeam: true,
      },
    });

    // Invalidate auction engine cache for fast updates
    auctionEngine.invalidateCache();

    // Return instant HTTP response
    res.json(player);

    // Asynchronous broadcast & debounced snapshot in background
    setImmediate(async () => {
      try {
        await auctionEngine.broadcastState();
      } catch (_) {}
      triggerDebouncedSnapshot();
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update player.' });
  }
}

export async function deletePlayer(req: Request, res: Response) {
  try {
    const { id } = req.params;

    await prisma.player.delete({
      where: { id },
    });

    // Invalidate auction engine cache for fast updates
    auctionEngine.invalidateCache();

    // Return instant HTTP response
    res.json({ message: 'Player removed successfully.' });

    // Asynchronous broadcast & debounced snapshot in background
    setImmediate(async () => {
      try {
        await auctionEngine.broadcastState();
      } catch (_) {}
      triggerDebouncedSnapshot();
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to remove player.' });
  }
}
