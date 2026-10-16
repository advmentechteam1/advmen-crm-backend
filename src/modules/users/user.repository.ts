import { UserModel, IUser } from '../auth/auth.model.js';
import { UserFilterQuery } from './user.validators.js';

export class UserRepository {
  async findUsers(
    organizationId: string,
    filter: UserFilterQuery,
    isSuperAdmin: boolean = false
  ): Promise<{ users: IUser[]; total: number; page: number; totalPages: number }> {
    const query: Record<string, any> = {};

    // Super Admin can view all or filter by specific organizationId
    if (isSuperAdmin) {
      if (filter.organizationId) {
        query.organizationId = filter.organizationId;
      }
    } else {
      query.organizationId = organizationId;
    }

    if (filter.role) {
      query.role = filter.role;
    }

    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive === 'true';
    }

    if (filter.search) {
      const searchRegex = new RegExp(filter.search, 'i');
      query.$or = [{ name: searchRegex }, { email: searchRegex }, { department: searchRegex }];
    }

    const page = filter.page || 1;
    const limit = filter.limit || 50;
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      UserModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      UserModel.countDocuments(query),
    ]);

    return {
      users: users as unknown as IUser[],
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  async findById(
    organizationId: string,
    id: string,
    isSuperAdmin: boolean = false
  ): Promise<IUser | null> {
    const query: Record<string, any> = { _id: id };
    if (!isSuperAdmin) {
      query.organizationId = organizationId;
    }
    return UserModel.findOne(query);
  }

  async findByNormalizedEmail(email: string): Promise<IUser | null> {
    return UserModel.findOne({ normalizedEmail: email.toLowerCase() });
  }

  async create(userData: Partial<IUser>): Promise<IUser> {
    return UserModel.create(userData);
  }

  async updateById(
    organizationId: string,
    id: string,
    updateData: Partial<IUser>,
    isSuperAdmin: boolean = false
  ): Promise<IUser | null> {
    const query: Record<string, any> = { _id: id };
    if (!isSuperAdmin) {
      query.organizationId = organizationId;
    }
    return UserModel.findOneAndUpdate(query, { $set: updateData }, { new: true });
  }

  async deleteById(
    organizationId: string,
    id: string,
    isSuperAdmin: boolean = false
  ): Promise<boolean> {
    const query: Record<string, any> = { _id: id };
    if (!isSuperAdmin) {
      query.organizationId = organizationId;
    }
    const result = await UserModel.deleteOne(query);
    return (result.deletedCount ?? 0) > 0;
  }
}

export const userRepository = new UserRepository();
