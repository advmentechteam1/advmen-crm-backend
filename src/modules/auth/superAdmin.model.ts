import mongoose, { Schema, Document, Model } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface ISuperAdmin extends Document {
  organizationId: string;
  name: string;
  email: string;
  normalizedEmail: string;
  passwordHash: string;
  role: 'SUPER_ADMIN';
  permissions: string[];
  avatarUrl?: string;
  phone?: string;
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

const SuperAdminSchema = new Schema<ISuperAdmin>(
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
      default: 'Super Administrator',
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    normalizedEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },
    passwordHash: {
      type: String,
      select: false,
    },
    password: {
      type: String,
      select: false,
    },
    role: {
      type: String,
      default: 'SUPER_ADMIN',
    },
    permissions: {
      type: [String],
      default: ['*'],
    },
    avatarUrl: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
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
    collection: 'superadmins', // Stored in separate dedicated collection 'superadmins'!
  }
);

SuperAdminSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  const hash = this.passwordHash || (this as any).password;
  if (!hash) return false;
  return bcrypt.compare(candidatePassword, hash);
};

export const SuperAdminModel: Model<ISuperAdmin> =
  mongoose.models.SuperAdmin ||
  mongoose.model<ISuperAdmin>('SuperAdmin', SuperAdminSchema, 'superadmins');
