import { Router } from 'express';
import {
  getTeams,
  getTeamById,
  createTeam,
  updateTeam,
  deleteTeam,
  deleteAllTeams,
  assignIconPlayer,
  removeIconPlayer,
  getFranchiseCredentials,
  updateFranchiseCredentials,
} from '../controllers/team.controller';
import { authenticate, authorizeRole } from '../middleware/auth.middleware';

const router = Router();

router.get('/', getTeams);

// Credentials endpoints (Admin only) - placed before /:id to avoid route collision
router.get('/admin/credentials', authenticate, authorizeRole(['ADMIN']), getFranchiseCredentials);
router.put('/:id/credentials', authenticate, authorizeRole(['ADMIN']), updateFranchiseCredentials);

router.get('/:id', getTeamById);

// Admin operations
router.post('/', authenticate, authorizeRole(['ADMIN']), createTeam);
router.delete('/all', authenticate, authorizeRole(['ADMIN']), deleteAllTeams);
router.put('/:id', authenticate, authorizeRole(['ADMIN', 'TEAM']), updateTeam);
router.delete('/:id', authenticate, authorizeRole(['ADMIN']), deleteTeam);

// Icon Player assignment (Admin only)
router.post('/:id/assign-icon', authenticate, authorizeRole(['ADMIN']), assignIconPlayer);
router.post('/:id/remove-icon', authenticate, authorizeRole(['ADMIN']), removeIconPlayer);

export default router;
