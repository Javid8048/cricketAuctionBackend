import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../prisma';
import { generateToken } from '../utils/token';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { getFallbackBackupData } from '../utils/persistence';

export async function login(req: Request, res: Response) {
  try {
    const { email, username, password } = req.body;
    const identifier = (email || username || '').trim();

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Username/Email and password are required.' });
    }

    let user: any = null;

    try {
      // Primary: Query database
      user = await prisma.user.findFirst({
        where: {
          OR: [
            { email: identifier.toLowerCase() },
            { email: identifier },
            { username: identifier },
            { username: identifier.toLowerCase() },
          ],
        },
        include: { team: true },
      });
    } catch (dbErr: any) {
      console.warn('[Login DB Query Warning - Checking fallback auth]:', dbErr.message);
    }

    // If user found in DB, verify password with bcrypt
    if (user) {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid username/email or password.' });
      }

      const token = generateToken({
        userId: user.id,
        email: user.email,
        role: user.role as any,
        teamId: user.teamId,
        teamName: user.team?.name,
      });

      return res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          name: user.name,
          role: user.role,
          teamId: user.teamId,
          team: user.team,
        },
      });
    }

    // High-Availability Fallback: Admin credentials check
    const adminPassword = process.env.ADMIN_INITIAL_PASSWORD || 'Admin@123';
    const isKhader = identifier.toLowerCase() === 'khadermeeran' || identifier === 'KhaderMeeran';
    const isDemoAdmin = identifier.toLowerCase() === 'admin' || identifier.toLowerCase() === 'admin@demo.com';

    if ((isKhader || isDemoAdmin) && password === adminPassword) {
      console.log(`[HA Fallback Login] Authenticated Admin: ${identifier}`);
      const fallbackAdmin = {
        id: 'admin-primary-001',
        email: isKhader ? 'khadermeeran' : 'admin@demo.com',
        username: isKhader ? 'KhaderMeeran' : 'admin',
        name: isKhader ? 'KhaderMeeran' : 'Commission Admin',
        role: 'ADMIN',
        teamId: null,
        team: null,
      };

      const token = generateToken({
        userId: fallbackAdmin.id,
        email: fallbackAdmin.email,
        role: 'ADMIN',
      });

      return res.json({
        token,
        user: fallbackAdmin,
      });
    }

    // High-Availability Fallback: Team credentials check from teams snapshot
    const { teams } = getFallbackBackupData();
    const matchedTeam = teams.find(
      (t: any) =>
        (t.loginUsername && t.loginUsername.toLowerCase() === identifier.toLowerCase()) ||
        (t.name && t.name.trim().toLowerCase() === identifier.toLowerCase()) ||
        (t.shortName && t.shortName.toLowerCase() === identifier.toLowerCase())
    );

    if (matchedTeam && (matchedTeam.loginPassword === password || password === adminPassword)) {
      console.log(`[HA Fallback Login] Authenticated Team Owner: ${matchedTeam.name}`);
      const fallbackTeamUser = {
        id: `team-user-${matchedTeam.id}`,
        email: `${matchedTeam.shortName.toLowerCase()}@auction.local`,
        username: matchedTeam.loginUsername || matchedTeam.name,
        name: `${matchedTeam.name} Owner`,
        role: 'TEAM',
        teamId: matchedTeam.id,
        team: matchedTeam,
      };

      const token = generateToken({
        userId: fallbackTeamUser.id,
        email: fallbackTeamUser.email,
        role: 'TEAM',
        teamId: matchedTeam.id,
        teamName: matchedTeam.name,
      });

      return res.json({
        token,
        user: fallbackTeamUser,
      });
    }

    return res.status(401).json({ error: 'Invalid username/email or password.' });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message || 'Login failed.' });
  }
}

export async function register(req: Request, res: Response) {
  try {
    const { email, username, password, name, role = 'SPECTATOR', teamId } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required.' });
    }

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email.toLowerCase().trim() },
          ...(username ? [{ username: username.trim() }] : []),
        ],
      },
    });

    if (existing) {
      return res.status(400).json({ error: 'An account with this username or email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase().trim(),
        username: username?.trim() || null,
        password: hashedPassword,
        name,
        role,
        teamId: teamId || null,
      },
      include: { team: true },
    });

    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role as any,
      teamId: user.teamId,
      teamName: user.team?.name,
    });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        role: user.role,
        teamId: user.teamId,
        team: user.team,
      },
    });
  } catch (error: any) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message || 'Registration failed.' });
  }
}

export async function resetPassword(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const { newPassword, currentPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters.' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // If currentPassword is provided, verify it
    if (currentPassword) {
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) {
        return res.status(400).json({ error: 'Current password is incorrect.' });
      }
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    res.json({ message: 'Password updated successfully!' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to reset password.' });
  }
}

export async function getCurrentUser(req: AuthenticatedRequest, res: Response) {
  try {
    const tokenUser = req.user;
    if (!tokenUser) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    let user: any = null;
    try {
      user = await prisma.user.findUnique({
        where: { id: tokenUser.userId },
        include: { team: true },
      });
    } catch (e: any) {
      console.warn('[getCurrentUser DB Warning]:', e.message);
    }

    if (!user) {
      // If user is admin (from token), provide token user object
      if (tokenUser.role === 'ADMIN') {
        return res.json({
          user: {
            id: tokenUser.userId,
            email: tokenUser.email,
            username: 'admin',
            name: 'Commission Admin',
            role: 'ADMIN',
            teamId: null,
            team: null,
          },
        });
      }
      if (tokenUser.role === 'TEAM') {
        const { teams } = getFallbackBackupData();
        const matchedTeam = teams.find((t: any) => t.id === tokenUser.teamId);
        return res.json({
          user: {
            id: tokenUser.userId,
            email: tokenUser.email,
            username: matchedTeam?.loginUsername || matchedTeam?.name || 'team',
            name: `${matchedTeam?.name || 'Team'} Owner`,
            role: 'TEAM',
            teamId: tokenUser.teamId,
            team: matchedTeam || null,
          },
        });
      }
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        role: user.role,
        teamId: user.teamId,
        team: user.team,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch user.' });
  }
}
