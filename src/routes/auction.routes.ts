import { Router } from 'express';
import {
  getCurrentAuction,
  startAuction,
  pauseAuction,
  resumeAuction,
  selectPlayer,
  startBidding,
  nextPlayer,
  placeBid,
  sellPlayer,
  markUnsold,
  skipPlayer,
  reauctionUnsold,
  resetAuction,
  shuffleAuctionPool,
  getAuctionHistory,
  getAuctionResults,
  updateAuctionSettings,
  clearAllTournamentData,
} from '../controllers/auction.controller';
import { getDashboardStats } from '../controllers/stats.controller';
import { authenticate, authorizeRole } from '../middleware/auth.middleware';

const router = Router();

// Public / Spectator endpoints
router.get('/current', getCurrentAuction);
router.get('/history', getAuctionHistory);
router.get('/results', getAuctionResults);
router.get('/stats', getDashboardStats);

// Bidding endpoint (TEAM users and ADMIN)
router.post('/bid', authenticate, authorizeRole(['ADMIN', 'TEAM']), placeBid);

// Admin Control endpoints
router.post('/start', authenticate, authorizeRole(['ADMIN']), startAuction);
router.post('/pause', authenticate, authorizeRole(['ADMIN']), pauseAuction);
router.post('/resume', authenticate, authorizeRole(['ADMIN']), resumeAuction);
router.post('/select', authenticate, authorizeRole(['ADMIN']), selectPlayer);
router.post('/start-bidding', authenticate, authorizeRole(['ADMIN']), startBidding);
router.post('/next', authenticate, authorizeRole(['ADMIN']), nextPlayer);
router.post('/sell', authenticate, authorizeRole(['ADMIN']), sellPlayer);
router.post('/unsold', authenticate, authorizeRole(['ADMIN']), markUnsold);
router.post('/skip', authenticate, authorizeRole(['ADMIN']), skipPlayer);
router.post('/reauction', authenticate, authorizeRole(['ADMIN']), reauctionUnsold);
router.post('/shuffle', authenticate, authorizeRole(['ADMIN']), shuffleAuctionPool);
router.post('/reset', authenticate, authorizeRole(['ADMIN']), resetAuction);
router.post('/clear-all', authenticate, authorizeRole(['ADMIN']), clearAllTournamentData);
router.post('/settings', authenticate, authorizeRole(['ADMIN']), updateAuctionSettings);

export default router;
