import mongoose from 'mongoose';
import { UserModel, IUser } from '../auth/auth.model.js';
import { SuperAdminModel } from '../auth/superAdmin.model.js';
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
    } else {
      query.role = { $ne: 'SUPER_ADMIN' };
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
    const isObjectId = mongoose.isValidObjectId(id);
    let query: Record<string, any>;

    if (isObjectId) {
      query = { _id: id };
    } else {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escaped}$`, 'i');
      query = {
        $or: [
          { employeeId: regex },
          { empId: regex },
          { email: regex },
        ],
      };
    }

    if (!isSuperAdmin) {
      query.organizationId = organizationId;
    }
    const user = await UserModel.findOne(query);
    if (user) return user;

    if (isSuperAdmin && isObjectId) {
      const sa = await SuperAdminModel.findById(id);
      if (sa) return sa as unknown as IUser;
    }
    return null;
  }

  async findByNormalizedEmail(email: string): Promise<IUser | null> {
    const sa = await SuperAdminModel.findOne({ normalizedEmail: email.toLowerCase() });
    if (sa) return sa as unknown as IUser;
    return UserModel.findOne({ normalizedEmail: email.toLowerCase() });
  }

  async create(userData: Partial<IUser>): Promise<IUser> {
    if (userData.role === 'SUPER_ADMIN') {
      const sa = await SuperAdminModel.create(userData as any);
      return sa as unknown as IUser;
    }
    return UserModel.create(userData);
  }

  async updateById(
    organizationId: string,
    id: string,
    updateData: Partial<IUser>,
    isSuperAdmin: boolean = false
  ): Promise<IUser | null> {
    const isObjectId = mongoose.isValidObjectId(id);

    if (isObjectId) {
      const isSA = await SuperAdminModel.exists({ _id: id });
      if (isSA) {
        const sa = await SuperAdminModel.findByIdAndUpdate(id, { $set: updateData }, { new: true });
        return sa as unknown as IUser;
      }
    }

    let query: Record<string, any>;
    if (isObjectId) {
      query = { _id: id };
    } else {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escaped}$`, 'i');
      query = {
        $or: [
          { employeeId: regex },
          { empId: regex },
          { email: regex },
        ],
      };
    }

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
    const isObjectId = mongoose.isValidObjectId(id);

    if (isObjectId) {
      const isSA = await SuperAdminModel.exists({ _id: id });
      if (isSA) {
        const saRes = await SuperAdminModel.deleteOne({ _id: id });
        return (saRes.deletedCount ?? 0) > 0;
      }
    }

    let query: Record<string, any>;
    if (isObjectId) {
      query = { _id: id };
    } else {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escaped}$`, 'i');
      query = {
        $or: [
          { employeeId: regex },
          { empId: regex },
          { email: regex },
        ],
      };
    }

    if (!isSuperAdmin) {
      query.organizationId = organizationId;
    }
    const result = await UserModel.deleteOne(query);
    return (result.deletedCount ?? 0) > 0;
  }
}

export const userRepository = new UserRepository();
