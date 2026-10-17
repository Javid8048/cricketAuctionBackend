import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { auctionEngine } from './auction.controller';

const prisma = new PrismaClient();

export async function getPlayers(req: Request, res: Response) {
  try {
    const { role, country, category, status, search } = req.query;

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
      },
    });

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
      },
    });

    // Automatically enqueue to the current auction if one exists
    const auction = await prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (auction) {
      const count = await prisma.auctionPlayer.count({ where: { auctionId: auction.id } });
      await prisma.auctionPlayer.create({
        data: {
          auctionId: auction.id,
          playerId: player.id,
          status: 'PENDING',
          orderIndex: count + 1,
          basePrice: player.basePrice,
        },
      });
    }

    try {
      await auctionEngine.broadcastState();
    } catch (e) {
      console.warn('Socket broadcast warning:', e);
    }

    res.status(201).json({
      success: true,
      message: `Registration successful! Your S.No is #${sNo}`,
      player,
    });
  } catch (error: any) {
    console.error('Public player registration error:', error);
    res.status(500).json({ error: error.message || 'Player registration failed.' });
  }
}

export async function createPlayer(req: Request, res: Response) {
  try {
    const data = req.body;

    const lastPlayer = await prisma.player.findFirst({
      orderBy: { sNo: 'desc' },
      select: { sNo: true },
    });
    const sNo = data.sNo ? Number(data.sNo) : (lastPlayer?.sNo || 0) + 1;

    const basePrice = Number(data.basePrice) > 0 ? Number(data.basePrice) : 100;

    const player = await prisma.player.create({
      data: {
        sNo: sNo,
        name: data.name,
        profileImage: data.profileImage || 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&auto=format&fit=crop&q=80',
        country: data.country || 'India',
        isOverseas: data.country ? data.country !== 'India' : false,
        age: Number(data.age || 24),
        dob: data.dob || null,
        place: data.place || null,
        phone: data.phone || null,
        role: data.role || 'Batter',
        battingStyle: data.battingStyle || 'Right-hand bat',
        bowlingStyle: data.bowlingStyle || 'Right-arm medium',
        basePrice: basePrice,
        category: data.category || 'General',
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
      },
    });

    const auction = await prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (auction) {
      const count = await prisma.auctionPlayer.count({ where: { auctionId: auction.id } });
      await prisma.auctionPlayer.create({
        data: {
          auctionId: auction.id,
          playerId: player.id,
          status: 'PENDING',
          orderIndex: count + 1,
          basePrice: player.basePrice,
        },
      });
    }

    try {
      await auctionEngine.broadcastState();
    } catch (e) {}

    res.status(201).json(player);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to create player.' });
  }
}

export async function updatePlayer(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const data = req.body;

    const player = await prisma.player.update({
      where: { id },
      data: {
        ...data,
        isOverseas: data.country ? data.country !== 'India' : undefined,
      },
    });

    try {
      await auctionEngine.broadcastState();
    } catch (e) {}

    res.json(player);
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

    try {
      await auctionEngine.broadcastState();
    } catch (e) {}

    res.json({ message: 'Player removed successfully.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to remove player.' });
  }
}
