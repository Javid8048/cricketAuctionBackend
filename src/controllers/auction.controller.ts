import { Request, Response } from 'express';
import { prisma } from '../prisma';
import { AuctionEngine } from '../services/auction-engine.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

export const auctionEngine = new AuctionEngine(prisma);

export async function getCurrentAuction(req: Request, res: Response) {
  try {
    const state = await auctionEngine.getAuctionState();
    if (!state) {
      return res.status(404).json({ error: 'No auction found.' });
    }
    res.json(state);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch auction state.' });
  }
}

export async function startAuction(req: AuthenticatedRequest, res: Response) {
  try {
    const state = await auctionEngine.startAuction();
    res.json(state);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to start auction.' });
  }
}

export async function pauseAuction(req: AuthenticatedRequest, res: Response) {
  try {
    const state = await auctionEngine.pauseAuction();
    res.json(state);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to pause auction.' });
  }
}

export async function resumeAuction(req: AuthenticatedRequest, res: Response) {
  try {
    const state = await auctionEngine.resumeAuction();
    res.json(state);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to resume auction.' });
  }
}

export async function selectPlayer(req: AuthenticatedRequest, res: Response) {
  try {
    const { playerId } = req.body;
    if (!playerId) {
      return res.status(400).json({ error: 'playerId is required.' });
    }
    const state = await auctionEngine.selectPlayer(playerId);
    res.json(state);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to select player.' });
  }
}

export async function startBidding(req: AuthenticatedRequest, res: Response) {
  try {
    const state = await auctionEngine.startBidding();
    res.json(state);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to start bidding.' });
  }
}

export async function nextPlayer(req: AuthenticatedRequest, res: Response) {
  try {
    const state = await auctionEngine.nextPlayer();
    res.json(state);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to advance player.' });
  }
}

export async function placeBid(req: AuthenticatedRequest, res: Response) {
  try {
    // If authenticated as TEAM, get teamId from token or allow body for testing
    let teamId = req.user?.teamId;
    if (!teamId && req.body.teamId && req.user?.role === 'ADMIN') {
      // Admin can test bid on behalf of team if provided
      teamId = req.body.teamId;
    }

    if (!teamId) {
      return res.status(400).json({ error: 'Team ID is required to place a bid.' });
    }

    const { amount } = req.body;
    const result = await auctionEngine.placeBid(teamId, amount ? Number(amount) : undefined);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to place bid.' });
  }
}

export async function sellPlayer(req: AuthenticatedRequest, res: Response) {
  try {
    const { teamId, price } = req.body || {};
    const result = await auctionEngine.sellPlayer(teamId, price ? Number(price) : undefined);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to sell player.' });
  }
}

export async function manuallyAssignPlayer(req: AuthenticatedRequest, res: Response) {
  try {
    const { playerId, teamId, amount } = req.body;
    if (!playerId || !teamId || amount === undefined) {
      return res.status(400).json({ error: 'Player ID, Franchise ID, and amount are required.' });
    }
    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 100 || numericAmount >= 2500) {
      return res.status(400).json({ error: 'Assignment price must be greater than ₹100 and less than ₹2,500.' });
    }
    const result = await auctionEngine.manuallyAssignPlayer(playerId, teamId, numericAmount);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to manually assign player.' });
  }
}

export async function markUnsold(req: AuthenticatedRequest, res: Response) {
  try {
    const result = await auctionEngine.markUnsold();
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to mark unsold.' });
  }
}

export async function skipPlayer(req: AuthenticatedRequest, res: Response) {
  try {
    const result = await auctionEngine.skipPlayer();
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to skip player.' });
  }
}

export async function reauctionUnsold(req: AuthenticatedRequest, res: Response) {
  try {
    const result = await auctionEngine.reauctionUnsold();
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to reauction unsold players.' });
  }
}

export async function resetAuction(req: AuthenticatedRequest, res: Response) {
  try {
    const result = await auctionEngine.resetAuction();
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to reset auction.' });
  }
}

export async function getAuctionHistory(req: Request, res: Response) {
  try {
    const { teamId, playerId, limit = 100 } = req.query;

    const where: any = {};
    if (teamId) where.teamId = String(teamId);
    if (playerId) where.playerId = String(playerId);

    const bids = await prisma.bid.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
      include: {
        team: true,
        player: true,
      },
    });

    const events = await prisma.auctionEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({ bids, events });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch auction history.' });
  }
}

export async function getAuctionResults(req: Request, res: Response) {
  try {
    const soldPlayers = await prisma.auctionPlayer.findMany({
      where: { status: 'SOLD' },
      orderBy: { finalPrice: 'desc' },
      include: {
        player: true,
        winningTeam: true,
        bids: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    const unsoldPlayers = await prisma.auctionPlayer.findMany({
      where: { status: 'UNSOLD' },
      include: {
        player: true,
      },
    });

    res.json({
      sold: soldPlayers,
      unsold: unsoldPlayers,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch auction results.' });
  }
}

export async function updateAuctionSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const settings = req.body;
    const state = await auctionEngine.updateSettings(settings);
    res.json(state);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to update settings.' });
  }
}

export async function shuffleAuctionPool(req: AuthenticatedRequest, res: Response) {
  try {
    const state = await auctionEngine.shuffleAuctionPool();
    res.json({ success: true, message: 'Auction pool shuffled successfully.', state });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to shuffle auction pool.' });
  }
}

export async function clearAllTournamentData(req: AuthenticatedRequest, res: Response) {
  try {
    // Non-destructive auction reset: Clears auction history/squads but PERMANENTLY PRESERVES all players and teams
    await prisma.bid.deleteMany();
    await prisma.teamPlayer.deleteMany();
    await prisma.auctionEvent.deleteMany();
    await prisma.auctionPlayer.deleteMany();
    await auctionEngine.resetAuction();
    res.json({ success: true, message: 'Tournament auction state reset successfully while preserving all registered players and teams.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to reset tournament auction state.' });
  }
}

