import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IWorkReport extends Document {
  organizationId: string;
  userId: string;
  employeeId?: string;
  userName: string;
  userEmail?: string;
  userPhone?: string;
  department?: string;
  role?: string;
  date: string; // YYYY-MM-DD
  workCategory: string;
  workReport: string;
  developmentChanges?: string;
  taskSummary?: string;
  punchInTime?: Date;
  punchOutTime?: Date;
  shiftDurationSeconds?: number;
  shiftDurationFormatted?: string;
  selfieUrl?: string;
  punchOutImageUrl?: string;
  location?: any;
  logoutLocation?: any;
  submittedAt: Date;
  status: 'SUBMITTED' | 'APPROVED' | 'REVIEWED' | 'REJECTED';
  reviewNotes?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

const WorkReportSchema = new Schema<IWorkReport>(
  {
    organizationId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    employeeId: {
      type: String,
      index: true,
      default: 'EMP',
    },
    userName: {
      type: String,
      required: true,
      trim: true,
    },
    userEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    userPhone: {
      type: String,
      trim: true,
    },
    department: {
      type: String,
      default: 'General',
      index: true,
    },
    role: {
      type: String,
      default: 'EMPLOYEE',
    },
    date: {
      type: String,
      required: true,
      index: true,
    },
    workCategory: {
      type: String,
      required: true,
      default: 'General Work',
      index: true,
    },
    workReport: {
      type: String,
      required: true,
      trim: true,
    },
    developmentChanges: {
      type: String,
      trim: true,
    },
    taskSummary: {
      type: String,
      trim: true,
    },
    punchInTime: {
      type: Date,
    },
    punchOutTime: {
      type: Date,
    },
    shiftDurationSeconds: {
      type: Number,
      default: 0,
    },
    shiftDurationFormatted: {
      type: String,
      default: '-',
    },
    selfieUrl: {
      type: String,
    },
    punchOutImageUrl: {
      type: String,
    },
    location: {
      type: Schema.Types.Mixed,
    },
    logoutLocation: {
      type: Schema.Types.Mixed,
    },
    submittedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    status: {
      type: String,
      enum: ['SUBMITTED', 'APPROVED', 'REVIEWED', 'REJECTED'],
      default: 'SUBMITTED',
      index: true,
    },
    reviewNotes: {
      type: String,
    },
    reviewedBy: {
      type: String,
    },
    reviewedAt: {
      type: Date,
    },
    source: {
      type: String,
      default: 'ATTENDANCE_PUNCHOUT',
    },
  },
  {
    timestamps: true,
    collection: 'reports', // Explicit collection name in MongoDB!
  }
);

// Compound indexes for optimal query speed
WorkReportSchema.index({ organizationId: 1, date: -1 });
WorkReportSchema.index({ organizationId: 1, userId: 1, date: -1 });
WorkReportSchema.index({ employeeId: 1, date: -1 });
WorkReportSchema.index({ workCategory: 1 });

export const ReportModel: Model<IWorkReport> =
  mongoose.models.Report || mongoose.model<IWorkReport>('Report', WorkReportSchema, 'reports');
