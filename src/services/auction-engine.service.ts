import { PrismaClient } from '@prisma/client';
import { Server as SocketIOServer } from 'socket.io';
import { formatRupees, getMinBidIncrement } from '../utils/currency';

export class AuctionEngine {
  private prisma: PrismaClient;
  private io: SocketIOServer | null = null;
  private timerInterval: NodeJS.Timeout | null = null;
  private secondsLeft: number = 10;
  private isProcessingBid: boolean = false;
  private autoNextTimeout: NodeJS.Timeout | null = null;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public setSocketServer(io: SocketIOServer) {
    this.io = io;
  }

  public getIo(): SocketIOServer | null {
    return this.io;
  }

  /**
   * Broadcast an event to all connected clients
   */
  public broadcast(event: string, data: any) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  /**
   * Get current state of active auction with loaded player, bids, and teams
   */
  public async getAuctionState() {
    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
      include: {
        bids: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            team: true,
            player: true,
          },
        },
      },
    });

    if (!auction) return null;

    let activePlayer = null;
    let highestBidTeam = null;

    if (auction.activePlayerId) {
      activePlayer = await this.prisma.player.findUnique({
        where: { id: auction.activePlayerId },
        include: {
          belongingTeam: true,
          teamPlayer: {
            include: {
              team: true,
            },
          },
        },
      });
    }

    if (auction.highestBidTeamId) {
      highestBidTeam = await this.prisma.team.findUnique({
        where: { id: auction.highestBidTeamId },
      });
    }

    const teams = await this.prisma.team.findMany({
      include: {
        squad: {
          include: {
            player: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    // Formatted teams with computed squad stats
    const formattedTeams = teams.map((t) => {
      const overseasCount = t.squad.filter((sp) => sp.player.isOverseas).length;
      const batters = t.squad.filter((sp) => sp.player.role === 'Batter').length;
      const bowlers = t.squad.filter((sp) => sp.player.role === 'Bowler').length;
      const allRounders = t.squad.filter((sp) => sp.player.role === 'All-Rounder').length;
      const wicketkeepers = t.squad.filter((sp) => sp.player.role === 'Wicketkeeper').length;

      return {
        ...t,
        squadSize: t.squad.length,
        overseasCount,
        batters,
        bowlers,
        allRounders,
        wicketkeepers,
      };
    });

    const players = await this.prisma.player.findMany({
      include: {
        teamPlayer: {
          include: {
            team: true,
          },
        },
        belongingTeam: true,
      },
      orderBy: [{ sNo: 'asc' }, { name: 'asc' }],
    });

    return {
      auction: {
        ...auction,
        secondsLeft: this.secondsLeft,
      },
      activePlayer,
      highestBidTeam,
      currentBid: auction.activePlayerPrice || (activePlayer ? activePlayer.basePrice : 0),
      teams: formattedTeams,
      players,
      recentBids: auction.bids,
      minIncrement: auction.activePlayerPrice
        ? getMinBidIncrement(auction.activePlayerPrice)
        : activePlayer
        ? getMinBidIncrement(activePlayer.basePrice)
        : 1000000,
    };
  }

  /**
   * Start or resume auction
   */
  public async startAuction() {
    let auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (!auction) {
      throw new Error('No auction found');
    }

    // If auction has no active player, pick the first pending player
    if (!auction.activePlayerId) {
      const firstPending = await this.prisma.auctionPlayer.findFirst({
        where: { auctionId: auction.id, status: 'PENDING' },
        orderBy: { orderIndex: 'asc' },
        include: { player: true },
      });

      if (firstPending) {
        auction = await this.prisma.auction.update({
          where: { id: auction.id },
          data: {
            status: 'ACTIVE',
            activePlayerId: firstPending.playerId,
            activePlayerPrice: firstPending.player.basePrice,
            highestBidTeamId: null,
            startedAt: auction.startedAt || new Date(),
          },
        });

        await this.prisma.player.update({
          where: { id: firstPending.playerId },
          data: { status: 'IN_AUCTION' },
        });

        await this.prisma.auctionPlayer.update({
          where: { id: firstPending.id },
          data: { status: 'CURRENT', startedAt: new Date() },
        });
      } else {
        auction = await this.prisma.auction.update({
          where: { id: auction.id },
          data: { status: 'ACTIVE', startedAt: auction.startedAt || new Date() },
        });
      }
    } else {
      auction = await this.prisma.auction.update({
        where: { id: auction.id },
        data: { status: 'ACTIVE' },
      });
    }

    this.startTimer();

    const state = await this.getAuctionState();
    this.broadcast('auction:started', state);
    return state;
  }

  /**
   * Pause auction
   */
  public async pauseAuction() {
    this.stopTimer();
    if (this.autoNextTimeout) {
      clearTimeout(this.autoNextTimeout);
      this.autoNextTimeout = null;
    }

    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (auction) {
      await this.prisma.auction.update({
        where: { id: auction.id },
        data: { status: 'PAUSED' },
      });
    }

    const state = await this.getAuctionState();
    this.broadcast('auction:paused', state);
    return state;
  }

  /**
   * Resume auction
   */
  public async resumeAuction() {
    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (auction) {
      await this.prisma.auction.update({
        where: { id: auction.id },
        data: { status: 'ACTIVE' },
      });
    }

    this.startTimer();
    const state = await this.getAuctionState();
    this.broadcast('auction:resumed', state);
    return state;
  }

  /**
   * Select a specific player for the auction
   */
  public async selectPlayer(playerId: string) {
    this.stopTimer();
    if (this.autoNextTimeout) {
      clearTimeout(this.autoNextTimeout);
      this.autoNextTimeout = null;
    }

    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (!auction) throw new Error('No auction found');

    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
    });
    if (!player) throw new Error('Player not found');

    // Reset previous in-auction players if any
    await this.prisma.player.updateMany({
      where: { status: 'IN_AUCTION', id: { not: playerId } },
      data: { status: 'UPCOMING' },
    });

    await this.prisma.player.update({
      where: { id: playerId },
      data: { status: 'IN_AUCTION' },
    });

    // Update auction player entry
    let auctionPlayer = await this.prisma.auctionPlayer.findFirst({
      where: { auctionId: auction.id, playerId: playerId },
    });

    if (!auctionPlayer) {
      auctionPlayer = await this.prisma.auctionPlayer.create({
        data: {
          auctionId: auction.id,
          playerId: playerId,
          status: 'CURRENT',
          basePrice: player.basePrice,
          startedAt: new Date(),
        },
      });
    } else {
      await this.prisma.auctionPlayer.update({
        where: { id: auctionPlayer.id },
        data: { status: 'CURRENT', startedAt: new Date(), finalPrice: null, winningTeamId: null },
      });
    }

    // Update auction
    await this.prisma.auction.update({
      where: { id: auction.id },
      data: {
        activePlayerId: playerId,
        activePlayerPrice: player.basePrice,
        highestBidTeamId: null,
      },
    });

    this.secondsLeft = auction.defaultTimerSec || 10;
    if (auction.status === 'ACTIVE' && auction.timerEnabled !== false) {
      this.startTimer();
    }
    const state = await this.getAuctionState();
    this.broadcast('auction:player', state);
    return state;
  }

  /**
   * Start bidding timer on current player
   */
  public async startBidding() {
    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (!auction || !auction.activePlayerId) {
      throw new Error('No active player on the auction block');
    }

    await this.prisma.auction.update({
      where: { id: auction.id },
      data: { status: 'ACTIVE' },
    });

    this.secondsLeft = auction.defaultTimerSec || 10;
    this.startTimer();

    const state = await this.getAuctionState();
    this.broadcast('auction:resumed', state);
    return state;
  }

  /**
   * Advance to next player in queue
   */
  public async nextPlayer() {
    this.stopTimer();
    if (this.autoNextTimeout) {
      clearTimeout(this.autoNextTimeout);
      this.autoNextTimeout = null;
    }

    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (!auction) throw new Error('No auction found');

    const nextPending = await this.prisma.auctionPlayer.findFirst({
      where: {
        auctionId: auction.id,
        status: 'PENDING',
      },
      orderBy: { orderIndex: 'asc' },
      include: { player: true },
    });

    if (!nextPending) {
      // No more pending players in current round
      await this.prisma.auction.update({
        where: { id: auction.id },
        data: {
          status: 'COMPLETED',
          activePlayerId: null,
          activePlayerPrice: null,
          highestBidTeamId: null,
          endedAt: new Date(),
        },
      });

      const state = await this.getAuctionState();
      this.broadcast('auction:ended', {
        message: 'Auction round has concluded! All players processed.',
        state,
      });
      return state;
    }

    return await this.selectPlayer(nextPending.playerId);
  }

  /**
   * Process a bid from a team
   * Uses lock to prevent race conditions when two teams bid simultaneously
   */
  public async placeBid(teamId: string, customAmount?: number) {
    if (this.isProcessingBid) {
      throw new Error('Another bid is currently being processed. Please retry.');
    }

    this.isProcessingBid = true;

    try {
      const auction = await this.prisma.auction.findFirst({
        orderBy: { createdAt: 'desc' },
      });

      if (!auction) {
        throw new Error('No active auction found.');
      }

      if (auction.status !== 'ACTIVE') {
        throw new Error(`Auction is currently ${auction.status.toLowerCase()}. Bids not accepted.`);
      }

      if (!auction.activePlayerId) {
        throw new Error('No player is currently on the auction block.');
      }

      const player = await this.prisma.player.findUnique({
        where: { id: auction.activePlayerId },
      });

      if (!player) {
        throw new Error('Active player not found.');
      }

      const team = await this.prisma.team.findUnique({
        where: { id: teamId },
        include: {
          squad: {
            include: { player: true },
          },
        },
      });

      if (!team) {
        throw new Error('Team not found.');
      }

      // Rule: Team cannot bid against itself if already highest bidder
      if (auction.highestBidTeamId === team.id) {
        throw new Error('Your team already holds the highest bid!');
      }

      // Rule: Squad limit (max 25)
      if (team.squad.length >= team.maxSquadSize) {
        throw new Error(`Squad limit reached (${team.maxSquadSize} players). Cannot purchase more players.`);
      }

      // Rule: Overseas limit (max 8)
      if (player.isOverseas) {
        const overseasInSquad = team.squad.filter((s) => s.player.isOverseas).length;
        if (overseasInSquad >= team.maxOverseas) {
          throw new Error(`Maximum overseas-player limit reached (${team.maxOverseas} overseas players).`);
        }
      }

      // Calculate next bid amount
      const currentHighest = auction.activePlayerPrice || player.basePrice;
      const minInc = getMinBidIncrement(currentHighest);
      let targetBid: number;

      if (!auction.highestBidTeamId) {
        // First bid can be at base price or custom amount >= base price
        targetBid = customAmount ? customAmount : player.basePrice;
        if (targetBid < player.basePrice) {
          throw new Error(`Bid must be at least base price of ${formatRupees(player.basePrice)}.`);
        }
      } else {
        // Subsequent bid
        if (customAmount) {
          targetBid = customAmount;
          if (targetBid <= currentHighest) {
            throw new Error(`Bid must be higher than current bid of ${formatRupees(currentHighest)}.`);
          }
        } else {
          targetBid = currentHighest + minInc;
        }
      }

      // Rule: Purse limit
      if (team.remainingPurse < targetBid) {
        throw new Error(
          `Insufficient purse. Team has ${formatRupees(team.remainingPurse)} remaining, but bid requires ${formatRupees(
            targetBid
          )}.`
        );
      }

      // Atomic DB transaction to record bid and update auction state
      const result = await this.prisma.$transaction(async (tx) => {
        // Count previous bids for this player in this auction
        const bidCount = await tx.bid.count({
          where: {
            auctionId: auction.id,
            playerId: player.id,
          },
        });

        // Create Bid record
        const newBid = await tx.bid.create({
          data: {
            auctionId: auction.id,
            playerId: player.id,
            teamId: team.id,
            amount: targetBid,
            bidNumber: bidCount + 1,
          },
          include: {
            team: true,
            player: true,
          },
        });

        // Update Auction
        const updatedAuction = await tx.auction.update({
          where: { id: auction.id },
          data: {
            activePlayerPrice: targetBid,
            highestBidTeamId: team.id,
          },
        });

        // Create Auction Event
        await tx.auctionEvent.create({
          data: {
            auctionId: auction.id,
            type: 'BID_PLACED',
            message: `${team.name} placed a bid of ${formatRupees(targetBid)} on ${player.name}`,
            metadata: JSON.stringify({
              teamId: team.id,
              teamName: team.name,
              playerId: player.id,
              playerName: player.name,
              amount: targetBid,
            }),
          },
        });

        return { newBid, updatedAuction };
      });

      // Reset timer to default on every valid bid if timer is enabled
      const currentAuction = await this.prisma.auction.findFirst({ orderBy: { createdAt: 'desc' } });
      if (currentAuction && currentAuction.timerEnabled !== false) {
        this.secondsLeft = currentAuction.defaultTimerSec || 10;
        this.startTimer();
      }

      // Broadcast bid event
      const state = await this.getAuctionState();
      this.broadcast('auction:bid', {
        bid: result.newBid,
        amount: targetBid,
        teamName: team.name,
        teamShortName: team.shortName,
        teamColor: team.primaryColor,
        playerName: player.name,
        state,
      });

      return { success: true, bid: result.newBid, state };
    } finally {
      this.isProcessingBid = false;
    }
  }

  /**
   * Conclude current player as SOLD
   * Supports manual selling directly to a specified team at a specified price by Admin
   */
  public async sellPlayer(manualTeamId?: string, manualPrice?: number) {
    this.stopTimer();

    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (!auction || !auction.activePlayerId) {
      throw new Error('No active player on the auction block.');
    }

    const playerId = auction.activePlayerId;
    const teamId = manualTeamId || auction.highestBidTeamId;

    if (!teamId) {
      // If nobody bid and no manual team specified, mark as unsold instead
      return await this.markUnsold();
    }

    const player = await this.prisma.player.findUnique({ where: { id: playerId } });
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: { squad: true },
    });

    if (!player || !team) {
      throw new Error('Player or target team not found.');
    }

    const winningPrice = (manualPrice !== undefined && Number(manualPrice) > 0)
      ? Number(manualPrice)
      : (auction.activePlayerPrice || player.basePrice || 100);

    // Validate team purse
    if (team.remainingPurse < winningPrice) {
      throw new Error(`Team ${team.name} has insufficient purse (${formatRupees(team.remainingPurse)}) for ${formatRupees(winningPrice)}.`);
    }

    // Validate squad limit
    if (team.squad.length >= team.maxSquadSize) {
      throw new Error(`Team ${team.name} has already reached the maximum squad limit (${team.maxSquadSize} players).`);
    }

    // Atomic transaction for purse deduction, squad addition, status update
    await this.prisma.$transaction(async (tx) => {
      // 1. Deduct purse
      await tx.team.update({
        where: { id: teamId },
        data: {
          remainingPurse: { decrement: winningPrice },
        },
      });

      // 2. Add or update player in squad (upsert avoids unique constraint failures on re-auction/icon players)
      await tx.teamPlayer.upsert({
        where: { playerId: playerId },
        create: {
          teamId: teamId,
          playerId: playerId,
          price: winningPrice,
        },
        update: {
          teamId: teamId,
          price: winningPrice,
        },
      });

      // 3. Update player status
      await tx.player.update({
        where: { id: playerId },
        data: {
          status: 'SOLD',
          currentPrice: winningPrice,
        },
      });

      // 4. Update auction player record
      await tx.auctionPlayer.updateMany({
        where: {
          auctionId: auction.id,
          playerId: playerId,
        },
        data: {
          status: 'SOLD',
          finalPrice: winningPrice,
          winningTeamId: teamId,
          soldAt: new Date(),
        },
      });

      // 5. Update auction active record
      await tx.auction.update({
        where: { id: auction.id },
        data: {
          highestBidTeamId: teamId,
          activePlayerPrice: winningPrice,
        },
      });

      // 6. Log event
      await tx.auctionEvent.create({
        data: {
          auctionId: auction.id,
          type: 'SOLD',
          message: manualTeamId
            ? `SOLD! ${player.name} manually sold to ${team.name} for ${formatRupees(winningPrice)}!`
            : `SOLD! ${player.name} sold to ${team.name} for ${formatRupees(winningPrice)}!`,
          metadata: JSON.stringify({
            playerId: player.id,
            playerName: player.name,
            teamId: team.id,
            teamName: team.name,
            amount: winningPrice,
            isManualSale: Boolean(manualTeamId),
          }),
        },
      });
    });

    const soldData = {
      player,
      winningTeam: team,
      finalPrice: winningPrice,
      formattedPrice: formatRupees(winningPrice),
      isManualSale: Boolean(manualTeamId),
    };

    const state = await this.getAuctionState();
    this.broadcast('auction:sold', {
      ...soldData,
      state,
    });

    // Automatically transition to next player after 4.5 seconds broadcast pause
    this.autoNextTimeout = setTimeout(async () => {
      try {
        await this.nextPlayer();
      } catch (err) {
        console.error('Error auto-advancing next player:', err);
      }
    }, 4500);

    return { success: true, ...soldData, state };
  }

  /**
   * Mark current player as UNSOLD
   */
  public async markUnsold() {
    this.stopTimer();

    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (!auction || !auction.activePlayerId) {
      throw new Error('No active player on the auction block.');
    }

    const playerId = auction.activePlayerId;
    const player = await this.prisma.player.findUnique({ where: { id: playerId } });
    if (!player) throw new Error('Player not found.');

    await this.prisma.$transaction(async (tx) => {
      await tx.player.update({
        where: { id: playerId },
        data: { status: 'UNSOLD' },
      });

      await tx.auctionPlayer.updateMany({
        where: { auctionId: auction.id, playerId: playerId },
        data: { status: 'UNSOLD' },
      });

      await tx.auctionEvent.create({
        data: {
          auctionId: auction.id,
          type: 'UNSOLD',
          message: `UNSOLD! ${player.name} went unsold at base price ${formatRupees(player.basePrice)}.`,
          metadata: JSON.stringify({ playerId: player.id, playerName: player.name }),
        },
      });
    });

    const unsoldData = {
      player,
      basePrice: player.basePrice,
      formattedBasePrice: formatRupees(player.basePrice),
    };

    const state = await this.getAuctionState();
    this.broadcast('auction:unsold', {
      ...unsoldData,
      state,
    });

    // Automatically advance after 3.5 seconds
    this.autoNextTimeout = setTimeout(async () => {
      try {
        await this.nextPlayer();
      } catch (err) {
        console.error('Error auto-advancing next player:', err);
      }
    }, 3500);

    return { success: true, ...unsoldData, state };
  }

  /**
   * Skip current player without marking unsold
   */
  public async skipPlayer() {
    this.stopTimer();
    return await this.nextPlayer();
  }

  /**
   * Re-auction all unsold players in a new round
   */
  public async reauctionUnsold() {
    this.stopTimer();
    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (!auction) throw new Error('No auction found');

    const nextRound = (auction.currentRound || 1) + 1;

    // Find all currently unsold players
    const unsoldPlayers = await this.prisma.player.findMany({
      where: { status: 'UNSOLD' },
    });

    if (unsoldPlayers.length === 0) {
      throw new Error('There are currently no unsold players to re-auction.');
    }

    // Reset status to UPCOMING and create new AuctionPlayer entries for round 2
    for (let i = 0; i < unsoldPlayers.length; i++) {
      const p = unsoldPlayers[i];
      await this.prisma.player.update({
        where: { id: p.id },
        data: { status: 'UPCOMING' },
      });

      await this.prisma.auctionPlayer.create({
        data: {
          auctionId: auction.id,
          playerId: p.id,
          status: 'PENDING',
          round: nextRound,
          orderIndex: i + 1,
          basePrice: p.basePrice,
        },
      });
    }

    await this.prisma.auction.update({
      where: { id: auction.id },
      data: {
        currentRound: nextRound,
        activePlayerId: null,
        activePlayerPrice: null,
        highestBidTeamId: null,
        status: 'ACTIVE',
      },
    });

    return await this.nextPlayer();
  }

  /**
   * Reset auction completely back to virgin state
   */
  public async resetAuction() {
    this.stopTimer();
    if (this.autoNextTimeout) {
      clearTimeout(this.autoNextTimeout);
      this.autoNextTimeout = null;
    }

    // 1. Delete all bids, team squads, auction events
    await this.prisma.bid.deleteMany();
    await this.prisma.teamPlayer.deleteMany();
    await this.prisma.auctionEvent.deleteMany();
    await this.prisma.auctionPlayer.deleteMany();

    // 2. Reset each team's purse back to their configured tournament totalPurse
    const teams = await this.prisma.team.findMany();
    for (const t of teams) {
      await this.prisma.team.update({
        where: { id: t.id },
        data: {
          remainingPurse: t.totalPurse,
        },
      });
    }

    // 3. Reset player statuses
    await this.prisma.player.updateMany({
      data: {
        status: 'UPCOMING',
        currentPrice: null,
      },
    });

    // 4. Reset auction
    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (auction) {
      await this.prisma.auction.update({
        where: { id: auction.id },
        data: {
          status: 'IDLE',
          currentRound: 1,
          activePlayerId: null,
          activePlayerPrice: null,
          highestBidTeamId: null,
          startedAt: null,
          endedAt: null,
        },
      });

      // Re-enqueue all players
      const allPlayers = await this.prisma.player.findMany({
        orderBy: { basePrice: 'desc' },
      });

      for (let idx = 0; idx < allPlayers.length; idx++) {
        await this.prisma.auctionPlayer.create({
          data: {
            auctionId: auction.id,
            playerId: allPlayers[idx].id,
            status: 'PENDING',
            round: 1,
            orderIndex: idx + 1,
            basePrice: allPlayers[idx].basePrice,
          },
        });
      }
    }

    this.secondsLeft = 10;
    const state = await this.getAuctionState();
    this.broadcast('auction:reset', state);
    return state;
  }

  /**
   * Update Tournament and Auction Settings (Admin Only)
   */
  public async updateSettings(settings: {
    autoSell?: boolean;
    timerEnabled?: boolean;
    defaultTimerSec?: number;
    defaultPurse?: number;
    defaultSquadLimit?: number;
    iconPlayerPrice?: number;
    defaultBasePrice?: number;
    applyToExistingTeams?: boolean;
  }) {
    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (!auction) throw new Error('No auction found');

    const updated = await this.prisma.auction.update({
      where: { id: auction.id },
      data: {
        autoSell: settings.autoSell !== undefined ? Boolean(settings.autoSell) : auction.autoSell,
        timerEnabled: settings.timerEnabled !== undefined ? Boolean(settings.timerEnabled) : auction.timerEnabled,
        defaultTimerSec: settings.defaultTimerSec ? Number(settings.defaultTimerSec) : auction.defaultTimerSec,
        defaultPurse: settings.defaultPurse ? Number(settings.defaultPurse) : auction.defaultPurse,
        defaultSquadLimit: settings.defaultSquadLimit ? Number(settings.defaultSquadLimit) : auction.defaultSquadLimit,
        iconPlayerPrice: settings.iconPlayerPrice ? Number(settings.iconPlayerPrice) : auction.iconPlayerPrice,
        defaultBasePrice: settings.defaultBasePrice ? Number(settings.defaultBasePrice) : auction.defaultBasePrice,
      },
    });

    if (settings.applyToExistingTeams && (settings.defaultPurse || settings.defaultSquadLimit)) {
      const teams = await this.prisma.team.findMany();
      for (const t of teams) {
        const spent = t.totalPurse - t.remainingPurse;
        const newTotal = settings.defaultPurse ? Number(settings.defaultPurse) : t.totalPurse;
        const newRemaining = Math.max(0, newTotal - spent);
        await this.prisma.team.update({
          where: { id: t.id },
          data: {
            totalPurse: newTotal,
            remainingPurse: newRemaining,
            maxSquadSize: settings.defaultSquadLimit ? Number(settings.defaultSquadLimit) : t.maxSquadSize,
          },
        });
      }
    }

    if (settings.defaultTimerSec) {
      this.secondsLeft = Number(settings.defaultTimerSec);
    }

    if (settings.timerEnabled === false) {
      this.stopTimer();
      this.broadcast('auction:timer', {
        secondsLeft: null,
        timerEnabled: false,
        message: 'Manual Auction Mode (Timer Disabled)',
      });
    } else if (settings.timerEnabled === true) {
      if (updated.status === 'ACTIVE' && updated.activePlayerId) {
        this.secondsLeft = updated.defaultTimerSec || 10;
        this.startTimer();
      }
    }

    const state = await this.getAuctionState();
    this.broadcast('auction:settings_updated', state);
    return state;
  }

  /**
   * Server-controlled bid timer with autoSell toggle and enable/disable
   */
  private async startTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (!auction) return;

    if (auction.timerEnabled === false) {
      this.broadcast('auction:timer', {
        secondsLeft: null,
        timerEnabled: false,
        message: 'Manual Auction Mode (Timer Disabled)',
      });
      return;
    }

    this.timerInterval = setInterval(async () => {
      this.secondsLeft -= 1;

      // Broadcast timer tick
      this.broadcast('auction:timer', {
        secondsLeft: this.secondsLeft,
        timerEnabled: true,
        warning: this.secondsLeft <= 5 && this.secondsLeft > 0,
        urgent: this.secondsLeft <= 3 && this.secondsLeft > 0,
      });

      if (this.secondsLeft <= 0) {
        this.stopTimer();

        // Check if there is a highest bidder
        const currentAuction = await this.prisma.auction.findFirst({
          orderBy: { createdAt: 'desc' },
        });

        if (currentAuction && currentAuction.activePlayerId) {
          if (currentAuction.autoSell) {
            if (currentAuction.highestBidTeamId) {
              console.log(`[Timer expired - Auto-Sell]: Selling player ${currentAuction.activePlayerId} to ${currentAuction.highestBidTeamId}`);
              await this.sellPlayer();
            } else {
              console.log(`[Timer expired - Auto-Unsold]: No bids placed, player ${currentAuction.activePlayerId} is UNSOLD`);
              await this.markUnsold();
            }
          } else {
            console.log(`[Timer expired - Manual Mode]: Awaiting Admin confirmation to sell player ${currentAuction.activePlayerId}`);
            this.broadcast('auction:timer_ended_manual', {
              message: 'Timer reached 0! Awaiting Admin confirmation to Sell or Mark Unsold.',
              highestBidTeamId: currentAuction.highestBidTeamId,
              activePlayerPrice: currentAuction.activePlayerPrice,
            });
          }
        }
      }
    }, 1000);
  }

  private stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }
}
