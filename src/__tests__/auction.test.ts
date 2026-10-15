import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AuctionEngine } from '../services/auction-engine.service';
import { formatRupees, getMinBidIncrement } from '../utils/currency';

describe('Cricket Auction Arena - Core Bidding & Rules Tests', { timeout: 60000 }, () => {
  let prisma: PrismaClient;
  let engine: AuctionEngine;
  let testTeam1: any;
  let testTeam2: any;
  let testPlayerOverseas: any;
  let testPlayerDomestic: any;

  beforeAll(async () => {
    prisma = new PrismaClient();
    engine = new AuctionEngine(prisma);

    // Ensure an auction record exists and disable timer during unit tests
    let auction = await prisma.auction.findFirst();
    if (!auction) {
      auction = await prisma.auction.create({
        data: {
          status: 'ACTIVE',
          defaultPurse: 15000,
          defaultSquadLimit: 12,
          timerEnabled: false,
        },
      });
    } else {
      await prisma.auction.update({
        where: { id: auction.id },
        data: { timerEnabled: false },
      });
    }

    // Clean up any stale test teams / players from previous aborted runs
    const staleTeams = await prisma.team.findMany({
      where: { name: { in: ['Vitest Test Franchise Alpha', 'Vitest Test Franchise Beta'] } },
    });
    for (const t of staleTeams) {
      await prisma.teamPlayer.deleteMany({ where: { teamId: t.id } });
      await prisma.bid.deleteMany({ where: { teamId: t.id } });
      await prisma.team.delete({ where: { id: t.id } });
    }
    const stalePlayers = await prisma.player.findMany({
      where: { name: { in: ['Vitest Domestic Test Player', 'Vitest Overseas Test Player', 'Team 1 Home Player'] } },
    });
    for (const p of stalePlayers) {
      await prisma.teamPlayer.deleteMany({ where: { playerId: p.id } });
      await prisma.auctionPlayer.deleteMany({ where: { playerId: p.id } });
      await prisma.bid.deleteMany({ where: { playerId: p.id } });
      await prisma.player.delete({ where: { id: p.id } });
    }

    // Create 2 isolated test teams dedicated to the test suite (non-destructive)
    testTeam1 = await prisma.team.create({
      data: {
        name: 'Vitest Test Franchise Alpha',
        shortName: 'VFA',
        logoText: 'VFA',
        totalPurse: 15000,
        remainingPurse: 15000,
        maxSquadSize: 25,
        maxOverseas: 8,
      },
    });

    testTeam2 = await prisma.team.create({
      data: {
        name: 'Vitest Test Franchise Beta',
        shortName: 'VFB',
        logoText: 'VFB',
        totalPurse: 15000,
        remainingPurse: 15000,
        maxSquadSize: 25,
        maxOverseas: 8,
      },
    });

    // Create isolated test players dedicated to the test suite
    testPlayerDomestic = await prisma.player.create({
      data: {
        name: 'Vitest Domestic Test Player',
        profileImage: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400',
        country: 'India',
        isOverseas: false,
        role: 'Batter',
        basePrice: 500,
        status: 'UPCOMING',
      },
    });

    testPlayerOverseas = await prisma.player.create({
      data: {
        name: 'Vitest Overseas Test Player',
        profileImage: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400',
        country: 'Australia',
        isOverseas: true,
        role: 'All-Rounder',
        basePrice: 500,
        status: 'UPCOMING',
      },
    });
  }, 60000);

  beforeEach(() => {
    engine.stopTimer();
  });

  afterAll(async () => {
    try {
      // Clear active player on auction record if pointing to a test player
      const auction = await prisma.auction.findFirst();
      if (auction) {
        await prisma.auction.update({
          where: { id: auction.id },
          data: {
            timerEnabled: true,
            ...(auction.activePlayerId === testPlayerDomestic?.id || auction.activePlayerId === testPlayerOverseas?.id
              ? { activePlayerId: null, highestBidTeamId: null, activePlayerPrice: 0 }
              : {}),
          },
        });
      }

      // Clean up isolated test relations and entities
      const testTeamIds = [testTeam1?.id, testTeam2?.id].filter(Boolean);
      const testPlayerIds = [testPlayerDomestic?.id, testPlayerOverseas?.id].filter(Boolean);

      if (testPlayerIds.length > 0) {
        await prisma.bid.deleteMany({ where: { playerId: { in: testPlayerIds } } });
        await prisma.auctionPlayer.deleteMany({ where: { playerId: { in: testPlayerIds } } });
        await prisma.teamPlayer.deleteMany({ where: { playerId: { in: testPlayerIds } } });
        await prisma.player.deleteMany({ where: { id: { in: testPlayerIds } } });
      }

      if (testTeamIds.length > 0) {
        await prisma.bid.deleteMany({ where: { teamId: { in: testTeamIds } } });
        await prisma.teamPlayer.deleteMany({ where: { teamId: { in: testTeamIds } } });
        await prisma.team.deleteMany({ where: { id: { in: testTeamIds } } });
      }
    } catch (err) {
      console.warn('Test cleanup warning:', err);
    } finally {
      await prisma.$disconnect();
    }
  }, 60000);

  it('Currency formatting formats amounts in Indian locale (₹)', () => {
    expect(formatRupees(20000000)).toBe('₹2,00,00,000');
    expect(formatRupees(84000000)).toBe('₹8,40,00,000');
    expect(formatRupees(15000)).toBe('₹15,000');
    expect(formatRupees(2500)).toBe('₹2,500');
    expect(formatRupees(100)).toBe('₹100');
    expect(formatRupees(0)).toBe('₹0');
  });

  it('Calculates appropriate minimum bid increments based on tournament scale', () => {
    expect(getMinBidIncrement(100)).toBe(100); // ₹100 for < 500
    expect(getMinBidIncrement(400)).toBe(100); // ₹100 for < 500
    expect(getMinBidIncrement(500)).toBe(200); // ₹200 for 500-1999
    expect(getMinBidIncrement(1500)).toBe(200); // ₹200 for 500-1999
    expect(getMinBidIncrement(2000)).toBe(500); // ₹500 for >= 2000
    expect(getMinBidIncrement(10000)).toBe(500); // ₹500 for >= 2000
  });

  it('Rejects bid if auction is not active', async () => {
    // Ensure auction is idle or paused
    const auction = await prisma.auction.findFirst();
    if (auction) {
      await prisma.auction.update({ where: { id: auction.id }, data: { status: 'PAUSED' } });
    }

    await expect(engine.placeBid(testTeam1.id, 500)).rejects.toThrow(/Auction is currently/i);
  });

  it('Rejects bid if team purse is insufficient', async () => {
    // Select a player and start auction
    await engine.selectPlayer(testPlayerDomestic.id);
    await engine.startAuction();

    // Temporarily reduce purse
    await prisma.team.update({
      where: { id: testTeam1.id },
      data: { remainingPurse: 50 }, // only ₹50
    });

    await expect(engine.placeBid(testTeam1.id, 500)).rejects.toThrow(/Insufficient purse/i);

    // Restore purse
    await prisma.team.update({
      where: { id: testTeam1.id },
      data: { remainingPurse: 15000 },
    });
  });

  it('Handles valid bids, resets timer, and prevents consecutive bid from same team', async () => {
    await engine.selectPlayer(testPlayerDomestic.id);
    await engine.startAuction();

    // Team 1 bids
    const result1 = await engine.placeBid(testTeam1.id, testPlayerDomestic.basePrice);
    expect(result1.success).toBe(true);
    expect(result1.bid.amount).toBe(testPlayerDomestic.basePrice);

    // Team 1 tries to bid again immediately without another team bidding
    await expect(engine.placeBid(testTeam1.id)).rejects.toThrow(/already holds the highest bid/i);

    // Team 2 bids higher
    const result2 = await engine.placeBid(testTeam2.id);
    expect(result2.success).toBe(true);
    expect(result2.bid.amount).toBeGreaterThan(result1.bid.amount);
  });

  it('Correctly enforces overseas player limits', async () => {
    await engine.selectPlayer(testPlayerOverseas.id);
    await engine.startAuction();

    // Artificially change maxOverseas to 0 for strict test
    await prisma.team.update({
      where: { id: testTeam1.id },
      data: { maxOverseas: 0 },
    });

    await expect(engine.placeBid(testTeam1.id, testPlayerOverseas.basePrice)).rejects.toThrow(
      /Maximum overseas-player limit reached/i
    );

    // Restore maxOverseas
    await prisma.team.update({
      where: { id: testTeam1.id },
      data: { maxOverseas: 8 },
    });
  });

  it('Correctly enforces squad size limits', async () => {
    await engine.selectPlayer(testPlayerDomestic.id);
    await engine.startAuction();

    // Artificially set maxSquadSize to 0
    await prisma.team.update({
      where: { id: testTeam1.id },
      data: { maxSquadSize: 0 },
    });

    await expect(engine.placeBid(testTeam1.id, testPlayerDomestic.basePrice)).rejects.toThrow(
      /Squad limit reached/i
    );

    // Restore maxSquadSize
    await prisma.team.update({
      where: { id: testTeam1.id },
      data: { maxSquadSize: 25 },
    });
  });

  it('Simulates race conditions / concurrent bids safely', async () => {
    await engine.selectPlayer(testPlayerDomestic.id);
    await engine.startAuction();

    // Two teams try to bid concurrently
    const bidPromise1 = engine.placeBid(testTeam1.id, testPlayerDomestic.basePrice + 100);
    const bidPromise2 = engine.placeBid(testTeam2.id, testPlayerDomestic.basePrice + 100);

    const results = await Promise.allSettled([bidPromise1, bidPromise2]);

    // One should succeed, the other might get locked out or fail increment check
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
  });

  it('Successfully sells player and deducts purse atomically', async () => {
    // Ensure purse is full
    await prisma.team.update({
      where: { id: testTeam1.id },
      data: { remainingPurse: 15000 },
    });

    await engine.selectPlayer(testPlayerDomestic.id);
    await engine.startAuction();

    const initialTeamPurse = (await prisma.team.findUnique({ where: { id: testTeam1.id } }))!.remainingPurse;
    const bidPrice = testPlayerDomestic.basePrice;

    await engine.placeBid(testTeam1.id, bidPrice);
    const sellResult = await engine.sellPlayer();

    expect(sellResult.success).toBe(true);
    expect(sellResult.winningTeam.id).toBe(testTeam1.id);

    // Verify purse deducted in DB
    const updatedTeam = await prisma.team.findUnique({
      where: { id: testTeam1.id },
      include: { squad: true },
    });
    expect(updatedTeam!.remainingPurse).toBe(initialTeamPurse - bidPrice);

    // Verify player is in squad
    const inSquad = updatedTeam!.squad.some((s) => s.playerId === testPlayerDomestic.id);
    expect(inSquad).toBe(true);

    // Verify player status is SOLD
    const playerRecord = await prisma.player.findUnique({ where: { id: testPlayerDomestic.id } });
    expect(playerRecord!.status).toBe('SOLD');
  });

  it('Allows any rival team to bid on and purchase a player affiliated to another belonging team', async () => {
    // Create player belonging to Team 1
    const affiliatedPlayer = await prisma.player.create({
      data: {
        name: 'Team 1 Home Player',
        profileImage: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400',
        country: 'India',
        role: 'All-Rounder',
        basePrice: 200,
        belongingTeamId: testTeam1.id,
        status: 'UPCOMING',
      },
    });

    const auction = await prisma.auction.findFirst();
    await prisma.auctionPlayer.create({
      data: {
        auctionId: auction!.id,
        playerId: affiliatedPlayer.id,
        status: 'PENDING',
        orderIndex: 999,
        basePrice: 200,
      },
    });

    await engine.selectPlayer(affiliatedPlayer.id);

    // Team 2 (rival team) bids on Team 1's affiliated player
    await engine.placeBid(testTeam2.id, 200);

    const sellRes = await engine.sellPlayer();
    expect(sellRes.success).toBe(true);
    expect(sellRes.winningTeam.id).toBe(testTeam2.id);

    // Verify player is now in Team 2's tournament squad, while belongingTeamId remains Team 1
    const finalPlayer = await prisma.player.findUnique({
      where: { id: affiliatedPlayer.id },
      include: { teamPlayer: { include: { team: true } }, belongingTeam: true },
    });

    expect(finalPlayer!.status).toBe('SOLD');
    expect(finalPlayer!.belongingTeamId).toBe(testTeam1.id);
    expect(finalPlayer!.teamPlayer?.teamId).toBe(testTeam2.id);

    // Clean up
    await prisma.teamPlayer.deleteMany({ where: { playerId: affiliatedPlayer.id } });
    await prisma.auctionPlayer.deleteMany({ where: { playerId: affiliatedPlayer.id } });
    await prisma.bid.deleteMany({ where: { playerId: affiliatedPlayer.id } });
    await prisma.player.delete({ where: { id: affiliatedPlayer.id } });
  });

  it('Successfully shuffles pending auction pool order', async () => {
    const shuffleResult = await engine.shuffleAuctionPool();
    expect(shuffleResult).toBeDefined();
    expect(shuffleResult.auction).toBeDefined();
  });
});
