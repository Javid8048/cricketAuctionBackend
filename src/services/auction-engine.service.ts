import { PrismaClient } from '@prisma/client';
import { Server as SocketIOServer } from 'socket.io';
import { formatRupees, getMinBidIncrement } from '../utils/currency';
import { getLiveAuction, updateLiveAuction, getLiveTeams, getLivePlayers } from '../utils/persistence';

export class AuctionEngine {
  private prisma: PrismaClient;
  private io: SocketIOServer | null = null;
  private timerInterval: NodeJS.Timeout | null = null;
  private secondsLeft: number = 10;
  private defaultTimerSec: number = 10;
  private timerEnabled: boolean = true;
  private autoSell: boolean = true;
  private isProcessingBid: boolean = false;
  private autoNextTimeout: NodeJS.Timeout | null = null;

  // In-memory caching for ultra-fast Live Auction updates
  private cachedFullAuctionState: any = null;
  private cachedFormattedTeams: any[] | null = null;
  private cachedPlayers: any[] | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL_MS: number = 20000; // 20 seconds TTL fallback

  private onInvalidateCallbacks: (() => void)[] = [];

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public onInvalidate(cb: () => void) {
    this.onInvalidateCallbacks.push(cb);
  }

  public invalidateCache() {
    this.cachedFullAuctionState = null;
    this.cachedFormattedTeams = null;
    this.cachedPlayers = null;
    this.cacheTimestamp = 0;
    for (const cb of this.onInvalidateCallbacks) {
      try {
        cb();
      } catch (_) {}
    }
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
   * Broadcast full auction state (including all players & teams) to all connected clients
   */
  /**
   * Helper to strip heavy base64 photos from bulk player list or omit players array entirely.
   * This reduces frequent WebSocket payload size from ~7.7 MB down to ~1.5 KB (99.9% bandwidth saving).
   * Ensures Render's 5 GB free monthly bandwidth quota is never exceeded even with 50+ live viewers.
   */
  public getCompactAuctionState(state: any, omitPlayersList: boolean = false) {
    if (!state) return state;

    if (omitPlayersList) {
      const { players, ...rest } = state;
      return rest;
    }

    if (Array.isArray(state.players)) {
      const lightPlayers = state.players.map((p: any) => {
        if (!p) return p;
        const { profileImage, photo, ...lightP } = p;
        return {
          ...lightP,
          profileImage: '',
        };
      });
      return {
        ...state,
        players: lightPlayers,
      };
    }

    return state;
  }

  /**
   * Broadcast full auction state (including all players & teams) to all connected clients
   */
  public async broadcastState(event: string = 'auction:init') {
    const state = await this.getAuctionState();
    if (state) {
      this.broadcast(event, this.getCompactAuctionState(state, false));
    }
    return state;
  }

  /**
   * Get current state of active auction with loaded player, bids, and teams
   * Uses in-memory caching and parallel Promise.all queries for sub-100ms response times
   */
  public async getAuctionState() {
    const isCacheValid =
      this.cachedFullAuctionState !== null &&
      Date.now() - this.cacheTimestamp < this.CACHE_TTL_MS;

    if (isCacheValid) {
      return {
        ...this.cachedFullAuctionState,
        auction: {
          ...this.cachedFullAuctionState.auction,
          secondsLeft: this.secondsLeft,
        },
      };
    }

    let auction: any = null;
    let fetchedTeams: any[] = [];
    let fetchedPlayers: any[] = [];
    let activePlayer: any = null;
    let highestBidTeam: any = null;

    try {
      const [dbAuction, dbTeams, dbPlayers] = await Promise.all([
        this.prisma.auction.findFirst({
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
        }),
        this.prisma.team.findMany({
          include: {
            squad: {
              include: {
                player: true,
              },
            },
          },
          orderBy: { name: 'asc' },
        }),
        this.prisma.player.findMany({
          include: {
            teamPlayer: {
              include: {
                team: true,
              },
            },
          },
          orderBy: [{ sNo: 'asc' }, { name: 'asc' }],
        }),
      ]);

      auction = dbAuction;
      fetchedTeams = dbTeams;
      fetchedPlayers = dbPlayers;

      if (auction) {
        const [dbActivePlayer, dbHighestBidTeam] = await Promise.all([
          auction.activePlayerId
            ? this.prisma.player.findUnique({
                where: { id: auction.activePlayerId },
                include: {
                  teamPlayer: {
                    include: {
                      team: true,
                    },
                  },
                },
              })
            : Promise.resolve(null),
          auction.highestBidTeamId
            ? this.prisma.team.findUnique({
                where: { id: auction.highestBidTeamId },
              })
            : Promise.resolve(null),
        ]);
        activePlayer = dbActivePlayer;
        highestBidTeam = dbHighestBidTeam;
      }
    } catch (dbErr: any) {
      console.warn('[AuctionEngine Warning - Serving from durable live state]:', dbErr.message);
      auction = getLiveAuction();
      fetchedTeams = getLiveTeams();
      fetchedPlayers = getLivePlayers();
      activePlayer = auction.activePlayerId
        ? fetchedPlayers.find((p: any) => p.id === auction.activePlayerId) || null
        : null;
      highestBidTeam = auction.highestBidTeamId
        ? fetchedTeams.find((t: any) => t.id === auction.highestBidTeamId) || null
        : null;
    }

    if (!auction) {
      auction = getLiveAuction();
      fetchedTeams = getLiveTeams();
      fetchedPlayers = getLivePlayers();
    }
    // Safety guard: Auction cannot be ACTIVE if there is no active player on the block
    if (!auction.activePlayerId && (auction.status === 'ACTIVE' || auction.status === 'PAUSED')) {
      auction.status = 'IDLE';
    }

    if (auction.timerEnabled !== undefined && auction.timerEnabled !== null) {
      this.timerEnabled = Boolean(auction.timerEnabled);
    }
    if (auction.autoSell !== undefined && auction.autoSell !== null) {
      this.autoSell = Boolean(auction.autoSell);
    }
    if (auction.defaultTimerSec) {
      this.defaultTimerSec = Number(auction.defaultTimerSec);
    }

    const formattedTeams = fetchedTeams.map((t: any) => {
      const squad = t.squad || [];
      const overseasCount = squad.filter((sp: any) => sp.player?.isOverseas).length;
      const batters = squad.filter((sp: any) => sp.player?.role === 'Batter').length;
      const bowlers = squad.filter((sp: any) => sp.player?.role === 'Bowler').length;
      const allRounders = squad.filter((sp: any) => sp.player?.role === 'All-Rounder').length;
      const wicketkeepers = squad.filter((sp: any) => sp.player?.role === 'Wicketkeeper').length;
      const spent = squad.reduce((sum: number, sp: any) => sum + (sp.price || 0), 0);
      const safeRemaining = t.remainingPurse > t.totalPurse ? Math.max(0, t.totalPurse - spent) : (t.remainingPurse !== undefined ? t.remainingPurse : t.totalPurse);
      const iconPlayersCount = squad.filter((sp: any) => sp.isIcon || sp.player?.isIcon).length;
      const totalSpent = Math.max(0, t.totalPurse - safeRemaining);

      return {
        ...t,
        remainingPurse: safeRemaining,
        squadSize: squad.length,
        iconPlayersCount,
        overseasCount,
        batters,
        bowlers,
        allRounders,
        wicketkeepers,
        totalSpent,
      };
    });

    this.cachedFormattedTeams = formattedTeams;
    this.cachedPlayers = fetchedPlayers;
    const state = {
      auction: {
        ...auction,
        secondsLeft: this.secondsLeft,
      },
      activePlayer,
      highestBidTeam,
      currentBid: auction.activePlayerPrice || (activePlayer ? activePlayer.basePrice : 0),
      teams: formattedTeams,
      players: fetchedPlayers,
      recentBids: auction.bids,
      minIncrement: auction.activePlayerPrice
        ? getMinBidIncrement(auction.activePlayerPrice)
        : activePlayer
        ? getMinBidIncrement(activePlayer.basePrice)
        : 1000000,
    };

    this.cachedFullAuctionState = state;
    this.cacheTimestamp = Date.now();

    return state;
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

      let targetPlayerId = firstPending?.playerId;
      let targetPrice = firstPending?.player?.basePrice;

      if (!firstPending) {
        const upcomingPlayer = await this.prisma.player.findFirst({
          where: { status: 'UPCOMING' },
          orderBy: [{ sNo: 'asc' }, { name: 'asc' }],
        });
        if (upcomingPlayer) {
          targetPlayerId = upcomingPlayer.id;
          targetPrice = upcomingPlayer.basePrice || 100;
          await this.prisma.auctionPlayer.create({
            data: {
              auctionId: auction.id,
              playerId: upcomingPlayer.id,
              status: 'CURRENT',
              basePrice: targetPrice,
              startedAt: new Date(),
            },
          });
        }
      }

      if (targetPlayerId) {
        auction = await this.prisma.auction.update({
          where: { id: auction.id },
          data: {
            status: 'ACTIVE',
            activePlayerId: targetPlayerId,
            activePlayerPrice: targetPrice || 100,
            highestBidTeamId: null,
            startedAt: auction.startedAt || new Date(),
          },
        });

        await this.prisma.player.update({
          where: { id: targetPlayerId },
          data: { status: 'IN_AUCTION' },
        });

        if (firstPending) {
          await this.prisma.auctionPlayer.update({
            where: { id: firstPending.id },
            data: { status: 'CURRENT', startedAt: new Date() },
          });
        }
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

    this.secondsLeft = auction.defaultTimerSec || 10;
    if (auction.timerEnabled !== false) {
      this.startTimer(this.secondsLeft);
    }

    this.invalidateCache();
    const state = await this.getAuctionState();
    this.broadcast('auction:started', this.getCompactAuctionState(state, false));
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

    this.invalidateCache();
    const state = await this.getAuctionState();
    this.broadcast('auction:paused', this.getCompactAuctionState(state, true));
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

    if (auction && auction.timerEnabled !== false) {
      this.startTimer(this.secondsLeft || auction.defaultTimerSec || 10);
    }
    this.invalidateCache();
    const state = await this.getAuctionState();
    this.broadcast('auction:resumed', this.getCompactAuctionState(state, true));
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
    this.invalidateCache();

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

    // Put this player into auction with base price
    await this.prisma.player.update({
      where: { id: playerId },
      data: { status: 'IN_AUCTION', currentPrice: player.basePrice },
    });

    // Update auction player entry
    let auctionPlayer = await this.prisma.auctionPlayer.findFirst({
      where: { auctionId: auction.id, playerId: playerId },
      orderBy: { createdAt: 'desc' },
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

    // Clear prior bids for this player so bidding starts fresh at base price
    await this.prisma.bid.deleteMany({
      where: { auctionId: auction.id, playerId: playerId },
    });

    // Update auction to IDLE status so teams cannot bid until admin clicks Start
    await this.prisma.auction.update({
      where: { id: auction.id },
      data: {
        status: 'IDLE',
        activePlayerId: playerId,
        activePlayerPrice: player.basePrice || 100,
        highestBidTeamId: null,
      },
    });

    this.secondsLeft = auction.defaultTimerSec || 10;
    // Bidding timer must not start until admin clicks Start
    this.invalidateCache();
    const state = await this.getAuctionState();
    this.broadcast('auction:player', this.getCompactAuctionState(state, false));
    return state;
  }

  /**
   * Start bidding timer on current player
   */
  public async startBidding() {
    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (!auction) {
      throw new Error('No auction found');
    }
    if (!auction.activePlayerId) {
      return this.startAuction();
    }

    await this.prisma.auction.update({
      where: { id: auction.id },
      data: { status: 'ACTIVE' },
    });

    this.secondsLeft = auction.defaultTimerSec || 10;
    this.startTimer(this.secondsLeft);

    const state = await this.getAuctionState();
    this.broadcast('auction:resumed', this.getCompactAuctionState(state, true));
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
        state: this.getCompactAuctionState(state, false),
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
      const [auction, team] = await Promise.all([
        this.prisma.auction.findFirst({
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.team.findUnique({
          where: { id: teamId },
          include: {
            squad: {
              include: { player: true },
            },
          },
        }),
      ]);

      if (!auction) {
        throw new Error('No active auction found.');
      }

      if (auction.status !== 'ACTIVE') {
        throw new Error(`Auction is currently ${auction.status.toLowerCase()}. Bids not accepted.`);
      }

      if (!auction.activePlayerId) {
        throw new Error('No player is currently on the auction block.');
      }

      if (!team) {
        throw new Error('Team not found.');
      }

      const player = await this.prisma.player.findUnique({
        where: { id: auction.activePlayerId },
      });

      if (!player) {
        throw new Error('Active player not found.');
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
      const currentHighest = auction.activePlayerPrice || player.basePrice || 100;
      const minInc = getMinBidIncrement(currentHighest);
      let targetBid: number;

      if (!auction.highestBidTeamId) {
        // First bid can be at base price or custom amount >= 100
        targetBid = customAmount !== undefined && customAmount !== null ? customAmount : Math.max(100, player.basePrice || 100);
        if (targetBid < 100) {
          throw new Error('Bid price must be greater than or equal to ₹100.');
        }
      } else {
        // Subsequent bid
        if (customAmount !== undefined && customAmount !== null) {
          targetBid = customAmount;
          if (targetBid < 100) {
            throw new Error('Bid price must be greater than or equal to ₹100.');
          }
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
      }, { maxWait: 15000, timeout: 30000 });

      // Reset timer to default on every valid bid if timer is enabled
      if (auction.timerEnabled !== false) {
        this.secondsLeft = auction.defaultTimerSec || 10;
        this.startTimer(this.secondsLeft);
      }

      // Fast update in-memory cached state directly (avoiding 4-8 second DB query)
      if (this.cachedFullAuctionState) {
        this.cachedFullAuctionState.auction = {
          ...this.cachedFullAuctionState.auction,
          activePlayerPrice: targetBid,
          highestBidTeamId: team.id,
          secondsLeft: this.secondsLeft,
        };
        this.cachedFullAuctionState.highestBidTeam = team;
        this.cachedFullAuctionState.currentBid = targetBid;
        this.cachedFullAuctionState.minIncrement = getMinBidIncrement(targetBid);
        this.cachedFullAuctionState.recentBids = [
          result.newBid,
          ...(this.cachedFullAuctionState.recentBids || []).filter((b: any) => b.id !== result.newBid.id).slice(0, 19),
        ];
      }

      const state = this.cachedFullAuctionState || (await this.getAuctionState());

      // Broadcast bid event instantly (omit players array: drops payload from 7.7 MB to ~1.5 KB!)
      this.broadcast('auction:bid', {
        bid: result.newBid,
        amount: targetBid,
        teamName: team.name,
        teamShortName: team.shortName,
        teamColor: team.primaryColor,
        playerName: player.name,
        state: this.getCompactAuctionState(state, true),
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
    }, { maxWait: 15000, timeout: 30000 });

    this.invalidateCache();

    const soldData = {
      player,
      winningTeam: team,
      finalPrice: winningPrice,
      formattedPrice: formatRupees(winningPrice),
      isManualSale: Boolean(manualTeamId),
    };

    // Instant emission: Don't wait for full state DB queries so gavel & celebration trigger with 0 delay!
    this.broadcast('auction:sold', {
      ...soldData,
      state: this.getCompactAuctionState(this.cachedFullAuctionState || null, true),
    });

    const state = await this.getAuctionState();
    this.broadcast('auction:sold', {
      ...soldData,
      state: this.getCompactAuctionState(state, false),
    });

    // Automatically transition to next player after 4.5 seconds broadcast pause (if timer is enabled)
    if (auction.timerEnabled !== false) {
      this.autoNextTimeout = setTimeout(async () => {
        try {
          await this.nextPlayer();
        } catch (err) {
          console.error('Error auto-advancing next player:', err);
        }
      }, 4500);
    }

    return { success: true, ...soldData, state };
  }

  /**
   * Admin assigns a player manually to a franchise
   * Deducts amount from team purse, adds player to squad, marks as SOLD
   */
  public async manuallyAssignPlayer(playerId: string, teamId: string, amount: number) {
    this.stopTimer();
    if (this.autoNextTimeout) {
      clearTimeout(this.autoNextTimeout);
      this.autoNextTimeout = null;
    }

    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
    });

    if (!player) {
      throw new Error('Player not found.');
    }

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: {
        squad: true,
      },
    });

    if (!team) {
      throw new Error('Franchise not found.');
    }

    if (isNaN(amount) || amount < 100 || amount > 2500) {
      throw new Error('Assignment price must be between ₹100 and ₹2,500.');
    }

    if (team.remainingPurse < amount) {
      throw new Error(
        `Insufficient purse! ${team.name} has only ${formatRupees(team.remainingPurse)} remaining, but manual assignment requires ${formatRupees(amount)}.`
      );
    }

    if (team.squad.length >= team.maxSquadSize) {
      throw new Error(
        `Squad limit reached! ${team.name} already has ${team.squad.length}/${team.maxSquadSize} players.`
      );
    }

    // Check if player is already assigned
    const existingSquad = await this.prisma.teamPlayer.findFirst({
      where: { playerId },
      include: { team: true },
    });
    if (existingSquad) {
      throw new Error(
        `${player.name} is already in ${existingSquad.team.name}'s squad! Please remove them first.`
      );
    }

    // Perform atomic transaction
    await this.prisma.$transaction(async (tx) => {
      // 1. Deduct purse from franchise
      await tx.team.update({
        where: { id: teamId },
        data: {
          remainingPurse: { decrement: amount },
        },
      });

      // 2. Add to team squad
      await tx.teamPlayer.create({
        data: {
          teamId,
          playerId,
          price: amount,
          isIcon: false,
        },
      });

      // 3. Mark player as SOLD
      await tx.player.update({
        where: { id: playerId },
        data: {
          status: 'SOLD',
          currentPrice: amount,
        },
      });

      // 4. Update auction player if active
      if (auction) {
        // If this player was active in auction, clear active player on auction
        if (auction.activePlayerId === playerId) {
          await tx.auction.update({
            where: { id: auction.id },
            data: {
              activePlayerId: null,
              activePlayerPrice: null,
              highestBidTeamId: null,
            },
          });
        }

        await tx.auctionPlayer.updateMany({
          where: {
            auctionId: auction.id,
            playerId: playerId,
          },
          data: {
            status: 'SOLD',
            finalPrice: amount,
            winningTeamId: teamId,
            soldAt: new Date(),
          },
        });

        // 5. Create auction event
        await tx.auctionEvent.create({
          data: {
            auctionId: auction.id,
            type: 'SOLD',
            message: `MANUAL ASSIGNMENT! ${player.name} assigned to ${team.name} for ${formatRupees(amount)} (-${formatRupees(amount)} from purse).`,
            metadata: JSON.stringify({
              playerId: player.id,
              playerName: player.name,
              teamId: team.id,
              teamName: team.name,
              amount: amount,
              isManual: true,
            }),
          },
        });
      }
    });

    const soldData = {
      player: { ...player, status: 'SOLD', currentPrice: amount },
      winningTeam: { ...team, remainingPurse: team.remainingPurse - amount },
      finalPrice: amount,
      formattedPrice: formatRupees(amount),
      isManual: true,
    };

    const state = await this.getAuctionState();
    this.broadcast('auction:sold', {
      ...soldData,
      state: this.getCompactAuctionState(state, false),
    });

    return {
      success: true,
      message: `${player.name} manually assigned to ${team.name} for ${formatRupees(amount)}!`,
      ...soldData,
      state,
    };
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
    }, { maxWait: 15000, timeout: 30000 });

    this.invalidateCache();

    const unsoldData = {
      player,
      basePrice: player.basePrice,
      formattedBasePrice: formatRupees(player.basePrice),
    };

    // Instant emission: Don't wait for full state DB queries so buzzer & alert trigger with 0 delay!
    this.broadcast('auction:unsold', {
      ...unsoldData,
      state: this.getCompactAuctionState(this.cachedFullAuctionState || null, true),
    });

    const state = await this.getAuctionState();
    this.broadcast('auction:unsold', {
      ...unsoldData,
      state: this.getCompactAuctionState(state, false),
    });

    // Automatically advance after 3.5 seconds (if timer is enabled)
    if (auction.timerEnabled !== false) {
      this.autoNextTimeout = setTimeout(async () => {
        try {
          await this.nextPlayer();
        } catch (err) {
          console.error('Error auto-advancing next player:', err);
        }
      }, 3500);
    }

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

    // Shuffle unsold players so they enter the next bidding round in randomized order
    for (let i = unsoldPlayers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [unsoldPlayers[i], unsoldPlayers[j]] = [unsoldPlayers[j], unsoldPlayers[i]];
    }

    // Reset status to UPCOMING and create new AuctionPlayer entries for next round
    for (let i = 0; i < unsoldPlayers.length; i++) {
      const p = unsoldPlayers[i];
      await this.prisma.player.update({
        where: { id: p.id },
        data: { status: 'UPCOMING', currentPrice: p.basePrice },
      });

      // Clear any prior failed bids for this player
      await this.prisma.bid.deleteMany({
        where: { auctionId: auction.id, playerId: p.id },
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

    const state = await this.nextPlayer();
    this.broadcast('auction:players_updated', this.getCompactAuctionState(state, false));
    return state;
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

      // Re-enqueue all players with Fisher-Yates shuffle so players belonging to all teams and free agents are mixed
      const allPlayers = await this.prisma.player.findMany();
      for (let i = allPlayers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allPlayers[i], allPlayers[j]] = [allPlayers[j], allPlayers[i]];
      }

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
    this.invalidateCache();
    const state = await this.getAuctionState();
    this.broadcast('auction:reset', this.getCompactAuctionState(state, false));
    return state;
  }

  /**
   * Shuffle all pending players in the current auction pool
   * Randomizes the order so players belonging to different teams and free agents
   * are mixed fairly before and during auction draft rounds.
   */
  public async shuffleAuctionPool() {
    const auction = await this.prisma.auction.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (!auction) throw new Error('No auction found');

    const pendingAuctionPlayers = await this.prisma.auctionPlayer.findMany({
      where: {
        auctionId: auction.id,
        status: 'PENDING',
      },
    });

    if (pendingAuctionPlayers.length <= 1) {
      const state = await this.getAuctionState();
      return state;
    }

    // Fisher-Yates shuffle
    const shuffled = [...pendingAuctionPlayers];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Update orderIndex
    for (let idx = 0; idx < shuffled.length; idx++) {
      await this.prisma.auctionPlayer.update({
        where: { id: shuffled[idx].id },
        data: { orderIndex: idx + 1 },
      });
    }

    await this.prisma.auctionEvent.create({
      data: {
        auctionId: auction.id,
        type: 'SHUFFLED',
        message: `Auction pool shuffled! ${shuffled.length} upcoming players randomized.`,
        metadata: JSON.stringify({ count: shuffled.length }),
      },
    });

    this.invalidateCache();
    const state = await this.getAuctionState();
    this.broadcast('auction:players_updated', this.getCompactAuctionState(state, false));
    this.broadcast('auction:shuffled', {
      message: `Auction pool shuffled! ${shuffled.length} upcoming players randomized.`,
      state,
    });
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
      this.defaultTimerSec = Number(settings.defaultTimerSec);
      this.secondsLeft = Number(settings.defaultTimerSec);
    }
    if (settings.timerEnabled !== undefined) {
      this.timerEnabled = Boolean(settings.timerEnabled);
    }
    if (settings.autoSell !== undefined) {
      this.autoSell = Boolean(settings.autoSell);
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
        this.startTimer(this.secondsLeft);
      }
    }

    this.invalidateCache();
    const state = await this.getAuctionState();
    this.broadcast('auction:settings_updated', this.getCompactAuctionState(state, true));
    return state;
  }

  /**
   * Server-controlled bid timer with autoSell toggle and enable/disable
   * Synchronous start with instant 0ms tick broadcast
   */
  public startTimer(overrideSeconds?: number) {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    if (overrideSeconds !== undefined && overrideSeconds > 0) {
      this.secondsLeft = overrideSeconds;
    } else if (this.secondsLeft <= 0) {
      this.secondsLeft = this.defaultTimerSec || 10;
    }

    if (!this.timerEnabled) {
      this.broadcast('auction:timer', {
        secondsLeft: null,
        timerEnabled: false,
        message: 'Manual Auction Mode (Timer Disabled)',
      });
      return;
    }

    // Immediately emit initial tick so clients don't wait 1000ms for first tick
    this.broadcast('auction:timer', {
      secondsLeft: this.secondsLeft,
      timerEnabled: true,
      warning: this.secondsLeft <= 5 && this.secondsLeft > 0,
      urgent: this.secondsLeft <= 3 && this.secondsLeft > 0,
    });

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

        if (this.autoSell) {
          // Check cached state first for sub-millisecond response
          const cached = this.cachedFullAuctionState;
          const activePlayerId = cached?.auction?.activePlayerId;
          const highestBidTeamId = cached?.auction?.highestBidTeamId;

          if (activePlayerId) {
            if (highestBidTeamId) {
              console.log(`[Timer expired - Auto-Sell]: Selling player ${activePlayerId} to ${highestBidTeamId}`);
              await this.sellPlayer();
            } else {
              console.log(`[Timer expired - Auto-Unsold]: No bids placed, player ${activePlayerId} is UNSOLD`);
              await this.markUnsold();
            }
          } else {
            // Check DB fallback
            const currentAuction = await this.prisma.auction.findFirst({
              orderBy: { createdAt: 'desc' },
            });
            if (currentAuction && currentAuction.activePlayerId) {
              if (currentAuction.highestBidTeamId) {
                await this.sellPlayer();
              } else {
                await this.markUnsold();
              }
            }
          }
        } else {
          console.log('[Timer expired - Manual Mode]: Awaiting Admin confirmation to sell player');
          this.broadcast('auction:timer_ended_manual', {
            message: 'Timer reached 0! Awaiting Admin confirmation to Sell or Mark Unsold.',
          });
        }
      }
    }, 1000);
  }

  public stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.autoNextTimeout) {
      clearTimeout(this.autoNextTimeout);
      this.autoNextTimeout = null;
    }
  }
}
