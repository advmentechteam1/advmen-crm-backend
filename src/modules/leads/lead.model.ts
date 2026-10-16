import mongoose, { Schema, Document } from 'mongoose';

export type LeadStatus =
  | 'NEW'
  | 'ASSIGNED'
  | 'CONTACTED'
  | 'CONNECTED'
  | 'QUALIFIED'
  | 'MEETING'
  | 'PROPOSAL'
  | 'NEGOTIATION'
  | 'WON'
  | 'LOST';

export type LeadSource =
  | 'WEBSITE'
  | 'LANDING_PAGE'
  | 'META_ADS'
  | 'GOOGLE_ADS'
  | 'LINKEDIN'
  | 'INBOUND_CALL'
  | 'REFERRAL'
  | 'MANUAL'
  | 'CSV_IMPORT'
  | 'API';

export type LeadScoreCategory = 'HOT' | 'WARM' | 'COLD';
export type SlaStatus = 'ON_TIME' | 'APPROACHING_BREACH' | 'BREACHED';

export interface ILead extends Document {
  leadId: string;
  organizationId: string;
  name: string;
  phone: string;
  normalizedPhone: string;
  email: string;
  normalizedEmail: string;
  company: string;
  title?: string;
  source: LeadSource;
  campaignId?: string;
  status: LeadStatus;
  ownerId?: string;
  assignedTo?: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  score: number;
  scoreCategory: LeadScoreCategory;
  budget?: number;
  requirement?: string;
  firstContactAt?: Date;
  nextFollowUpAt?: Date;
  slaStatus: SlaStatus;
  consent?: {
    channel: string;
    purpose: string;
    status: 'GRANTED' | 'REVOKED' | 'OPT_OUT';
    capturedAt: Date;
    capturedBy?: string;
    evidence?: string;
    revokedAt?: Date;
  };
  tags: string[];
  customFields?: Record<string, unknown>;
  aiSummary?: {
    overview: string;
    intentLevel: 'HIGH' | 'MEDIUM' | 'LOW';
    suggestedAction: string;
    keyPoints: string[];
    isApproved?: boolean;
  };
  city?: string;
  address?: string;
  queries?: Array<{
    id: string;
    text: string;
    priority?: 'NORMAL' | 'HIGH' | 'URGENT';
    raisedBy: { id: string; name: string; email?: string };
    status: 'OPEN' | 'RESOLVED';
    reply?: string;
    createdAt: Date;
    resolvedAt?: Date;
  }>;
  clearedInfo?: {
    clearedAt: Date;
    purpose: string;
    notes?: string;
    message?: string;
    dealId?: string;
    dealValue?: number;
    clearedBy?: { id: string; name: string };
    paymentInvoiceId?: string;
    paymentRecordedAt?: Date;
    paymentTotalPaid?: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const LeadSchema = new Schema<ILead>(
  {
    leadId: {
      type: String,
      required: true,
      index: true,
    },
    organizationId: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    normalizedPhone: {
      type: String,
      required: true,
      index: true,
    },
    email: {
      type: String,
      trim: true,
    },
    normalizedEmail: {
      type: String,
      index: true,
    },
    company: {
      type: String,
      default: 'Individual Prospect',
      trim: true,
    },
    title: {
      type: String,
      trim: true,
    },
    source: {
      type: String,
      enum: [
        'WEBSITE',
        'LANDING_PAGE',
        'META_ADS',
        'GOOGLE_ADS',
        'LINKEDIN',
        'INBOUND_CALL',
        'REFERRAL',
        'MANUAL',
        'CSV_IMPORT',
        'API',
      ],
      default: 'MANUAL',
    },
    campaignId: {
      type: String,
    },
    status: {
      type: String,
      enum: [
        'NEW',
        'ASSIGNED',
        'CONTACTED',
        'CONNECTED',
        'QUALIFIED',
        'MEETING',
        'PROPOSAL',
        'NEGOTIATION',
        'WON',
        'LOST',
      ],
      default: 'NEW',
    },
    ownerId: {
      type: String,
      index: true,
    },
    assignedTo: {
      id: String,
      name: String,
      avatarUrl: String,
    },
    score: {
      type: Number,
      default: 50,
      min: 0,
      max: 100,
    },
    scoreCategory: {
      type: String,
      enum: ['HOT', 'WARM', 'COLD'],
      default: 'WARM',
    },
    budget: {
      type: Number,
      default: 0,
    },
    requirement: {
      type: String,
      trim: true,
    },
    firstContactAt: {
      type: Date,
    },
    nextFollowUpAt: {
      type: Date,
      index: true,
    },
    slaStatus: {
      type: String,
      enum: ['ON_TIME', 'APPROACHING_BREACH', 'BREACHED'],
      default: 'ON_TIME',
    },
    consent: {
      channel: { type: String, default: 'WEB_FORM' },
      purpose: { type: String, default: 'SALES_CONTACT' },
      status: { type: String, enum: ['GRANTED', 'REVOKED', 'OPT_OUT'], default: 'GRANTED' },
      capturedAt: { type: Date, default: Date.now },
      capturedBy: String,
      evidence: String,
      revokedAt: Date,
    },
    tags: {
      type: [String],
      default: [],
    },
    customFields: {
      type: Schema.Types.Mixed,
      default: {},
    },
    city: {
      type: String,
      trim: true,
    },
    address: {
      type: String,
      trim: true,
    },
    queries: [
      {
        id: { type: String, default: () => `qry_${Date.now()}_${Math.random().toString(36).substr(2, 6)}` },
        text: { type: String, required: true },
        priority: { type: String, enum: ['NORMAL', 'HIGH', 'URGENT'], default: 'NORMAL' },
        raisedBy: {
          id: String,
          name: String,
          email: String,
        },
        status: { type: String, enum: ['OPEN', 'RESOLVED'], default: 'OPEN' },
        reply: String,
        createdAt: { type: Date, default: Date.now },
        resolvedAt: Date,
      },
    ],
    clearedInfo: {
      clearedAt: Date,
      purpose: String,
      notes: String,
      message: String,
      dealId: String,
      dealValue: Number,
      paymentInvoiceId: String,
      paymentRecordedAt: Date,
      paymentTotalPaid: { type: Number, default: 0 },
      clearedBy: {
        id: String,
        name: String,
      },
    },
    aiSummary: {
      overview: String,
      intentLevel: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'], default: 'MEDIUM' },
      suggestedAction: String,
      keyPoints: [String],
      isApproved: { type: Boolean, default: false },
    },
  },
  {
    timestamps: true,
  }
);

// Critical compound indexes specified in PDF Section 16
LeadSchema.index({ organizationId: 1, createdAt: -1 });
LeadSchema.index({ organizationId: 1, ownerId: 1 });
LeadSchema.index({ organizationId: 1, ownerId: 1, status: 1 });
LeadSchema.index({ organizationId: 1, normalizedPhone: 1 });
LeadSchema.index({ organizationId: 1, normalizedEmail: 1 });
LeadSchema.index({ organizationId: 1, nextFollowUpAt: 1 });
LeadSchema.index({ organizationId: 1, status: 1 });

export const LeadModel = mongoose.model<ILead>('Lead', LeadSchema);
