import { BaseTenantRepository } from '../../shared/repository/BaseTenantRepository.js';
import { IUser, UserModel } from './auth.model.js';
import { SuperAdminModel } from './superAdmin.model.js';

export class AuthRepository extends BaseTenantRepository<IUser> {
  constructor() {
    super(UserModel);
  }

  /**
   * Find user by employee ID, email, or phone across tenants for login
   * Checks dedicated 'superadmins' collection first, then 'users' collection.
   */
  async findByIdentifierGlobal(identifier: string): Promise<IUser | null> {
    const raw = identifier.trim();
    const normalized = raw.toLowerCase();
    const digitsOnly = raw.replace(/\D/g, '');

    const escapedRaw = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const alphanumeric = raw.replace(/[^a-zA-Z0-9]/g, '');

    // 1. Check dedicated 'superadmins' collection
    const superAdmin = await SuperAdminModel
      .findOne({
        $or: [
          { normalizedEmail: normalized },
          { email: raw },
          { email: { $regex: new RegExp(`^${escapedRaw}$`, 'i') } },
          ...(digitsOnly.length >= 7 ? [{ phone: digitsOnly }] : []),
        ],
      })
      .select('+passwordHash +password +refreshTokens')
      .exec();

    if (superAdmin) {
      return superAdmin as unknown as IUser;
    }

    // 2. Check regular 'users' collection (all employees & staff)
    const queryConditions: any[] = [
      { normalizedEmail: normalized },
      { email: raw },
      { email: { $regex: new RegExp(`^${escapedRaw}$`, 'i') } },
      { phone: raw },
      { employeeId: raw.toUpperCase() },
      { employeeId: { $regex: new RegExp(`^${escapedRaw}$`, 'i') } },
    ];

    if (alphanumeric.length >= 2) {
      queryConditions.push({ employeeId: { $regex: new RegExp(alphanumeric, 'i') } });
    }

    if (digitsOnly.length >= 7) {
      queryConditions.push({ phone: digitsOnly });
      queryConditions.push({ phone: new RegExp(digitsOnly + '$') });
    }

    const selectCredentials = '+passwordHash +password +refreshTokens';
    const user = await this.model
      .findOne({ $or: queryConditions })
      .select(selectCredentials)
      .exec();

    if (user || !/^[a-f\d]{6}$/i.test(raw)) {
      return user;
    }

    // Older roster screens exposed the last six characters of Mongo user IDs as login IDs.
    const legacyMatches = await this.model
      .find({
        role: { $ne: 'SUPER_ADMIN' },
        $expr: {
          $eq: [{ $substrCP: [{ $toString: '$_id' }, 18, 6] }, normalized],
        },
      })
      .select(selectCredentials)
      .limit(2)
      .exec();

    return legacyMatches.length === 1 ? legacyMatches[0] : null;
  }

  /**
   * Find user by email across all tenants for initial login lookup
   */
  async findByNormalizedEmailGlobal(normalizedEmail: string): Promise<IUser | null> {
    const superAdmin = await SuperAdminModel
      .findOne({ normalizedEmail })
      .select('+passwordHash +password +refreshTokens')
      .exec();
    if (superAdmin) return superAdmin as unknown as IUser;

    return this.model.findOne({ normalizedEmail }).select('+passwordHash +password +refreshTokens').exec();
  }

  async findByIdWithRefreshTokens(organizationId: string, id: string): Promise<IUser | null> {
    const superAdmin = await SuperAdminModel.findById(id).select('+refreshTokens').exec();
    if (superAdmin) return superAdmin as unknown as IUser;

    return this.model
      .findOne({ _id: id, organizationId })
      .select('+refreshTokens')
      .exec();
  }

  /**
   * Find user by email within specific tenant
   */
  async findByNormalizedEmail(organizationId: string, normalizedEmail: string): Promise<IUser | null> {
    const superAdmin = await SuperAdminModel.findOne({ normalizedEmail }).select('+passwordHash +password +refreshTokens').exec();
    if (superAdmin) return superAdmin as unknown as IUser;

    return this.model.findOne({ organizationId, normalizedEmail }).select('+passwordHash +password +refreshTokens').exec();
  }

  /**
   * Save refresh token for user session
   */
  async addRefreshToken(userId: string, token: string): Promise<void> {
    const isSA = await SuperAdminModel.exists({ _id: userId });
    if (isSA) {
      await SuperAdminModel.updateOne({ _id: userId }, { $push: { refreshTokens: token } });
    } else {
      await this.model.updateOne({ _id: userId }, { $push: { refreshTokens: token } });
    }
  }

  /**
   * Remove specific refresh token on logout
   */
  async removeRefreshToken(userId: string, token: string): Promise<void> {
    await Promise.all([
      SuperAdminModel.updateOne({ _id: userId }, { $pull: { refreshTokens: token } }),
      this.model.updateOne({ _id: userId }, { $pull: { refreshTokens: token } }),
    ]);
  }

  /**
   * Clear all refresh tokens on remote logout/revoke
   */
  async clearAllRefreshTokens(userId: string): Promise<void> {
    await Promise.all([
      SuperAdminModel.updateOne({ _id: userId }, { $set: { refreshTokens: [] } }),
      this.model.updateOne({ _id: userId }, { $set: { refreshTokens: [] } }),
    ]);
  }

  /**
   * Updates user by ID, checking 'superadmins' collection first if the user is a super admin
   */
  override async updateById(
    organizationId: string,
    id: string,
    update: any,
    options?: any
  ): Promise<IUser | null> {
    const isSA = await SuperAdminModel.exists({ _id: id });
    if (isSA) {
      const sa = await SuperAdminModel.findByIdAndUpdate(id, update, { ...options, new: true });
      return sa as unknown as IUser;
    }
    return super.updateById(organizationId, id, update, options);
  }
}

export const authRepository = new AuthRepository();
