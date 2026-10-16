import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { attendanceService } from './attendance.service.js';
import { AttendanceModel } from './attendance.model.js';
import { AppError } from '../../shared/errors/AppError.js';
import { AuthenticatedUser } from '../../middleware/auth.middleware.js';

export class AttendanceController {
  /**
   * GET /api/v1/attendance
   * Administrator view of attendance roster and analytics
   */
  async getAttendanceList(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ORG_ADMIN') {
      throw AppError.forbidden('Only administrators can view employee attendance');
    }
    const { date, startDate, endDate, userId, department, status, search, page, limit } = req.query;

    const isSuperAdmin = user.role === 'SUPER_ADMIN';

    const result = await attendanceService.getAttendanceList(
      user.organizationId,
      {
        date: date as string,
        startDate: startDate as string,
        endDate: endDate as string,
        userId: userId as string,
        department: department as string,
        status: status as any,
        search: search as string,
        page: page ? parseInt(page as string, 10) : 1,
        limit: limit ? parseInt(limit as string, 10) : 100,
      },
      isSuperAdmin
    );

    res.status(200).json(result);
  }

  /**
   * GET /api/v1/attendance/my
   * Logged-in employee viewing their own attendance log
   */
  async getMyAttendance(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 30;

    const history = await attendanceService.getEmployeeHistory(user.organizationId, user.id, limit);
    res.status(200).json({ history });
  }

  /**
   * POST /api/v1/attendance/punch-out
   * Logged-in employee recording punch out
   */
  async punchOut(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    const isSuperAdmin = user.role === 'SUPER_ADMIN';
    const updated = await attendanceService.recordLogout(
      user.organizationId,
      user.id,
      isSuperAdmin ? 'ADMIN' : 'EMPLOYEE',
      user.name
    );

    res.status(200).json({
      success: true,
      message: 'Punch-out recorded successfully',
      record: updated,
    });
  }

  /**
   * POST /api/v1/attendance/force-logout
   * Admin forces punch-out / logout for an employee
   */
  async adminForceLogout(req: Request, res: Response): Promise<void> {
    const adminUser = (req as any).user as AuthenticatedUser;
    if (adminUser.role !== 'SUPER_ADMIN' && adminUser.role !== 'ORG_ADMIN') {
      throw AppError.forbidden('Only administrators can force logout employees');
    }
    const { userId } = req.body;
    if (!userId) {
      throw AppError.badRequest('Target userId is required to force logout employee');
    }

    const updated = await attendanceService.recordLogout(
      adminUser.organizationId,
      userId,
      'ADMIN',
      adminUser.name
    );

    res.status(200).json({
      success: true,
      message: 'Employee logged out by Administrator and attendance record updated.',
      record: updated,
    });
  }

  /**
   * POST /api/v1/attendance/sync
   * Admin triggers manual sync with external Attendance CRM app
   */
  async syncExternalAttendance(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    const result = await attendanceService.syncExternalAttendance(user.organizationId, true);

    res.status(200).json({
      success: true,
      message: result.message,
      syncedCount: result.syncedCount,
    });
  }

  /**
   * DELETE /api/v1/attendance/:id

   * Admin deletes a single attendance record
   */
  async deleteRecord(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ORG_ADMIN') {
      throw AppError.forbidden('Only administrators can delete attendance records');
    }
    const { id } = req.params;
    if (!id) {
      throw AppError.badRequest('Record ID is required');
    }

    const isSuperAdmin = user.role === 'SUPER_ADMIN';
    const deleted = await attendanceService.deleteAttendanceRecord(user.organizationId, id, isSuperAdmin);

    res.status(200).json({
      success: true,
      message: deleted ? 'Attendance record deleted successfully' : 'Record not found or already deleted',
    });
  }

  /**
   * DELETE /api/v1/attendance/clear-all
   * Admin wipes all attendance records
   */
  async clearAll(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ORG_ADMIN') {
      throw AppError.forbidden('Only administrators can clear all attendance records');
    }

    const isSuperAdmin = user.role === 'SUPER_ADMIN';
    const deletedCount = await attendanceService.clearAllAttendance(user.organizationId, isSuperAdmin);

    res.status(200).json({
      success: true,
      message: `Successfully cleared all ${deletedCount} attendance records`,
      deletedCount,
    });
  }

  /**
   * POST /api/v1/attendance/lunch/start
   * Start lunch break for logged in employee
   */
  async startLunch(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    const { notes, userId: targetUserId } = req.body;
    const effectiveUserId = targetUserId && (user.role === 'SUPER_ADMIN' || user.role === 'ORG_ADMIN')
      ? targetUserId
      : user.id;

    const updated = await attendanceService.startLunch(user.organizationId, effectiveUserId, notes);
    res.status(200).json({
      success: true,
      message: 'Lunch break started successfully',
      record: updated,
    });
  }

  /**
   * POST /api/v1/attendance/lunch/end
   * End lunch break for logged in employee
   */
  async endLunch(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    const { userId: targetUserId } = req.body;
    const effectiveUserId = targetUserId && (user.role === 'SUPER_ADMIN' || user.role === 'ORG_ADMIN')
      ? targetUserId
      : user.id;

    const updated = await attendanceService.endLunch(user.organizationId, effectiveUserId);
    res.status(200).json({
      success: true,
      message: 'Lunch break completed successfully',
      record: updated,
    });
  }

  /**
   * GET /api/v1/attendance/lunch/status
   * Get employee lunch status for today
   */
  async getLunchStatus(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    const targetUserId = (req.query.userId as string) && (user.role === 'SUPER_ADMIN' || user.role === 'ORG_ADMIN')
      ? (req.query.userId as string)
      : user.id;

    const status = await attendanceService.getLunchStatus(user.organizationId, targetUserId);
    res.status(200).json(status);
  }

  /**
   * GET /api/v1/attendance/employee/:userId/history
   * Administrator or employee viewing full month day-by-day and lunch history
   */
  async getEmployeeMonthlyHistory(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    const { userId } = req.params;
    const { month } = req.query;

    if (!userId) {
      throw AppError.badRequest('Employee userId is required');
    }

    // Authorization: User can view their own history; admins can view any employee's history
    if (user.id !== userId && user.role !== 'SUPER_ADMIN' && user.role !== 'ORG_ADMIN') {
      throw AppError.forbidden('Only administrators can view other employees attendance history');
    }

    const isSuperAdmin = user.role === 'SUPER_ADMIN';
    const history = await attendanceService.getEmployeeMonthlyHistory(
      user.organizationId,
      userId,
      month as string,
      isSuperAdmin
    );

    res.status(200).json(history);
  }

  /**
   * POST /api/v1/attendance/employee/:userId/lunch
   * Admin manually records/adjusts lunch for an employee on a specific date
   */
  async adminRecordLunch(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ORG_ADMIN') {
      throw AppError.forbidden('Only administrators can manually log lunch breaks');
    }

    const { userId } = req.params;
    const { date, startTime, endTime, notes } = req.body;
    if (!userId || !date || !startTime || !endTime) {
      throw AppError.badRequest('userId, date, startTime, and endTime are required');
    }

    const isSuperAdmin = user.role === 'SUPER_ADMIN';
    const updated = await attendanceService.manualRecordLunch(
      user.organizationId,
      userId,
      date,
      startTime,
      endTime,
      notes,
      isSuperAdmin
    );

    res.status(200).json({
      success: true,
      message: 'Lunch break recorded successfully',
      record: updated,
    });
  }

  /**
   * GET /api/v1/attendance/:id/selfie
   * High-performance on-demand image streaming for attendance check-in selfies.
   * Enables browsers to cache images for 24h and keeps attendance JSON payloads tiny (<100KB).
   */
  async getSelfieImage(req: Request, res: Response): Promise<void> {
    const FALLBACK_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect width="80" height="80" fill="#e2e8f0" rx="12"/><circle cx="40" cy="30" r="14" fill="#94a3b8"/><path d="M16 66c0-13.255 10.745-24 24-24s24 10.745 24 24" fill="#94a3b8"/></svg>`;

    const sendFallback = () => {
      res.set({
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=3600',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      res.status(200).send(FALLBACK_AVATAR_SVG);
    };

    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      sendFallback();
      return;
    }

    try {
      const record = await AttendanceModel.findById(id).select('+selfieData +selfie').lean();
      if (!record) {
        sendFallback();
        return;
      }

      const raw = (record as any).selfieData || (record as any).selfie || record.selfieUrl;
      if (!raw || typeof raw !== 'string' || !raw.trim()) {
        sendFallback();
        return;
      }

      const trimmed = raw.trim();

      // Handle data URI base64 images
      if (trimmed.startsWith('data:image')) {
        const commaIdx = trimmed.indexOf(',');
        if (commaIdx !== -1) {
          const header = trimmed.substring(0, commaIdx);
          const base64Str = trimmed.substring(commaIdx + 1);
          const mimeMatch = header.match(/data:([^;]+);/);
          const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
          const buffer = Buffer.from(base64Str, 'base64');

          res.set({
            'Content-Type': mimeType,
            'Content-Length': buffer.length.toString(),
            'Cache-Control': 'public, max-age=86400, immutable',
            'Cross-Origin-Resource-Policy': 'cross-origin',
          });
          res.end(buffer);
          return;
        }
      }

      // Handle external HTTP/HTTPS URL
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        res.redirect(trimmed);
        return;
      }

      sendFallback();
    } catch (err: any) {
      sendFallback();
    }
  }

  async triggerDedupDebug(req: Request, res: Response): Promise<void> {
    try {
      const result = await attendanceService.deduplicateAttendanceRecords();
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async getSampleDebug(req: Request, res: Response): Promise<void> {
    try {
      if (!mongoose.connection?.db) {
        res.json({ error: 'No db connection' });
        return;
      }
      const col = mongoose.connection.db.collection('attendances');
      const totalDocs = await col.countDocuments();

      const sample15Oct = await col.find({ date: '2026-10-15' }).limit(10).project({
        userName: 1,
        employeeId: 1,
        userId: 1,
        date: 1,
        loginTime: 1,
        logoutTime: 1,
        lastActiveAt: 1,
        selfieUrl: 1,
        imageUrl: 1,
        loginEvents: 1,
      }).toArray();

      const sampleFormatted = sample15Oct.map((d: any) => ({
        name: d.userName,
        loginTime: d.loginTime,
        logoutTime: d.logoutTime,
        logoutType: typeof d.logoutTime,
        eventsCount: d.loginEvents?.length,
        events: d.loginEvents?.map((e: any) => ({
          in: e.loginTime,
          out: e.logoutTime,
          by: e.logoutBy,
        })),
        selfieUrlType: typeof d.selfieUrl,
        selfieLen: d.selfieUrl ? String(d.selfieUrl).length : 0,
        selfiePrefix: d.selfieUrl ? String(d.selfieUrl).substring(0, 50) : null,
        imageUrlType: typeof d.imageUrl,
        imageLen: d.imageUrl ? String(d.imageUrl).length : 0,
        imagePrefix: d.imageUrl ? String(d.imageUrl).substring(0, 50) : null,
      }));

      res.json({
        totalDocs,
        sampleFormatted,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * GET /api/v1/attendance/employee/:userId/daily-report
   * Administrator or employee viewing detailed daily activity report
   */
  async getEmployeeDailyReport(req: Request, res: Response): Promise<void> {
    const user = (req as any).user as AuthenticatedUser;
    const { userId } = req.params;
    const { date } = req.query;

    if (!userId) {
      throw AppError.badRequest('Employee userId is required');
    }

    if (user.id !== userId && user.role !== 'SUPER_ADMIN' && user.role !== 'ORG_ADMIN') {
      throw AppError.forbidden('Only administrators can view other employees daily activity report');
    }

    const isSuperAdmin = user.role === 'SUPER_ADMIN';
    const report = await attendanceService.getEmployeeDailyReport(
      user.organizationId,
      userId,
      date as string,
      isSuperAdmin
    );

    res.status(200).json(report);
  }
}

export const attendanceController = new AttendanceController();
export default attendanceController;

