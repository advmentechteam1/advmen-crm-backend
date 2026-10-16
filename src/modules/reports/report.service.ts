import mongoose from 'mongoose';
import { DealModel, DealStage } from '../deals/deal.model.js';
import { InvoiceModel } from '../invoices-payments/invoice.model.js';
import { ReportModel, IWorkReport } from './report.model.js';
import { AttendanceModel } from '../attendance/attendance.model.js';
import { UserModel } from '../auth/auth.model.js';
import { AppError } from '../../shared/errors/AppError.js';
import { logger } from '../../shared/logger/logger.js';

const DEAL_STAGES: DealStage[] = [
  'DISCOVERY',
  'QUALIFICATION',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
];

interface CurrencyAmount {
  amount: number;
}

interface DealSummary {
  totalDeals: number;
  wonDeals: number;
  lostDeals: number;
  activeDeals: number;
  pipelineValue: number;
  wonRevenue: number;
}

interface DealStageMetric {
  stage: DealStage;
  count: number;
  value: number;
}

export interface GetWorkReportsParams {
  organizationId: string;
  isSuperAdmin?: boolean;
  date?: string;
  startDate?: string;
  endDate?: string;
  userId?: string;
  employeeId?: string;
  department?: string;
  workCategory?: string;
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export class ReportService {
  constructor() {
    // Automatically trigger initial background sync of existing attendance reports into reports collection
    setTimeout(() => {
      this.syncAttendancesToReports().catch((err) => {
        logger.warn('Initial attendance to reports sync warning:', err.message);
      });
    }, 2000);
  }

  /**
   * Syncs existing work reports from attendances collection into the dedicated 'reports' collection.
   */
  async syncAttendancesToReports(targetOrgId?: string): Promise<{ syncedCount: number }> {
    try {
      const matchCriteria: any = {
        $or: [
          { workReport: { $exists: true, $nin: ['', null] } },
          { workCategory: { $exists: true, $nin: ['', null] } },
        ],
      };
      if (targetOrgId) {
        matchCriteria.organizationId = targetOrgId;
      }

      const attendances = await AttendanceModel.find(matchCriteria).lean();
      let syncedCount = 0;

      for (const att of attendances) {
        if (!att.workReport && !att.workCategory) continue;

        const dateStr = att.date;
        const orgId = att.organizationId || targetOrgId || 'org_default';
        const userId = att.userId?.toString() || att.employeeId || (att as any).empId || att._id.toString();

        // Upsert by organizationId + userId + date
        const existing = await ReportModel.findOne({
          $or: [
            { organizationId: orgId, userId, date: dateStr },
            { date: dateStr, employeeId: att.employeeId || (att as any).empId },
          ],
        });

        const updateData: any = {
          organizationId: orgId,
          userId,
          employeeId: att.employeeId || (att as any).empId || 'EMP',
          userName: att.userName || (att as any).empName || (att as any).name || 'Employee',
          userEmail: att.userEmail || (att as any).email || '',
          userPhone: att.userPhone || (att as any).phone || '',
          department: att.department || 'Sales & Business Development',
          role: att.role || 'SALES_REP',
          date: dateStr,
          workCategory: att.workCategory || 'General Work',
          workReport: att.workReport || 'Report recorded during punch-out.',
          developmentChanges: att.developmentChanges || '',
          taskSummary: att.taskSummary || '',
          punchInTime: att.loginTime,
          punchOutTime: att.logoutTime,
          shiftDurationSeconds: att.shiftDurationSeconds || 0,
          shiftDurationFormatted: att.shiftDurationFormatted || '-',
          selfieUrl: att.selfieUrl,
          punchOutImageUrl: att.punchOutImageUrl,
          location: att.location,
          logoutLocation: att.logoutLocation,
          submittedAt: att.reportSubmittedAt || att.logoutTime || att.createdAt || new Date(),
          source: 'ATTENDANCE_PUNCHOUT',
          status: 'SUBMITTED',
        };

        if (existing) {
          await ReportModel.updateOne({ _id: existing._id }, { $set: updateData });
        } else {
          await ReportModel.create(updateData);
        }
        syncedCount++;
      }

      logger.info(`✅ Synchronized ${syncedCount} work reports into 'reports' collection.`);
      return { syncedCount };
    } catch (err: any) {
      logger.error('Error syncing attendances to reports collection:', err);
      return { syncedCount: 0 };
    }
  }

  /**
   * Fetches work reports from the 'reports' collection with rich filtering and aggregation.
   */
  async getWorkReports(params: GetWorkReportsParams): Promise<{
    reports: IWorkReport[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    summary: {
      totalReports: number;
      todayReports: number;
      uniqueEmployees: number;
      categories: Array<{ category: string; count: number }>;
    };
  }> {
    // Trigger sync check to ensure latest records are captured
    await this.syncAttendancesToReports(params.isSuperAdmin ? undefined : params.organizationId);

    const query: Record<string, any> = {};

    if (!params.isSuperAdmin) {
      query.organizationId = params.organizationId;
    }

    if (params.date) {
      query.date = params.date;
    } else if (params.startDate && params.endDate) {
      query.date = { $gte: params.startDate, $lte: params.endDate };
    } else if (params.startDate) {
      query.date = { $gte: params.startDate };
    } else if (params.endDate) {
      query.date = { $lte: params.endDate };
    }

    if (params.userId) {
      query.userId = params.userId;
    }

    if (params.employeeId) {
      query.employeeId = params.employeeId;
    }

    if (params.department && params.department !== 'ALL') {
      query.department = params.department;
    }

    if (params.workCategory && params.workCategory !== 'ALL') {
      query.workCategory = params.workCategory;
    }

    if (params.status && params.status !== 'ALL') {
      query.status = params.status;
    }

    if (params.search && params.search.trim()) {
      const q = params.search.trim();
      query.$or = [
        { userName: { $regex: q, $options: 'i' } },
        { employeeId: { $regex: q, $options: 'i' } },
        { userEmail: { $regex: q, $options: 'i' } },
        { workReport: { $regex: q, $options: 'i' } },
        { developmentChanges: { $regex: q, $options: 'i' } },
        { workCategory: { $regex: q, $options: 'i' } },
      ];
    }

    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
    const skip = (page - 1) * limit;

    const [reports, total] = await Promise.all([
      ReportModel.find(query).sort({ date: -1, submittedAt: -1 }).skip(skip).limit(limit).lean(),
      ReportModel.countDocuments(query),
    ]);

    // Calculate Summary KPIs
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    const summaryQuery = params.isSuperAdmin ? {} : { organizationId: params.organizationId };
    const [allCount, todayCount, distinctEmps, catAggregation] = await Promise.all([
      ReportModel.countDocuments(summaryQuery),
      ReportModel.countDocuments({ ...summaryQuery, date: todayStr }),
      ReportModel.distinct('userId', summaryQuery).then((res) => res.length),
      ReportModel.aggregate([
        { $match: summaryQuery },
        { $group: { _id: '$workCategory', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    const categories = catAggregation.map((c: any) => ({
      category: c._id || 'General',
      count: c.count,
    }));

    return {
      reports: reports as any,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      summary: {
        totalReports: allCount,
        todayReports: todayCount,
        uniqueEmployees: distinctEmps,
        categories,
      },
    };
  }

  /**
   * Retrieves single work report by ID.
   */
  async getWorkReportById(reportId: string, organizationId: string, isSuperAdmin: boolean = false): Promise<IWorkReport> {
    const query: any = { _id: reportId };
    if (!isSuperAdmin) {
      query.organizationId = organizationId;
    }
    const report = await ReportModel.findOne(query);
    if (!report) {
      throw AppError.notFound('Work report not found');
    }
    return report;
  }

  /**
   * Submits or creates a work report directly or from attendance.
   */
  async submitWorkReport(input: {
    organizationId: string;
    userId: string;
    employeeId?: string;
    userName: string;
    userEmail?: string;
    department?: string;
    role?: string;
    date: string;
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
    source?: string;
  }): Promise<IWorkReport> {
    const existing = await ReportModel.findOne({
      organizationId: input.organizationId,
      userId: input.userId,
      date: input.date,
    });

    if (existing) {
      Object.assign(existing, input, { submittedAt: new Date() });
      await existing.save();
      return existing;
    }

    const report = await ReportModel.create({
      ...input,
      submittedAt: new Date(),
      status: 'SUBMITTED',
      source: input.source || 'DIRECT_PORTAL',
    });

    // Also sync to Attendance record for that date
    await AttendanceModel.updateOne(
      { organizationId: input.organizationId, userId: input.userId, date: input.date },
      {
        $set: {
          workReport: input.workReport,
          workCategory: input.workCategory,
          developmentChanges: input.developmentChanges,
          punchOutImageUrl: input.punchOutImageUrl,
          reportSubmittedAt: new Date(),
        },
      }
    ).catch(() => {});

    return report;
  }

  /**
   * Allows Admin to review, approve, or add feedback to an employee's work report.
   */
  async reviewWorkReport(
    reportId: string,
    organizationId: string,
    reviewData: { status: 'APPROVED' | 'REVIEWED' | 'REJECTED'; reviewNotes?: string; reviewerName: string },
    isSuperAdmin: boolean = false
  ): Promise<IWorkReport> {
    const report = await this.getWorkReportById(reportId, organizationId, isSuperAdmin);
    report.status = reviewData.status;
    if (reviewData.reviewNotes) {
      report.reviewNotes = reviewData.reviewNotes;
    }
    report.reviewedBy = reviewData.reviewerName;
    report.reviewedAt = new Date();
    await report.save();
    return report;
  }

  /**
   * Analytics Overview for Deals & Invoices.
   */
  async getOverview(organizationId: string) {
    const [dealMetrics, invoiceMetrics] = await Promise.all([
      DealModel.aggregate([
        { $match: { organizationId } },
        {
          $facet: {
            summary: [
              {
                $group: {
                  _id: null,
                  totalDeals: { $sum: 1 },
                  wonDeals: { $sum: { $cond: [{ $eq: ['$stage', 'WON'] }, 1, 0] } },
                  lostDeals: { $sum: { $cond: [{ $eq: ['$stage', 'LOST'] }, 1, 0] } },
                  activeDeals: {
                    $sum: { $cond: [{ $not: [{ $in: ['$stage', ['WON', 'LOST']] }] }, 1, 0] },
                  },
                  pipelineValue: {
                    $sum: {
                      $cond: [
                        { $not: [{ $in: ['$stage', ['WON', 'LOST']] }] },
                        { $ifNull: ['$value', 0] },
                        0,
                      ],
                    },
                  },
                  wonRevenue: {
                    $sum: { $cond: [{ $eq: ['$stage', 'WON'] }, { $ifNull: ['$value', 0] }, 0] },
                  },
                },
              },
              { $sort: { _id: 1 } },
            ],
            stages: [
              {
                $group: {
                  _id: '$stage',
                  count: { $sum: 1 },
                  value: { $sum: { $ifNull: ['$value', 0] } },
                },
              },
              { $sort: { _id: 1 } },
              {
                $project: {
                  _id: 0,
                  stage: '$_id',
                  currency: { $literal: 'INR' },
                  count: 1,
                  value: 1,
                },
              },
            ],
            recentDeals: [
              { $sort: { updatedAt: -1, createdAt: -1 } },
              { $limit: 30 },
              {
                $project: {
                  _id: 0,
                  id: { $toString: '$_id' },
                  dealId: 1,
                  title: 1,
                  company: 1,
                  value: 1,
                  currency: { $literal: 'INR' },
                  stage: 1,
                  updatedAt: 1,
                },
              },
            ],
          },
        },
      ]),
      InvoiceModel.aggregate([
        { $match: { organizationId, status: 'PAID' } },
        {
          $group: {
            _id: null,
            amount: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            currency: { $literal: 'INR' },
            amount: 1,
            count: 1,
          },
        },
      ]),
    ]);

    const dealData = dealMetrics[0] || {};
    const summary: Array<DealSummary & { currency: 'INR' }> = (dealData.summary || []).map((row: Record<string, unknown>) => ({
      currency: 'INR',
      totalDeals: Number(row.totalDeals || 0),
      wonDeals: Number(row.wonDeals || 0),
      lostDeals: Number(row.lostDeals || 0),
      activeDeals: Number(row.activeDeals || 0),
      pipelineValue: Number(row.pipelineValue || 0),
      wonRevenue: Number(row.wonRevenue || 0),
    }));
    const stages: Array<DealStageMetric & { currency: 'INR' }> = (dealData.stages || []).map(
      (row: Record<string, unknown>) => ({
        stage: row.stage as DealStage,
        currency: 'INR',
        count: Number(row.count || 0),
        value: Number(row.value || 0),
      })
    );
    const wonCount = summary.reduce((total, row) => total + row.wonDeals, 0);
    const lostCount = summary.reduce((total, row) => total + row.lostDeals, 0);
    const closedDeals = wonCount + lostCount;

    return {
      summary,
      stages: DEAL_STAGES.flatMap((stage) => stages.filter((metric) => metric.stage === stage)),
      collectedPayments: (invoiceMetrics as CurrencyAmount[]).map((row) => ({
        currency: 'INR',
        amount: Number(row.amount || 0),
      })),
      totals: {
        totalDeals: summary.reduce((total, row) => total + row.totalDeals, 0),
        activeDeals: summary.reduce((total, row) => total + row.activeDeals, 0),
        wonDeals: wonCount,
        lostDeals: lostCount,
        closedDeals,
        winRate: closedDeals ? Math.round((wonCount / closedDeals) * 100) : 0,
      },
      recentDeals: (dealData.recentDeals || []).map((deal: Record<string, unknown>) => ({
        id: String(deal.id || deal._id || ''),
        dealId: String(deal.dealId || ''),
        title: String(deal.title || 'Untitled deal'),
        company: String(deal.company || ''),
        value: Number(deal.value || 0),
        currency: 'INR',
        stage: deal.stage as DealStage,
        updatedAt: deal.updatedAt,
      })),
    };
  }
}

export const reportService = new ReportService();
