import { Request, Response } from 'express';
import { prisma } from '../prisma';

export async function getDashboardStats(req: Request, res: Response) {
  try {
    const totalPlayersCount = await prisma.player.count();
    const soldPlayers = await prisma.auctionPlayer.findMany({
      where: { status: 'SOLD' },
      include: {
        player: true,
        winningTeam: true,
      },
      orderBy: { finalPrice: 'desc' },
    });

    const unsoldPlayersCount = await prisma.auctionPlayer.count({
      where: { status: 'UNSOLD' },
    });

    const soldCount = soldPlayers.length;
    const remainingCount = totalPlayersCount - soldCount - unsoldPlayersCount;

    const totalSpent = soldPlayers.reduce((acc, curr) => acc + (curr.finalPrice || 0), 0);
    const avgPrice = soldCount > 0 ? totalSpent / soldCount : 0;
    const highestPurchase = soldPlayers.length > 0 ? soldPlayers[0] : null;

    // Spending by Team
    const teams = await prisma.team.findMany({
      include: {
        squad: {
          include: {
            player: true,
          },
        },
      },
    });

    const spendingByTeam = teams.map((t) => ({
      name: t.name,
      shortName: t.shortName,
      color: t.primaryColor,
      totalSpent: t.totalPurse - t.remainingPurse,
      remainingPurse: t.remainingPurse,
      squadCount: t.squad.length,
      overseasCount: t.squad.filter((sp) => sp.player.isOverseas).length,
    }));

    // Players Sold by Role
    const roleMap: Record<string, number> = {
      Batter: 0,
      Bowler: 0,
      'All-Rounder': 0,
      Wicketkeeper: 0,
    };

    soldPlayers.forEach((sp) => {
      const r = sp.player.role;
      roleMap[r] = (roleMap[r] || 0) + 1;
    });

    const soldByRole = Object.keys(roleMap).map((role) => ({
      role,
      count: roleMap[role],
    }));

    // Players Sold by Country
    const countryMap: Record<string, number> = {};
    soldPlayers.forEach((sp) => {
      const c = sp.player.country;
      countryMap[c] = (countryMap[c] || 0) + 1;
    });

    const soldByCountry = Object.keys(countryMap).map((country) => ({
      country,
      count: countryMap[country],
    }));

    // Price distribution brackets:
    // < 1 Cr, 1-3 Cr, 3-7 Cr, 7-12 Cr, > 12 Cr
    const priceBrackets = [
      { label: '< 1 Cr', min: 0, max: 10000000, count: 0 },
      { label: '1 - 3 Cr', min: 10000000, max: 30000000, count: 0 },
      { label: '3 - 7 Cr', min: 30000000, max: 70000000, count: 0 },
      { label: '7 - 12 Cr', min: 70000000, max: 120000000, count: 0 },
      { label: '> 12 Cr', min: 120000000, max: Infinity, count: 0 },
    ];

    soldPlayers.forEach((sp) => {
      const price = sp.finalPrice || 0;
      for (const b of priceBrackets) {
        if (price >= b.min && price < b.max) {
          b.count += 1;
          break;
        }
      }
    });

    // Recent purchases (latest 10)
    const recentPurchases = await prisma.auctionPlayer.findMany({
      where: { status: 'SOLD' },
      orderBy: { soldAt: 'desc' },
      take: 10,
      include: {
        player: true,
        winningTeam: true,
      },
    });

    res.json({
      summary: {
        totalPlayers: totalPlayersCount,
        soldCount,
        unsoldCount: unsoldPlayersCount,
        remainingCount,
        totalSpent,
        avgPrice,
        highestPurchase,
      },
      spendingByTeam,
      soldByRole,
      soldByCountry,
      priceDistribution: priceBrackets,
      recentPurchases,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch dashboard stats.' });
  }
}
