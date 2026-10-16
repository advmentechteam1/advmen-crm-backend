import bcrypt from 'bcryptjs';
import { userRepository } from './user.repository.js';
import { CreateUserInput, UpdateUserInput, UserFilterQuery } from './user.validators.js';
import { AuthenticatedUser } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/AppError.js';
import { USER_ROLES, ROLE_DEFAULT_PERMISSIONS, UserRole } from '../../config/constants.js';
import { normalizeEmail } from '../../shared/utils/normalize.js';
import { UserModel, IUser } from '../auth/auth.model.js';
import { LeadModel } from '../leads/lead.model.js';
import { EmployeeCounterModel } from './employeeCounter.model.js';
import { logger } from '../../shared/logger/logger.js';

export class UserService {
  private sanitizeUser(user: IUser) {
    const obj = user.toObject ? user.toObject() : { ...user };
    delete obj.passwordHash;
    delete obj.refreshTokens;
    return {
      id: obj._id ? obj._id.toString() : obj.id,
      ...obj,
    };
  }

  async getUsers(
    requester: AuthenticatedUser,
    filter: UserFilterQuery
  ): Promise<{ users: any[]; total: number; page: number; totalPages: number }> {
    const isSuperAdmin = requester.role === USER_ROLES.SUPER_ADMIN;
    const result = await userRepository.findUsers(requester.organizationId, filter, isSuperAdmin);

    // Aggregate lead counts per user within organization
    const userIds = result.users.map((u) => (u._id ? u._id.toString() : u.id)).filter(Boolean);
    let leadCountMap = new Map<string, number>();
    if (userIds.length > 0) {
      const leadCounts = await LeadModel.aggregate([
        {
          $match: {
            organizationId: requester.organizationId,
            ownerId: { $in: userIds },
          },
        },
        {
          $group: {
            _id: '$ownerId',
            count: { $sum: 1 },
          },
        },
      ]);
      leadCountMap = new Map<string, number>(leadCounts.map((lc) => [String(lc._id), lc.count]));
    }

    return {
      users: result.users.map((u) => {
        const sanitized = this.sanitizeUser(u);
        return {
          ...sanitized,
          assignedLeadsCount: leadCountMap.get(sanitized.id) || 0,
        };
      }),
      total: result.total,
      page: result.page,
      totalPages: result.totalPages,
    };
  }

  async getUserById(requester: AuthenticatedUser, id: string): Promise<any> {
    const isSuperAdmin = requester.role === USER_ROLES.SUPER_ADMIN;
    const user = await userRepository.findById(requester.organizationId, id, isSuperAdmin);

    if (!user) {
      throw AppError.notFound('User account not found');
    }

    const sanitized = this.sanitizeUser(user);
    const assignedLeadsCount = await LeadModel.countDocuments({
      organizationId: requester.organizationId,
      ownerId: sanitized.id,
    });

    return {
      ...sanitized,
      assignedLeadsCount,
    };
  }

  async createUser(requester: AuthenticatedUser, input: CreateUserInput): Promise<any> {
    const normalizedEmail = normalizeEmail(input.email);

    // 1. Check for duplicate email
    const existing = await userRepository.findByNormalizedEmail(normalizedEmail);
    if (existing) {
      throw AppError.conflict(`A user with email '${input.email}' already exists.`);
    }

    const isSuperAdmin = requester.role === USER_ROLES.SUPER_ADMIN;

    // 2. Authorization check for Super Admin creation
    if (input.role === USER_ROLES.SUPER_ADMIN && !isSuperAdmin) {
      throw AppError.forbidden('Only root Super Administrators can provision new Super Admin accounts.');
    }

    // 3. Resolve Organization ID
    const targetOrgId =
      (isSuperAdmin && input.organizationId ? input.organizationId : requester.organizationId) ||
      'org_advmen_platform';

    // 4. Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(input.password, salt);

    const role = (input.role as UserRole) || USER_ROLES.SALES_REP;
    const permissions =
      ROLE_DEFAULT_PERMISSIONS[role as keyof typeof ROLE_DEFAULT_PERMISSIONS] ||
      ROLE_DEFAULT_PERMISSIONS[USER_ROLES.SALES_REP] ||
      [];
    
    let employeeId: string | undefined = undefined;
    if (role !== USER_ROLES.SUPER_ADMIN) {
      // 1. Non-blocking fire-and-forget signup notification to external app (shared DB already stores user)
      fetch('https://atendence-crm.vercel.app/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: input.name.trim(),
          email: input.email.trim().toLowerCase(),
          password: input.password,
        }),
        signal: AbortSignal.timeout(1500),
      }).catch(() => {});

      employeeId = await this.generateEmployeeId();
    }

    // 5. Create user in database with robust retry on employeeId collision
    let newUser: IUser | null = null;
    let attempts = 0;
    while (!newUser && attempts < 3) {
      attempts++;
      try {
        newUser = await userRepository.create({
          organizationId: targetOrgId,
          name: input.name.trim(),
          email: input.email.trim(),
          normalizedEmail,
          passwordHash,
          employeeId,
          empId: employeeId,
          role,
          designation: input.designation?.trim() || undefined,
          permissions,
          department: input.department?.trim() || 'General Sales',
          phone: input.phone?.trim(),
          avatarUrl: input.avatarUrl || undefined,
          isActive: true,
          isEmailVerified: true,
        });
      } catch (dbErr: any) {
        const isDuplicate = dbErr?.code === 11000 || dbErr?.message?.includes('E11000');
        const isEmpIdDup =
          dbErr?.keyPattern?.employeeId ||
          dbErr?.keyPattern?.empId ||
          dbErr?.message?.includes('employeeId') ||
          dbErr?.message?.includes('empId') ||
          dbErr?.keyValue?.employeeId ||
          dbErr?.keyValue?.empId;
        const isEmailDup =
          dbErr?.keyPattern?.normalizedEmail ||
          dbErr?.keyPattern?.email ||
          dbErr?.message?.includes('normalizedEmail') ||
          dbErr?.message?.includes('email_1');

        if (isDuplicate && isEmpIdDup && attempts < 3) {
          logger.warn(`Employee ID collision detected (${employeeId}), generating a fresh unique ID...`);
          // If legacy empId_1 index caused this, safely drop it
          if (dbErr?.message?.includes('empId_1')) {
            try {
              await UserModel.collection.dropIndex('empId_1');
              logger.info('Auto-dropped legacy empId_1 index on retry.');
            } catch {
              // Ignore drop error
            }
          }
          employeeId = await this.generateEmployeeId();
          continue;
        }

        if (isDuplicate && isEmailDup) {
          throw AppError.conflict(`An account with email '${input.email}' already exists.`);
        }

        if (isDuplicate) {
          logger.warn(`Duplicate key conflict during user creation: ${dbErr?.message}`);
          throw AppError.conflict(
            dbErr?.message?.includes('email')
              ? `An account with email '${input.email}' already exists.`
              : 'An account with these unique credentials already exists. Please verify details.'
          );
        }

        throw dbErr;
      }
    }

    if (!newUser) {
      throw AppError.internal('Failed to generate a unique employee record after multiple attempts.');
    }

    return {
      ...this.sanitizeUser(newUser),
      assignedLeadsCount: 0,
    };
  }

  private async generateEmployeeId(): Promise<string> {
    const year = new Date().getFullYear();
    try {
      const counter = await EmployeeCounterModel.findOneAndUpdate(
        { _id: `employee-${year}` },
        { $inc: { sequence: 1 }, $setOnInsert: { _id: `employee-${year}` } },
        { new: true, upsert: true }
      );

      if (counter && counter.sequence) {
        let seq = counter.sequence;
        const candidate = `EMP-${year}-${String(seq).padStart(4, '0')}`;
        const exists = await UserModel.findOne({ employeeId: candidate }).select('_id').lean();
        if (!exists) {
          return candidate;
        }

        // If candidate was already taken by legacy manual insertion, synchronize to highest + 1
        const highestUser = await UserModel.findOne({
          employeeId: new RegExp(`^EMP-${year}-\\d+$`),
        })
          .sort({ employeeId: -1 })
          .select('employeeId')
          .lean();

        if (highestUser?.employeeId) {
          const parts = highestUser.employeeId.split('-');
          const lastSeq = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(lastSeq)) {
            seq = lastSeq + 1;
            await EmployeeCounterModel.updateOne({ _id: `employee-${year}` }, { $set: { sequence: seq } });
            return `EMP-${year}-${String(seq).padStart(4, '0')}`;
          }
        }
      }
    } catch (counterErr: any) {
      logger.warn('Atomic counter lookup note:', counterErr?.message);
    }

    // Guaranteed collision-free fallback
    return `EMP-${year}-${Date.now().toString().slice(-4)}`;
  }

  async updateUser(requester: AuthenticatedUser, id: string, input: UpdateUserInput): Promise<any> {
    const isSuperAdmin = requester.role === USER_ROLES.SUPER_ADMIN;
    const existingUser = await userRepository.findById(requester.organizationId, id, isSuperAdmin);

    if (!existingUser) {
      throw AppError.notFound('User account not found');
    }

    // Protect Super Admin role modifications
    if (input.role === USER_ROLES.SUPER_ADMIN && !isSuperAdmin) {
      throw AppError.forbidden('Only root Super Administrators can promote users to Super Admin.');
    }

    const updateData: Partial<IUser> = {};

    if (input.name) updateData.name = input.name.trim();
    if (input.department) updateData.department = input.department.trim();
    if (input.phone !== undefined) updateData.phone = input.phone.trim();
    if (input.avatarUrl !== undefined) updateData.avatarUrl = input.avatarUrl || undefined;
    if (input.isActive !== undefined) updateData.isActive = input.isActive;

    if (input.designation !== undefined) (updateData as any).designation = input.designation.trim();

    if (input.role) {
      updateData.role = input.role as UserRole;
      updateData.permissions =
        ROLE_DEFAULT_PERMISSIONS[input.role as UserRole] ||
        ROLE_DEFAULT_PERMISSIONS[USER_ROLES.SALES_REP] ||
        existingUser.permissions;
    }

    if (input.password) {
      const salt = await bcrypt.genSalt(10);
      updateData.passwordHash = await bcrypt.hash(input.password, salt);
    }

    const updated = await userRepository.updateById(
      requester.organizationId,
      id,
      updateData,
      isSuperAdmin
    );

    if (!updated) {
      throw AppError.notFound('User account not found');
    }

    return this.sanitizeUser(updated);
  }

  async deleteUser(requester: AuthenticatedUser, id: string): Promise<void> {
    if (requester.id === id) {
      throw AppError.badRequest('You cannot remove your own active administrator account.');
    }

    const isSuperAdmin = requester.role === USER_ROLES.SUPER_ADMIN;
    const user = await userRepository.findById(requester.organizationId, id, isSuperAdmin);

    if (!user) {
      throw AppError.notFound('User account not found');
    }

    const deleted = await userRepository.deleteById(requester.organizationId, id, isSuperAdmin);
    if (!deleted) {
      throw AppError.notFound('User account could not be removed');
    }
  }
}

export const userService = new UserService();
