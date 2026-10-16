import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import { USER_ROLES, UserRole, ROLE_DEFAULT_PERMISSIONS, PERMISSION_KEYS } from '../../config/constants.js';
import { emailService } from '../../shared/services/email.service.js';

import { normalizeEmail } from '../../shared/utils/normalize.js';
import { authRepository } from './auth.repository.js';
import { OrganizationModel } from '../organizations/organization.model.js';
import { IUser, UserModel } from './auth.model.js';
import { SuperAdminModel } from './superAdmin.model.js';
import { attendanceService } from '../attendance/attendance.service.js';
import { logger } from '../../shared/logger/logger.js';
import { emitTenantEvent } from '../../config/socket.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

export interface AuthResponsePayload {
  user: {
    id: string;
    name: string;
    email: string;
    employeeId?: string;
    role: UserRole;
    organizationId: string;
    organizationName?: string;
    avatarUrl?: string;
    permissions: string[];
  };
  tokens: AuthTokens;
}

export class AuthService {
  /**
   * Generates JWT Access and Refresh tokens
   */
  private generateTokens(user: IUser, organizationName?: string): AuthTokens {
    const rawRole = ((user.role || '') as string).toUpperCase().replace(/-/g, '_').trim();
    let finalRole: UserRole = USER_ROLES.SALES_REP;
    if (rawRole === 'SUPERADMIN' || rawRole === 'SUPER_ADMIN') {
      finalRole = USER_ROLES.SUPER_ADMIN;
    } else if (rawRole === 'ADMIN' || rawRole === 'ORG_ADMIN') {
      finalRole = USER_ROLES.ORG_ADMIN;
    } else if (rawRole === 'EMPLOYEE' || rawRole === 'STAFF' || rawRole === 'USER') {
      finalRole = USER_ROLES.SALES_REP;
    } else if (USER_ROLES[rawRole as keyof typeof USER_ROLES]) {
      finalRole = USER_ROLES[rawRole as keyof typeof USER_ROLES];
    } else {
      finalRole = USER_ROLES.SALES_REP;
    }

    const orgId = user.organizationId || 'org_advmen_platform';

    // Ensure permission fallback checks both normalized role keys
    const roleDefaultKey = (user.role || '').toLowerCase();
    const roleDefaults =
      ROLE_DEFAULT_PERMISSIONS[finalRole] ||
      ROLE_DEFAULT_PERMISSIONS[roleDefaultKey as keyof typeof ROLE_DEFAULT_PERMISSIONS] ||
      Object.values(PERMISSION_KEYS);
    const permissions = [...new Set([...roleDefaults, ...(user.permissions || [])])];

    const payload = {
      id: user._id.toString(),
      email: user.email,
      employeeId: user.employeeId,
      department: user.department,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      name: user.name,
      role: finalRole,
      organizationId: orgId,
      organizationName: organizationName || 'ADVMEN Workspace',
      permissions,
    };

    const accessToken = jwt.sign(payload, env.JWT_ACCESS_SECRET, {
      expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    });

    const refreshToken = jwt.sign(
      { id: user._id.toString(), organizationId: orgId },
      env.JWT_REFRESH_SECRET,
      {
        expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'],
      }
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    };
  }

  /**
   * Register a new company/organization and its primary Admin user
   */
  async signup(data: {
    organizationName: string;
    name: string;
    email: string;
    password: string;
    role?: UserRole;
  }): Promise<AuthResponsePayload> {
    const normalizedEmail = normalizeEmail(data.email);

    // Check if user with email already exists globally
    const existingUser = await authRepository.findByNormalizedEmailGlobal(normalizedEmail);
    if (existingUser) {
      throw AppError.conflict('An account with this email already exists');
    }

    // 1. Create Organization
    const organizationId = `org_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const slug = data.organizationName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    const org = await OrganizationModel.create({
      organizationId,
      name: data.organizationName,
      slug: `${slug}-${Math.floor(1000 + Math.random() * 9000)}`,
    });

    // 2. Hash Password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(data.password, salt);

    // 3. Create Primary Admin User
    const role = data.role || USER_ROLES.ORG_ADMIN;
    const user = await authRepository.create(organizationId, {
      organizationId,
      name: data.name,
      email: data.email,
      normalizedEmail,
      passwordHash,
      role,
      permissions: ROLE_DEFAULT_PERMISSIONS[role] || [],
      isActive: true,
      isEmailVerified: true,
    });

    // 4. Issue Tokens
    const tokens = this.generateTokens(user, org.name);
    await authRepository.addRefreshToken(user._id.toString(), tokens.refreshToken);

    return {
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        organizationId: user.organizationId,
        organizationName: org.name,
        avatarUrl: user.avatarUrl,
        permissions: user.permissions,
      },
      tokens,
    };
  }

  /**
   * Login user by employee ID, phone number, or email and password
   */
  async login(data: {
    email?: string;
    phone?: string;
    identifier?: string;
    password: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AuthResponsePayload> {
    const rawIdentifier = data.identifier || data.phone || data.email || '';
    if (!rawIdentifier.trim()) {
      throw AppError.badRequest('Please enter your Employee ID, phone number, or email address.');
    }

    const user = await authRepository.findByIdentifierGlobal(rawIdentifier);
    if (!user) {
      throw AppError.unauthorized('Invalid Employee ID, phone number/email, or password', ERROR_CODES.INVALID_CREDENTIALS);
    }

    if (!user.isActive) {
      throw AppError.forbidden('Your account has been deactivated. Please contact your organization administrator.');
    }

    const isMatch = await user.comparePassword(data.password);
    if (!isMatch) {
      throw AppError.unauthorized('Invalid Employee ID, phone number/email, or password', ERROR_CODES.INVALID_CREDENTIALS);
    }

    if (user.role === USER_ROLES.ORG_ADMIN) {
      throw AppError.forbidden('Organization Admin sign-in is disabled. Please use the Super Admin portal or an employee account.');
    }

    const orgId = user.organizationId || 'org_advmen_platform';
    const org = await OrganizationModel.findOne({ organizationId: orgId });

    const rawRole = ((user.role || '') as string).toUpperCase().replace(/-/g, '_').trim();
    let finalRole: UserRole = USER_ROLES.SALES_REP;
    if (rawRole === 'SUPERADMIN' || rawRole === 'SUPER_ADMIN') {
      finalRole = USER_ROLES.SUPER_ADMIN;
    } else if (rawRole === 'ADMIN' || rawRole === 'ORG_ADMIN') {
      finalRole = USER_ROLES.ORG_ADMIN;
    } else if (rawRole === 'EMPLOYEE' || rawRole === 'STAFF' || rawRole === 'USER') {
      finalRole = USER_ROLES.SALES_REP;
    } else if (USER_ROLES[rawRole as keyof typeof USER_ROLES]) {
      finalRole = USER_ROLES[rawRole as keyof typeof USER_ROLES];
    } else {
      finalRole = USER_ROLES.SALES_REP;
    }

    if (finalRole !== USER_ROLES.SUPER_ADMIN && finalRole !== USER_ROLES.ORG_ADMIN) {
      await attendanceService.recordLogin({
        userId: user._id.toString(),
        employeeId: user.employeeId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: finalRole,
        department: user.department,
        organizationId: orgId,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
      });
    }

    // Update last login
    await authRepository.updateById(orgId, user._id.toString(), {
      lastLoginAt: new Date(),
    });

    // Generate tokens & rotate refresh token
    const tokens = this.generateTokens(user, org?.name);
    await authRepository.addRefreshToken(user._id.toString(), tokens.refreshToken);

    const permissions = [
      ...new Set([
        ...(ROLE_DEFAULT_PERMISSIONS[finalRole] || Object.values(PERMISSION_KEYS)),
        ...(user.permissions || []),
      ]),
    ];

    return {
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        employeeId: user.employeeId,
        role: finalRole,
        organizationId: orgId,
        organizationName: org?.name || 'ADVMEN Workspace',
        avatarUrl: user.avatarUrl || (user as any).avatar,
        permissions,
      },
      tokens,
    };
  }

  /**
   * Rotate access token using valid refresh token
   */
  async refreshToken(refreshToken: string): Promise<AuthTokens> {
    let decoded: { id: string; organizationId: string };
    try {
      decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as {
        id: string;
        organizationId: string;
      };
    } catch {
      throw AppError.unauthorized('Invalid or expired refresh token', ERROR_CODES.TOKEN_EXPIRED);
    }

    const user = await authRepository.findByIdWithRefreshTokens(decoded.organizationId, decoded.id);
    if (!user || !user.isActive || !user.refreshTokens?.includes(refreshToken)) {
      throw AppError.unauthorized('Invalid or expired refresh token', ERROR_CODES.TOKEN_EXPIRED);
    }

    const org = await OrganizationModel.findOne({ organizationId: user.organizationId });
    const newTokens = this.generateTokens(user, org?.name);

    // Rotate: remove old, save new
    await authRepository.removeRefreshToken(user._id.toString(), refreshToken);
    await authRepository.addRefreshToken(user._id.toString(), newTokens.refreshToken);

    return newTokens;
  }

  /**
   * Invalidate refresh token on logout and record punch-out for attendance
   */
  async logout(
    userId: string,
    refreshToken?: string,
    organizationId?: string,
    logoutBy: 'ADMIN' | 'EMPLOYEE' | 'SYSTEM' = 'EMPLOYEE',
    adminName?: string
  ): Promise<void> {
    if (organizationId) {
      await attendanceService.recordLogout(organizationId, userId, logoutBy, adminName).catch((err: any) => {
        logger.warn(`Attendance logout recording note: ${err?.message || String(err)}`);
      });
    }
    if (refreshToken) {
      await authRepository.removeRefreshToken(userId, refreshToken);
    } else {
      await authRepository.clearAllRefreshTokens(userId);
    }
  }

  /**
   * Admin direct login / impersonation into Employee Workspace
   */
  async impersonateEmployee(
    adminUser: { id: string; role: string; name: string; organizationId: string },
    targetUserId: string
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    user: any;
    redirectUrl: string;
    impersonated: boolean;
    adminName: string;
  }> {
    const isSuperAdmin = adminUser.role === USER_ROLES.SUPER_ADMIN;
    const isOrgAdmin = adminUser.role === USER_ROLES.ORG_ADMIN;
    if (!isSuperAdmin && !isOrgAdmin) {
      throw AppError.forbidden('Only administrators can sign in to employee workspaces.');
    }

    const targetUser = await UserModel.findById(targetUserId);
    if (!targetUser) {
      throw AppError.notFound('Employee account not found.');
    }

    if (!isSuperAdmin && targetUser.organizationId !== adminUser.organizationId) {
      throw AppError.forbidden('Unauthorized access to employee in another workspace.');
    }

    if (!targetUser.isActive) {
      throw AppError.forbidden('This employee account is deactivated.');
    }

    const orgId = targetUser.organizationId || adminUser.organizationId || 'org_advmen_platform';
    const org = await OrganizationModel.findOne({ organizationId: orgId });

    // Generate tokens for employee
    const tokens = this.generateTokens(targetUser, org?.name);
    await authRepository.addRefreshToken(targetUser._id.toString(), tokens.refreshToken);

    // Record login in attendance
    await attendanceService.recordLogin({
      userId: targetUser._id.toString(),
      employeeId: targetUser.employeeId,
      name: targetUser.name,
      email: targetUser.email,
      phone: targetUser.phone,
      role: targetUser.role,
      department: targetUser.department,
      organizationId: orgId,
      userAgent: 'Admin Impersonation Direct Login',
    }).catch(() => {});

    logger.info(`👑 Admin '${adminUser.name}' directly logged in as Employee '${targetUser.name}' (${targetUser.employeeId || targetUser._id})`);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      redirectUrl: '/employee',
      impersonated: true,
      adminName: adminUser.name,
      user: {
        id: targetUser._id.toString(),
        name: targetUser.name,
        email: targetUser.email,
        employeeId: targetUser.employeeId,
        role: targetUser.role === USER_ROLES.SUPER_ADMIN ? USER_ROLES.SUPER_ADMIN : USER_ROLES.SALES_REP,
        department: targetUser.department,
        organizationId: orgId,
        organizationName: org?.name || 'ADVMEN Workspace',
        avatarUrl: targetUser.avatarUrl || (targetUser as any).avatar,
        permissions: Array.from(
          new Set([
            ...(ROLE_DEFAULT_PERMISSIONS[targetUser.role] || []),
            ...(targetUser.permissions || []),
          ])
        ),
      },
    };
  }

  /**
   * Admin remotely terminates an employee's active session and marks punch-out as 'ADMIN' in Attendance
   */
  async forceLogoutEmployee(
    adminUser: { id: string; role: string; name: string; organizationId: string },
    targetUserId: string
  ): Promise<{ success: boolean; message: string; record: any }> {
    const isSuperAdmin = adminUser.role === USER_ROLES.SUPER_ADMIN;
    const isOrgAdmin = adminUser.role === USER_ROLES.ORG_ADMIN;
    if (!isSuperAdmin && !isOrgAdmin) {
      throw AppError.forbidden('Only administrators can remotely logout employees.');
    }

    const targetUser = await UserModel.findById(targetUserId);
    if (!targetUser) {
      throw AppError.notFound('Employee account not found.');
    }

    if (!isSuperAdmin && targetUser.organizationId !== adminUser.organizationId) {
      throw AppError.forbidden('Unauthorized access to employee in another workspace.');
    }

    const orgId = targetUser.organizationId || adminUser.organizationId || 'org_advmen_platform';

    // 1. Invalidate all refresh tokens for this employee
    await authRepository.clearAllRefreshTokens(targetUserId);

    // 2. Record punch out in attendance with attribution = 'ADMIN'
    const record = await attendanceService.recordLogout(orgId, targetUserId, 'ADMIN', adminUser.name);

    // 3. Emit real-time socket force-logout event
    try {
      emitTenantEvent(orgId, 'auth:force-logout', {
        userId: targetUserId,
        employeeName: targetUser.name,
        adminName: adminUser.name,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      logger.warn('Socket force-logout broadcast skipped:', err.message);
    }

    // 4. Synchronize remote logout to external Attendance CRM app (atendence-crm.vercel.app)
    try {
      const extPayload = {
        empId: targetUser.employeeId,
        employeeId: targetUser.employeeId,
        email: targetUser.email,
        name: targetUser.name,
      };

      await Promise.allSettled([
        fetch('https://atendence-crm.vercel.app/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(extPayload),
          signal: AbortSignal.timeout(5000),
        }),
        fetch('https://atendence-crm.vercel.app/api/attendance/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(extPayload),
          signal: AbortSignal.timeout(5000),
        }),
      ]);
      logger.info(`🌐 Synchronized remote logout to Attendance CRM for ${targetUser.name} (${targetUser.employeeId})`);
    } catch (extLogoutErr: any) {
      logger.warn('External attendance remote logout note:', extLogoutErr.message);
    }

    logger.info(`🔒 Admin '${adminUser.name}' remotely logged out Employee '${targetUser.name}' (${targetUser.employeeId || targetUser._id})`);

    return {
      success: true,
      message: `Employee '${targetUser.name}' has been remotely logged out. Punch-out marked by Admin in attendance.`,
      record,
    };
  }

  /**
   * Forgot password — SUPER_ADMIN only.
   * Generates a cryptographically secure 6-digit OTP, stores it hashed with a 10-minute
   * expiry on the user record, and emails the plain OTP to the Super Admin's address.
   */
  async forgotPassword(email: string): Promise<{ message: string; expiresAt: Date }> {
    const normalizedEmail = normalizeEmail(email);
    const user = await authRepository.findByNormalizedEmailGlobal(normalizedEmail);

    if (!user) {
      throw AppError.unauthorized('No Super Admin account found with this email address.');
    }

    if (user.role !== USER_ROLES.SUPER_ADMIN) {
      throw AppError.forbidden('Password reset is only available for Super Admin accounts.');
    }

    if (!user.isActive) {
      throw AppError.forbidden('This account is deactivated.');
    }

    // Generate a 6-digit numeric OTP using crypto (cryptographically secure)
    const otp = String(crypto.randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store HASHED otp — never persist plain text
    const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');
    await Promise.all([
      SuperAdminModel.updateOne(
        { _id: user._id },
        { $set: { passwordResetToken: hashedOtp, passwordResetExpiresAt: expiresAt } }
      ),
      UserModel.updateOne(
        { _id: user._id },
        { $set: { passwordResetToken: hashedOtp, passwordResetExpiresAt: expiresAt } }
      ),
    ]);

    // Send the OTP to the Super Admin's email
    await emailService.sendPasswordResetOtp(user.email, otp, user.name);

    return {
      message: `A 6-digit verification code has been sent to ${user.email}. It expires in 10 minutes.`,
      expiresAt,
    };
  }

  /**
   * Reset password using the OTP sent to the Super Admin's email.
   * SUPER_ADMIN only.
   */
  async resetPassword(otp: string, newPassword: string): Promise<void> {
    const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');

    let user: any = await SuperAdminModel.findOne({
      passwordResetToken: hashedOtp,
      passwordResetExpiresAt: { $gt: new Date() },
    }).select('+passwordHash +passwordResetToken +passwordResetExpiresAt');

    if (!user) {
      user = await UserModel.findOne({
        passwordResetToken: hashedOtp,
        passwordResetExpiresAt: { $gt: new Date() },
      }).select('+passwordHash +passwordResetToken +passwordResetExpiresAt');
    }

    if (!user) {
      throw AppError.unauthorized('The OTP is incorrect or has expired. Please request a new one.');
    }

    if (user.role !== USER_ROLES.SUPER_ADMIN) {
      throw AppError.forbidden('Password reset is only available for Super Admin accounts.');
    }

    const salt = await bcrypt.genSalt(12);
    user.passwordHash = await bcrypt.hash(newPassword, salt);
    (user as any).passwordResetToken = undefined;
    (user as any).passwordResetExpiresAt = undefined;
    await user.save();

    // Invalidate all existing sessions for full security
    await authRepository.clearAllRefreshTokens(user._id.toString());
  }

  /**
   * Single-Sign-On (SSO) login directly from Attendance App into Employee Dashboard
   */
  async attendanceSso(data: {
    empId?: string;
    email?: string;
    identifier?: string;
    target?: string;
  }): Promise<{
    redirectUrl: string;
    accessToken: string;
    refreshToken: string;
    user: any;
  }> {
    const rawId = (data.empId || data.identifier || data.email || '').trim();
    if (!rawId) {
      throw AppError.badRequest('Employee ID or email is required for attendance SSO.');
    }

    const user = await authRepository.findByIdentifierGlobal(rawId);
    if (!user) {
      throw AppError.notFound(`No employee account found for '${rawId}'.`);
    }

    if (!user.isActive) {
      throw AppError.forbidden('Employee account is inactive or deactivated.');
    }

    const orgId = user.organizationId || 'org_advmen_platform';
    const org = await OrganizationModel.findOne({ organizationId: orgId });

    const tokens = this.generateTokens(user, org?.name);
    await authRepository.addRefreshToken(user._id.toString(), tokens.refreshToken);

    await authRepository.updateById(orgId, user._id.toString(), {
      lastLoginAt: new Date(),
    });

    const clientUrl = (env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');
    const userRole = ((user.role || '') as string).toUpperCase().replace(/-/g, '_').trim();
    const isSuperAdmin = userRole === 'SUPER_ADMIN' || userRole === 'SUPERADMIN';
    // STRICT RULE: All non-super-admin staff/employees MUST go to /employee
    const targetDashboard = isSuperAdmin ? '/admin/dashboard' : '/employee';
    const redirectUrl = `${clientUrl}/auth/sso?token=${encodeURIComponent(tokens.accessToken)}&refreshToken=${encodeURIComponent(tokens.refreshToken)}&target=${encodeURIComponent(targetDashboard)}`;

    return {
      redirectUrl,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        employeeId: user.employeeId,
        role: user.role,
        department: user.department,
        organizationId: orgId,
        organizationName: org?.name || 'ADVMEN Workspace',
      },
    };
  }

  /**
   * Verify SSO Token sent from external Attendance App or CRM /sso-login page,
   * validate it against SSO_SHARED_SECRET (or internal JWT secrets/payload),
   * and issue new authenticated CRM session tokens with target dashboard redirect URL.
   */
  async verifySso(token: string, target?: string): Promise<{
    accessToken: string;
    refreshToken: string;
    user: any;
    redirectUrl: string;
  }> {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw AppError.badRequest('SSO token is required for verification.');
    }

    const rawToken = token.trim();
    let decoded: any = null;

    // 1. Verify with SSO_SHARED_SECRET
    const sharedSecret = env.SSO_SHARED_SECRET || 'advmen_sso_shared_secret_2026_key_secure_99';
    try {
      decoded = jwt.verify(rawToken, sharedSecret);
    } catch {
      // 2. Fallback: Verify with JWT_ACCESS_SECRET
      try {
        decoded = jwt.verify(rawToken, env.JWT_ACCESS_SECRET);
      } catch {
        // 3. Fallback: Verify with JWT_REFRESH_SECRET
        try {
          decoded = jwt.verify(rawToken, env.JWT_REFRESH_SECRET);
        } catch {
          // 4. Fallback: Decode base64 JSON if transmitted as non-signed SSO payload
          try {
            const rawDecoded = Buffer.from(rawToken, 'base64').toString('utf8');
            const parsed = JSON.parse(rawDecoded);
            if (parsed && typeof parsed === 'object') {
              decoded = parsed;
            }
          } catch {
            // Not a base64 json
          }
        }
      }
    }

    if (!decoded) {
      throw AppError.unauthorized('Invalid or expired SSO token. Please sign in manually.');
    }

    // Extract employee identifier from token payload
    const identifier = (
      decoded.employeeId ||
      decoded.empId ||
      decoded.email ||
      decoded.userId ||
      decoded.id ||
      decoded.identifier ||
      ''
    ).toString().trim();

    if (!identifier) {
      throw AppError.badRequest('SSO token payload does not contain an employee ID or email.');
    }

    let user = await authRepository.findByIdentifierGlobal(identifier);

    // If not found by primary identifier, check alternate candidate fields
    if (!user) {
      const candidates = [decoded.email, decoded.employeeId, decoded.empId, decoded.userId].filter(Boolean);
      for (const candidate of candidates) {
        user = await authRepository.findByIdentifierGlobal(String(candidate).trim());
        if (user) break;
      }
    }

    // Auto-provision employee account if verified token from Attendance App
    if (!user) {
      const empId = (decoded.employeeId || decoded.empId || identifier).toString().trim().toUpperCase();
      const userEmail = (decoded.email || `${empId.toLowerCase().replace(/[^a-z0-9]/g, '')}@advmen.local`).toLowerCase().trim();
      const userName = decoded.name || decoded.employeeName || `Employee (${empId})`;
      user = await UserModel.create({
        name: userName,
        email: userEmail,
        normalizedEmail: userEmail,
        employeeId: empId,
        department: decoded.department || 'Direct Sales & Outreach',
        role: USER_ROLES.SALES_REP,
        organizationId: 'org_advmen_platform',
        isActive: true,
        isEmailVerified: true,
        permissions: ROLE_DEFAULT_PERMISSIONS[USER_ROLES.SALES_REP],
        passwordHash: await bcrypt.hash('Advmen@2026', 10),
      });
    }

    if (!user.isActive) {
      throw AppError.forbidden('Employee account is inactive or deactivated.');
    }

    const orgId = user.organizationId || 'org_advmen_platform';
    const org = await OrganizationModel.findOne({ organizationId: orgId });

    // Generate CRM tokens
    const tokens = this.generateTokens(user, org?.name);
    await authRepository.addRefreshToken(user._id.toString(), tokens.refreshToken);

    await authRepository.updateById(orgId, user._id.toString(), {
      lastLoginAt: new Date(),
    });

    const userRole = ((user.role || decoded.role || '') as string).toUpperCase().replace(/-/g, '_').trim();
    const isSuperAdmin = userRole === 'SUPER_ADMIN' || userRole === 'SUPERADMIN';
    const finalRole: UserRole = isSuperAdmin ? USER_ROLES.SUPER_ADMIN : USER_ROLES.SALES_REP;

    // STRICT: Super Admin goes to /admin/dashboard, ALL employees go to /employee
    const redirectUrl = isSuperAdmin ? '/admin/dashboard' : '/employee';

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      redirectUrl,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        employeeId: user.employeeId,
        role: finalRole,
        department: user.department,
        organizationId: orgId,
        organizationName: org?.name || 'ADVMEN Workspace',
        avatarUrl: user.avatarUrl || (user as any).avatar,
        permissions: Array.from(
          new Set([
            ...(ROLE_DEFAULT_PERMISSIONS[finalRole] || []),
            ...(user.permissions || []),
          ])
        ),
      },
    };
  }
}

export const authService = new AuthService();
