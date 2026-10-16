import { Request, Response } from 'express';
import { ApiResponse } from '../../shared/response/ApiResponse.js';
import { reportService } from './report.service.js';
import { AuthenticatedUser } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/AppError.js';

export class ReportController {
  /**
   * GET /api/v1/reports/overview
   * Deals & Financial pipeline metrics
   */
  async getOverview(req: Request, res: Response): Promise<void> {
    const report = await reportService.getOverview(req.organizationId!);
    ApiResponse.success(res, report, 200, undefined, 'Reports retrieved successfully');
  }

  /**
   * GET /api/v1/reports/work-reports
   * Fetches work reports submitted during punch-out / daily tasks
   */
  async getWorkReports(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    const isSuperAdmin = user?.role === 'SUPER_ADMIN';

    const {
      date,
      startDate,
      endDate,
      userId,
      employeeId,
      department,
      workCategory,
      status,
      search,
      page,
      limit,
    } = req.query;

    const result = await reportService.getWorkReports({
      organizationId: req.organizationId || (user as any)?.organizationId || 'org_default',
      isSuperAdmin,
      date: date ? String(date) : undefined,
      startDate: startDate ? String(startDate) : undefined,
      endDate: endDate ? String(endDate) : undefined,
      userId: userId ? String(userId) : undefined,
      employeeId: employeeId ? String(employeeId) : undefined,
      department: department ? String(department) : undefined,
      workCategory: workCategory ? String(workCategory) : undefined,
      status: status ? String(status) : undefined,
      search: search ? String(search) : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });

    ApiResponse.success(res, result, 200, undefined, 'Work reports retrieved successfully');
  }

  /**
   * GET /api/v1/reports/work-reports/:id
   */
  async getWorkReportById(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    const isSuperAdmin = user?.role === 'SUPER_ADMIN';
    const report = await reportService.getWorkReportById(
      req.params.id,
      req.organizationId || (user as any)?.organizationId || 'org_default',
      isSuperAdmin
    );
    ApiResponse.success(res, report, 200, undefined, 'Work report retrieved successfully');
  }

  /**
   * POST /api/v1/reports/work-reports
   * Submits a new work report
   */
  async submitWorkReport(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    const {
      userId,
      employeeId,
      userName,
      userEmail,
      department,
      role,
      date,
      workCategory,
      workReport,
      developmentChanges,
      taskSummary,
      punchInTime,
      punchOutTime,
      shiftDurationSeconds,
      shiftDurationFormatted,
      selfieUrl,
      punchOutImageUrl,
      location,
      logoutLocation,
      source,
    } = req.body;

    if (!workReport && !developmentChanges) {
      throw AppError.badRequest('Work report description or development changes are required');
    }

    const orgId = req.organizationId || user?.organizationId || 'org_default';
    const effectiveUserId = userId || user?.id;
    const effectiveUserName = userName || user?.name || 'Employee';

    const report = await reportService.submitWorkReport({
      organizationId: orgId,
      userId: effectiveUserId,
      employeeId: employeeId || (user as any)?.employeeId,
      userName: effectiveUserName,
      userEmail: userEmail || user?.email,
      department: department || (user as any)?.department,
      role: role || user?.role,
      date: date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
      workCategory: workCategory || 'General Work',
      workReport: workReport || '',
      developmentChanges,
      taskSummary,
      punchInTime: punchInTime ? new Date(punchInTime) : undefined,
      punchOutTime: punchOutTime ? new Date(punchOutTime) : undefined,
      shiftDurationSeconds,
      shiftDurationFormatted,
      selfieUrl,
      punchOutImageUrl,
      location,
      logoutLocation,
      source: source || 'DIRECT_PORTAL',
    });

    ApiResponse.success(res, report, 201, undefined, 'Work report submitted successfully');
  }

  /**
   * PATCH /api/v1/reports/work-reports/:id/review
   */
  async reviewWorkReport(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    const isSuperAdmin = user?.role === 'SUPER_ADMIN';
    const { status, reviewNotes } = req.body;

    const updated = await reportService.reviewWorkReport(
      req.params.id,
      req.organizationId || user?.organizationId || 'org_default',
      {
        status: status || 'APPROVED',
        reviewNotes,
        reviewerName: user?.name || 'Administrator',
      },
      isSuperAdmin
    );

    ApiResponse.success(res, updated, 200, undefined, 'Work report reviewed successfully');
  }

  /**
   * POST /api/v1/reports/work-reports/sync
   * Force syncs attendance records with punchout reports into reports collection
   */
  async syncWorkReports(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    const isSuperAdmin = user?.role === 'SUPER_ADMIN';
    const result = await reportService.syncAttendancesToReports(
      isSuperAdmin ? undefined : (req.organizationId || user?.organizationId)
    );
    ApiResponse.success(res, result, 200, undefined, 'Reports synchronized successfully');
  }
}

export const reportController = new ReportController();
