import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcryptjs';
import { UserRole, USER_ROLES, ROLE_DEFAULT_PERMISSIONS, PermissionKey } from '../../config/constants.js';

export interface IUser extends Document {
  organizationId: string;
  name: string;
  email: string;
  normalizedEmail: string;
  passwordHash: string;
  role: UserRole;
  permissions: PermissionKey[];
  avatarUrl?: string;
  department?: string;
  designation?: string;
  phone?: string;
  employeeId?: string;
  empId?: string;
  isActive: boolean;
  isEmailVerified: boolean;
  refreshTokens: string[];
  lastLoginAt?: Date;
  passwordResetToken?: string;
  passwordResetExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  password?: string;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const UserSchema = new Schema<IUser>(
  {
    organizationId: {
      type: String,
      default: 'org_advmen_platform',
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
    },
    normalizedEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: function() {
        return this.email ? this.email.toLowerCase().trim() : '';
      }
    },
    passwordHash: {
      type: String,
      select: false, // Do not return password by default in queries
    },
    password: {
      type: String,
      select: false,
    },
    role: {
      type: String,
      default: USER_ROLES.SALES_REP,
      set: (val: string) => {
        const up = (val || '').toUpperCase().replace(/-/g, '_').trim();
        if (up === 'SUPERADMIN' || up === 'SUPER_ADMIN') return USER_ROLES.SUPER_ADMIN;
        if (up === 'ADMIN' || up === 'ORG_ADMIN') return USER_ROLES.ORG_ADMIN;
        if (up === 'EMPLOYEE' || up === 'STAFF' || up === 'USER') return USER_ROLES.SALES_REP;
        return up || USER_ROLES.SALES_REP;
      },
    },
    permissions: {
      type: [String],
      default: function () {
        const rawRole = (this?.role || '').toUpperCase().replace('-', '_');
        const userRole = (rawRole === 'SUPERADMIN' ? USER_ROLES.SUPER_ADMIN : rawRole) as UserRole;
        return ROLE_DEFAULT_PERMISSIONS[userRole] || ROLE_DEFAULT_PERMISSIONS.SALES_REP;
      },
    },
    avatarUrl: {
      type: String,
    },
    department: {
      type: String,
      default: 'General Sales',
      trim: true,
    },
    designation: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
    },
    employeeId: {
      type: String,
      trim: true,
      uppercase: true,
    },
    empId: {
      type: String,
      trim: true,
      uppercase: true,
      default: function (this: any) {
        return this.employeeId;
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isEmailVerified: {
      type: Boolean,
      default: true,
    },
    refreshTokens: {
      type: [String],
      default: [],
      select: false,
    },
    lastLoginAt: {
      type: Date,
    },
    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpiresAt: {
      type: Date,
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

// Critical compound indexes per specification
UserSchema.index({ organizationId: 1, normalizedEmail: 1 }, { unique: true });
UserSchema.index({ organizationId: 1, createdAt: -1 });
UserSchema.index({ organizationId: 1, role: 1, isActive: 1 });
UserSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { employeeId: { $type: 'string' } } }
);

UserSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  const hash = this.passwordHash || (this as any).password;
  if (!hash) return false;
  return bcrypt.compare(candidatePassword, hash);
};

export const UserModel = mongoose.model<IUser>('User', UserSchema);
