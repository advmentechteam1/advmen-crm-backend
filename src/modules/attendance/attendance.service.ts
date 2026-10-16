import mongoose from 'mongoose';
import { AttendanceModel, IAttendance, AttendanceStatus, IAttendanceLunchBreak } from './attendance.model.js';
import { UserModel } from '../auth/auth.model.js';
import { emitTenantEvent, emitUserEvent } from '../../config/socket.js';
import { logger } from '../../shared/logger/logger.js';
import { AppError } from '../../shared/errors/AppError.js';
import { CallModel } from '../calls/call.model.js';
import { LeadModel } from '../leads/lead.model.js';
import { TaskModel } from '../tasks/task.model.js';
import { ReportModel } from '../reports/report.model.js';

export interface RecordLoginInput {
  userId: string;
  employeeId?: string;
  name: string;
  email: string;
  phone?: string;
  role: string;
  department?: string;
  organizationId: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface AttendanceFilterQuery {
  date?: string; // "YYYY-MM-DD"
  startDate?: string;
  endDate?: string;
  userId?: string;
  department?: string;
  status?: AttendanceStatus;
  search?: string;
  page?: number;
  limit?: number;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as any).code === 11000;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Converts any stored attendance time value into a real Date.
 * - Accepts Date objects, ISO strings and IST clock strings like "06:02:46 pm" (combined with the record date).
 * - Rejects placeholder values such as epoch 0 ("1970-01-01T00:00:00.000Z"), "null", "Invalid Date", years < 2020.
 */
export function toValidAttendanceDate(value: any, dateStr?: string): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  let d: Date | undefined;
  if (value instanceof Date) {
    d = value;
  } else {
    const s = String(value).trim();
    if (!s || ['null', 'undefined', 'invalid date', '-'].includes(s.toLowerCase())) return undefined;

    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
      const parsed = new Date(s);
      if (!isNaN(parsed.getTime()) && parsed.getFullYear() >= 2020) {
        return parsed;
      }
    }

    const t = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (t) {
      let cleanDate = dateStr ? String(dateStr).trim() : '';
      if (/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.test(cleanDate)) {
        const parts = cleanDate.split(/[\/\-]/);
        cleanDate = `${parts[2]}-${pad2(Number(parts[1]))}-${pad2(Number(parts[0]))}`;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
        cleanDate = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Kolkata',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date());
      }
      let h = parseInt(t[1], 10);
      const m = parseInt(t[2], 10);
      const sec = t[3] ? parseInt(t[3], 10) : 0;
      const ap = t[4]?.toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      d = new Date(`${cleanDate}T${pad2(h)}:${pad2(m)}:${pad2(sec)}+05:30`);
    } else {
      d = new Date(s);
    }
  }
  if (!d || isNaN(d.getTime()) || d.getUTCFullYear() < 2020) return undefined;
  return d;
}

/**
 * Rebuilds a clean, chronological list of login sessions for one attendance record and
 * attaches correct logout times + daily login/logout counts.
 */
export function normalizeAttendanceSessions<T extends Record<string, any>>(rec: T): T & {
  loginEvents: any[];
  loginCount: number;
  logoutCount: number;
  isCurrentlyActive: boolean;
} {
  const dateStr: string | undefined = rec.date;

  type Session = {
    loginTime: Date;
    logoutTime?: Date;
    logoutBy?: string;
    logoutAdminName?: string;
    ipAddress?: string;
    userAgent?: string;
    awayDurationFormatted?: string;
  };

  let sessions: Session[] = (Array.isArray(rec.loginEvents) ? rec.loginEvents : [])
    .map((e: any) => ({
      ...e,
      loginTime: toValidAttendanceDate(e?.loginTime, dateStr),
      logoutTime: toValidAttendanceDate(e?.logoutTime, dateStr),
      logoutBy: e?.logoutBy || undefined,
    }))
    .filter((e: any) => e.loginTime) as Session[];

  const recLogin = toValidAttendanceDate(rec.loginTime, dateStr) || toValidAttendanceDate(rec.punchIn, dateStr);
  if (recLogin && !sessions.some((s) => Math.abs(s.loginTime.getTime() - recLogin.getTime()) < 5000)) {
    sessions.push({ loginTime: recLogin, ipAddress: rec.ipAddress, userAgent: rec.userAgent });
  }

  sessions.sort((a, b) => a.loginTime.getTime() - b.loginTime.getTime());

  // Merge accidental double punch-ins (within 30s, first one never logged out)
  const merged: Session[] = [];
  for (const s of sessions) {
    const prev = merged[merged.length - 1];
    if (prev && !prev.logoutTime && s.loginTime.getTime() - prev.loginTime.getTime() < 30000) {
      if (s.logoutTime) {
        prev.logoutTime = s.logoutTime;
        prev.logoutBy = s.logoutBy;
        prev.logoutAdminName = s.logoutAdminName;
      }
      continue;
    }
    merged.push({ ...s });
  }
  sessions = merged;

  // Logout equal to login (<=3s) or before 2020 is a placeholder, not a real logout
  for (const s of sessions) {
    if (s.logoutTime && (Math.abs(s.logoutTime.getTime() - s.loginTime.getTime()) <= 3000 || s.logoutTime.getFullYear() < 2020)) {
      s.logoutTime = undefined;
      s.logoutBy = undefined;
    }
  }

  // Record-level logout values (punchOut from selfie app, logoutTime from CRM) -> attach to the right session
  const candidates = [rec.punchOut, rec.logoutTime]
    .map((v) => toValidAttendanceDate(v, dateStr))
    .filter((d): d is Date => d instanceof Date && d.getFullYear() >= 2020)
    .sort((a, b) => a.getTime() - b.getTime())
    .filter((d, i, arr) => {
      const prev = arr[i - 1];
      return !prev || Math.abs(d.getTime() - prev.getTime()) > 5000;
    });

  for (const c of candidates) {
    const ct = c.getTime();
    for (let i = 0; i < sessions.length; i++) {
      const curr = sessions[i];
      if (!curr) continue;
      const start = curr.loginTime.getTime();
      const next = sessions[i + 1]?.loginTime.getTime();
      if (ct > start + 3000 && (next === undefined || ct <= next)) {
        if (!curr.logoutTime) {
          curr.logoutTime = c;
          curr.logoutBy = rec.logoutBy || 'EMPLOYEE';
          if (rec.logoutBy === 'ADMIN') curr.logoutAdminName = rec.logoutAdminName;
        }
        break;
      }
    }
  }

  const last = sessions[sessions.length - 1];
  const isCurrentlyActive = Boolean(last && !last.logoutTime);

  return {
    ...rec,
    loginTime: sessions[0]?.loginTime ?? rec.loginTime,
    logoutTime: last?.logoutTime,
    logoutBy: last?.logoutTime ? last.logoutBy || rec.logoutBy || 'EMPLOYEE' : undefined,
    loginEvents: sessions,
    loginCount: sessions.length,
    logoutCount: sessions.filter((s) => s.logoutTime).length,
    isCurrentlyActive,
  };
}

export function formatSecondsToDuration(totalSeconds: number): string {
  const secs = Math.max(0, Math.floor(totalSeconds));
  if (secs < 60) {
    return `${secs}s`;
  }
  const mins = Math.floor(secs / 60);
  const remainingSecs = secs % 60;
  if (mins < 60) {
    return remainingSecs > 0 ? `${mins}m ${remainingSecs}s` : `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m ${remainingSecs}s`;
}

export class AttendanceService {
  /**
   * Helper to get current calendar date string in YYYY-MM-DD
   */
  public getTodayDateString(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  /**
   * Records every successful employee sign-in as an event on that day's attendance record.
   */
  async recordLogin(input: RecordLoginInput): Promise<IAttendance> {
    const today = this.getTodayDateString();
    const now = new Date();
    const timeParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(timeParts.find((part) => part.type === 'hour')?.value || 0);
    const minute = Number(timeParts.find((part) => part.type === 'minute')?.value || 0);
    const second = Number(timeParts.find((part) => part.type === 'second')?.value || 0);

    // Official checkin time is 10:00 AM IST. Any check-in after 10:05 AM is recorded as HALF_DAY
    const isAfter1005 = hour > 10 || (hour === 10 && (minute > 5 || (minute === 5 && second > 0)));
    const status: AttendanceStatus = isAfter1005 ? 'HALF_DAY' : 'PRESENT';
    const attendanceQuery = {
      organizationId: input.organizationId,
      userId: input.userId,
      date: today,
    };
    const loginEvent = {
      loginTime: now,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    };

    let record: any = null;

    // Check if employee has an active/pending Admin Logout or ongoing Lunch Break
    const existing = await AttendanceModel.findOne(attendanceQuery);
    if (existing) {
      const lastEvent = existing.loginEvents && existing.loginEvents.length > 0
        ? existing.loginEvents[existing.loginEvents.length - 1]
        : null;

      const adminLogoutTimestamp = existing.adminLogoutAt || (lastEvent?.logoutBy === 'ADMIN' ? lastEvent.logoutTime : null);

      // Auto-complete any active/ongoing lunch break when employee punches in / logs in!
      if (existing.isOnLunch || (existing.lunchBreaks && existing.lunchBreaks.some((b) => b.status === 'ONGOING' || !b.endTime))) {
        const activeBreak = [...existing.lunchBreaks].reverse().find(
          (b) => b.status === 'ONGOING' || !b.endTime
        );
        if (activeBreak) {
          activeBreak.endTime = now;
          activeBreak.status = 'COMPLETED';
          const durationSec = Math.max(0, Math.round((now.getTime() - new Date(activeBreak.startTime).getTime()) / 1000));
          activeBreak.durationSeconds = durationSec;
          activeBreak.durationFormatted = formatSecondsToDuration(durationSec);
        }
        let totalLunchSec = 0;
        for (const b of existing.lunchBreaks) {
          totalLunchSec += b.durationSeconds || 0;
        }
        existing.totalLunchDurationSeconds = totalLunchSec;
        existing.lunchDurationFormatted = formatSecondsToDuration(totalLunchSec);
        existing.isOnLunch = false;
        existing.currentLunchStart = undefined as any;
        await existing.save();
      }

      if (adminLogoutTimestamp && (existing.isAwayPending || (lastEvent && lastEvent.logoutBy === 'ADMIN' && !lastEvent.reLoginTime))) {
        const awayDurationSec = Math.max(0, Math.round((now.getTime() - new Date(adminLogoutTimestamp).getTime()) / 1000));
        const awayFormatted = formatSecondsToDuration(awayDurationSec);

        if (lastEvent) {
          lastEvent.reLoginTime = now;
          lastEvent.awayDurationSeconds = awayDurationSec;
          lastEvent.awayDurationFormatted = awayFormatted;
        }

        existing.adminLogoutReLoginAt = now;
        existing.totalAwayDurationSeconds = (existing.totalAwayDurationSeconds || 0) + awayDurationSec;
        existing.awayDurationFormatted = formatSecondsToDuration(existing.totalAwayDurationSeconds);
        existing.isAwayPending = false;
        existing.logoutTime = undefined as any;
        existing.logoutBy = undefined as any;
        existing.logoutAdminName = undefined as any;
        existing.lastActiveAt = now;
        existing.loginEvents.push(loginEvent as any);
        await existing.save();
        record = existing;
      }
    }

    if (!record) {
      const update = {
        $setOnInsert: {
          ...attendanceQuery,
          loginTime: now,
          status,
        },
        $set: {
          lastActiveAt: now,
          employeeId: input.employeeId,
          userName: input.name,
          userEmail: input.email,
          userPhone: input.phone || '',
          role: input.role,
          department: input.department || 'Sales & Business Development',
          ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
          ...(input.userAgent ? { userAgent: input.userAgent } : {}),
        },
        $unset: {
          logoutTime: 1,
          logoutBy: 1,
          logoutAdminName: 1,
        },
        $push: { loginEvents: loginEvent },
      };
      try {
        record = await AttendanceModel.findOneAndUpdate(
          attendanceQuery,
          update,
          { new: true, upsert: true, setDefaultsOnInsert: true }
        );
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        record = await AttendanceModel.findOneAndUpdate(
          attendanceQuery,
          update,
          { new: true }
        );
        if (!record) throw error;
      }
    }

    if (!record) {
      throw AppError.internal('Failed to record attendance');
    }

    logger.info(`✅ Login recorded: ${input.name} (${status}) on ${today} at ${now.toLocaleTimeString()}`);

    try {
      const attendancePayload = {
        id: record._id.toString(),
        userId: record.userId,
        employeeId: record.employeeId,
        userName: record.userName,
        userEmail: record.userEmail,
        userPhone: record.userPhone,
        department: record.department,
        role: record.role,
        date: record.date,
        loginTime: now,
        status: record.status,
        loginCount: record.loginEvents.length,
      };

      emitTenantEvent(input.organizationId, 'attendance:login', attendancePayload);

      emitTenantEvent(input.organizationId, 'notification:new', {
        id: `att_${Date.now()}`,
        type: 'attendance',
        title: `Employee Login: ${record.userName}`,
        message: `${record.userName} logged in at ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} [${status}]`,
        severity: status === 'HALF_DAY' ? 'warning' : 'success',
        link: '/attendance',
        timestamp: now.toISOString(),
      });
    } catch (e: any) {
      logger.warn('Socket broadcast for attendance skipped:', e.message);
    }

    return record;
  }

  private lastSyncTime: number = 0;
  private isSyncing: boolean = false;

  /**
   * Synchronize attendance records from external Attendance CRM app (atendence-crm.vercel.app)
   */
  async syncExternalAttendance(
    organizationId: string,
    isManualTrigger: boolean = false
  ): Promise<{ syncedCount: number; message: string }> {
    if (this.isSyncing) {
      return { syncedCount: 0, message: 'Sync operation already running in background.' };
    }
    this.isSyncing = true;
    try {
      const targetOrgId = organizationId || 'org_advmen_platform';
      const users = await UserModel.find({}).lean();
      let count = 0;

      if (mongoose.connection?.db) {
        try {
          // Step 0: Sanitize any existing string logoutTime and loginTime in attendances collection
          try {
            const badLogoutDocs = await mongoose.connection.db
              .collection('attendances')
              .find({ logoutTime: { $type: 'string' } })
              .toArray();

            for (const bDoc of badLogoutDocs) {
              const validD = toValidAttendanceDate(bDoc.logoutTime, bDoc.date);
              if (validD) {
                await mongoose.connection.db
                  .collection('attendances')
                  .updateOne({ _id: bDoc._id }, { $set: { logoutTime: validD } });
              } else {
                await mongoose.connection.db
                  .collection('attendances')
                  .updateOne({ _id: bDoc._id }, { $unset: { logoutTime: 1 } });
              }
            }

            const badLoginDocs = await mongoose.connection.db
              .collection('attendances')
              .find({ loginTime: { $type: 'string' } })
              .toArray();

            for (const bDoc of badLoginDocs) {
              const validD = toValidAttendanceDate(bDoc.loginTime, bDoc.date) || new Date();
              await mongoose.connection.db
                .collection('attendances')
                .updateOne({ _id: bDoc._id }, { $set: { loginTime: validD } });
            }
          } catch (sanitizeErr: any) {
            logger.warn('Date sanitization note:', sanitizeErr.message);
          }

          // Step 1: Find candidate documents to sync from attendance app
          const rawExternalDocs = await mongoose.connection.db
            .collection('attendances')
            .find({
              $or: [
                { organizationId: { $exists: false } },
                { organizationId: null },
                { organizationId: '' },
                { userId: { $exists: false } },
                { userId: null },
                { userId: '' },
                { source: 'EXTERNAL_ATTENDANCE_APP' },
                { source: { $exists: false } },
              ],
            })
            .limit(500)
            .toArray();

          if (rawExternalDocs.length > 0) {
            const bulkOps: any[] = [];

            for (const doc of rawExternalDocs) {
              try {
                const rawEmpId = String(doc.empId || doc.employeeId || '').trim();
                const rawEmpName = String(doc.empName || doc.userName || doc.name || '').trim();
                const rawEmail = String(doc.email || doc.userEmail || '').trim().toLowerCase();

                const locationAddress = String(doc.location?.address || '').trim();
                const isPortalLogout = locationAddress.toLowerCase() === 'logged out from portal';
                if (isPortalLogout && !doc.punchIn && !doc.loginTime) {
                  continue;
                }

                // Clean and normalize date
                let dateStr = doc.date ? String(doc.date).trim() : '';
                if (/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.test(dateStr)) {
                  const parts = dateStr.split(/[\/\-]/);
                  dateStr = `${parts[2]}-${pad2(Number(parts[1]))}-${pad2(Number(parts[0]))}`;
                }
                if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                  dateStr = new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'Asia/Kolkata',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                  }).format(new Date());
                }

                // Safely convert punchIn and punchOut to Date objects
                const punchInDate =
                  toValidAttendanceDate(doc.punchIn, dateStr) ||
                  toValidAttendanceDate(doc.loginTime, dateStr) ||
                  toValidAttendanceDate(doc.createdAt, dateStr) ||
                  new Date();

                const punchOutCandidate =
                  toValidAttendanceDate(doc.punchOut, dateStr) ||
                  toValidAttendanceDate(doc.logoutTime, dateStr);

                let finalLogout: Date | undefined = punchOutCandidate;
                if (punchOutCandidate && punchInDate) {
                  const diffMs = Math.abs(punchOutCandidate.getTime() - punchInDate.getTime());
                  if (diffMs <= 3000 || punchOutCandidate.getFullYear() < 2020) {
                    finalLogout = undefined;
                  }
                }

                // Match user from users collection
                let matchedUser = users.find(
                  (u) =>
                    (rawEmail && u.email && u.email.toLowerCase() === rawEmail) ||
                    (rawEmpId && u.employeeId && u.employeeId.toUpperCase() === rawEmpId.toUpperCase()) ||
                    (rawEmpId && (u as any).empId && (u as any).empId.toUpperCase() === rawEmpId.toUpperCase()) ||
                    (rawEmpName && u.name && u.name.toLowerCase() === rawEmpName.toLowerCase())
                );

                // Fuzzy match fallback
                if (!matchedUser && rawEmpName) {
                  const cleanTarget = rawEmpName.toLowerCase().replace(/[^a-z0-9]/g, '');
                  matchedUser = users.find((u) => {
                    const cleanU = (u.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                    return cleanU && (cleanU === cleanTarget || cleanU.includes(cleanTarget) || cleanTarget.includes(cleanU));
                  });
                }

                const userOrgId = matchedUser?.organizationId || doc.organizationId || targetOrgId;
                const targetUserId = matchedUser
                  ? matchedUser._id.toString()
                  : doc.userId
                  ? String(doc.userId)
                  : `ext_${rawEmpId || doc._id.toString()}`;

                const finalEmpId = matchedUser?.employeeId || rawEmpId || (doc.userId ? String(doc.userId).slice(-6) : 'EMP');
                const finalUserName = matchedUser?.name || rawEmpName || 'Employee';
                const finalEmail = matchedUser?.email || rawEmail || `${finalUserName.replace(/\s+/g, '.').toLowerCase()}@advmen.local`;
                const finalRole = matchedUser?.role || doc.role || 'SALES_REP';
                const finalDepartment = matchedUser?.department || doc.department || 'Sales & Business Development';

                const loginEvent = {
                  loginTime: punchInDate,
                  logoutTime: finalLogout,
                  logoutBy: finalLogout ? 'EMPLOYEE' : undefined,
                  ipAddress: 'Selfie + GPS',
                  userAgent: doc.location?.address || 'Attendance CRM Web App',
                };

                const updateFields: any = {
                  organizationId: userOrgId,
                  userId: targetUserId,
                  employeeId: finalEmpId,
                  userName: finalUserName,
                  userEmail: finalEmail,
                  userPhone: matchedUser?.phone || doc.userPhone || doc.phone || '',
                  role: finalRole,
                  department: finalDepartment,
                  date: dateStr,
                  loginTime: punchInDate,
                  status: doc.status ? String(doc.status).toUpperCase() : 'PRESENT',
                  externalRecordId: doc._id.toString(),
                  source: 'EXTERNAL_ATTENDANCE_APP',
                  lastActiveAt: finalLogout || punchInDate,
                };

                if (finalLogout) {
                  updateFields.logoutTime = finalLogout;
                }

                if (typeof doc.imageUrl === 'string' && doc.imageUrl.trim()) {
                  updateFields.selfieUrl = doc.imageUrl.startsWith('/')
                    ? `https://atendence-crm.vercel.app${doc.imageUrl}`
                    : doc.imageUrl;
                }

                if (doc.workReport) updateFields.workReport = doc.workReport;
                if (doc.workCategory) updateFields.workCategory = doc.workCategory;
                if (doc.developmentChanges) updateFields.developmentChanges = doc.developmentChanges;
                if (doc.taskSummary) updateFields.taskSummary = doc.taskSummary;
                if (doc.reportSubmittedAt) updateFields.reportSubmittedAt = doc.reportSubmittedAt;
                if (doc.punchOutImageUrl) {
                  updateFields.punchOutImageUrl = doc.punchOutImageUrl.startsWith('/')
                    ? `https://atendence-crm.vercel.app${doc.punchOutImageUrl}`
                    : doc.punchOutImageUrl;
                }
                if (doc.logoutLocation) updateFields.logoutLocation = doc.logoutLocation;
                if (doc.location) updateFields.location = doc.location;

                // Check for existing record to merge into
                const existing = await mongoose.connection.db.collection('attendances').findOne({
                  organizationId: userOrgId,
                  userId: targetUserId,
                  date: dateStr,
                  _id: { $ne: doc._id },
                });

                if (existing) {
                  const existingEvents = Array.isArray(existing.loginEvents) ? existing.loginEvents : [];
                  const alreadyHasEvent = existingEvents.some(
                    (e: any) => Math.abs(new Date(e.loginTime).getTime() - punchInDate.getTime()) < 5000
                  );
                  if (!alreadyHasEvent) {
                    existingEvents.push(loginEvent);
                  }

                  const mergedLogout = finalLogout || toValidAttendanceDate(existing.logoutTime, dateStr);

                  await mongoose.connection.db.collection('attendances').updateOne(
                    { _id: existing._id },
                    {
                      $set: {
                        ...updateFields,
                        loginEvents: existingEvents,
                        ...(mergedLogout ? { logoutTime: mergedLogout } : {}),
                        selfieUrl: existing.selfieUrl || updateFields.selfieUrl,
                      },
                    }
                  );
                  await mongoose.connection.db.collection('attendances').deleteOne({ _id: doc._id });
                  count++;
                } else {
                  const updateOp: any = {
                    $set: {
                      ...updateFields,
                      loginEvents: [loginEvent],
                    },
                  };
                  if (!finalLogout) {
                    updateOp.$unset = { logoutTime: 1 };
                  }
                  bulkOps.push({
                    updateOne: {
                      filter: { _id: doc._id },
                      update: updateOp,
                    },
                  });
                }
              } catch (docErr: any) {
                logger.warn(`Error processing attendance doc ${doc._id}:`, docErr.message);
              }
            }

            if (bulkOps.length > 0) {
              await mongoose.connection.db
                .collection('attendances')
                .bulkWrite(bulkOps, { ordered: false });
              count += bulkOps.length;
              logger.info(`✅ Synchronized ${count} attendance records via lightweight bulkWrite.`);
            }

            await this.deduplicateAttendanceRecords(targetOrgId);

            // Auto-populate / sync dedicated 'reports' collection from attendance records
            const reportsToSync = await AttendanceModel.find({
              $or: [
                { workReport: { $exists: true, $nin: ['', null] } },
                { workCategory: { $exists: true, $nin: ['', null] } },
              ],
            }).lean();

            for (const r of (reportsToSync as any[])) {
              if (!r.userId || (!r.workReport && !r.workCategory)) continue;
              await ReportModel.updateOne(
                { organizationId: r.organizationId, userId: r.userId, date: r.date },
                {
                  $set: {
                    organizationId: r.organizationId,
                    userId: r.userId,
                    employeeId: r.employeeId || 'EMP',
                    userName: r.userName || 'Employee',
                    userEmail: r.userEmail || '',
                    department: r.department || 'General',
                    role: r.role || 'EMPLOYEE',
                    date: r.date,
                    workCategory: r.workCategory || 'General Work',
                    workReport: r.workReport || '',
                    developmentChanges: r.developmentChanges || '',
                    taskSummary: r.taskSummary || '',
                    punchInTime: r.loginTime,
                    punchOutTime: r.logoutTime,
                    shiftDurationSeconds: r.shiftDurationSeconds || 0,
                    shiftDurationFormatted: r.shiftDurationFormatted || '-',
                    selfieUrl: r.selfieUrl,
                    punchOutImageUrl: r.punchOutImageUrl,
                    location: r.location,
                    logoutLocation: r.logoutLocation,
                    submittedAt: r.reportSubmittedAt || r.logoutTime || r.createdAt || new Date(),
                    source: 'ATTENDANCE_PUNCHOUT',
                  },
                },
                { upsert: true }
              ).catch(() => {});
            }
          }
        } catch (dbErr: any) {
          logger.warn('Direct database attendance sync note:', dbErr.message);
        }
      }

      // Step 2: Fetch external HTTP attendance endpoints if available
      try {
        const endpoints = [
          'https://atendence-crm.vercel.app/api/attendance/all',
          'https://atendence-crm.vercel.app/api/attendance/logs',
        ];

        let rawData: any[] = [];
        for (const endpoint of endpoints) {
          try {
            const res = await fetch(endpoint, {
              headers: { Accept: 'application/json' },
              signal: AbortSignal.timeout(3000),
            });
            if (res.ok) {
              const json = (await res.json()) as any;
              const items = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
              if (items.length > 0) {
                rawData.push(...items);
              }
            }
          } catch {
            // Optional fallback
          }
        }

        if (rawData.length > 0 && mongoose.connection?.db) {
          logger.info(`External HTTP fetched ${rawData.length} candidate items. Ingesting...`);
          for (const item of rawData) {
            try {
              const itemEmpId = String(item.empId || item.employeeId || '').trim();
              const itemEmpName = String(item.empName || item.userName || item.name || '').trim();
              const itemEmail = String(item.email || item.userEmail || '').trim().toLowerCase();
              if (!itemEmpId && !itemEmpName && !itemEmail) continue;

              let itemDateStr = item.date ? String(item.date).trim() : '';
              if (/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.test(itemDateStr)) {
                const parts = itemDateStr.split(/[\/\-]/);
                itemDateStr = `${parts[2]}-${pad2(Number(parts[1]))}-${pad2(Number(parts[0]))}`;
              }
              if (!/^\d{4}-\d{2}-\d{2}$/.test(itemDateStr)) {
                itemDateStr = this.getTodayDateString();
              }

              const itemPunchIn = toValidAttendanceDate(item.punchIn || item.loginTime, itemDateStr) || new Date();
              const itemPunchOut = toValidAttendanceDate(item.punchOut || item.logoutTime, itemDateStr);

              let matchedU = users.find(
                (u) =>
                  (itemEmail && u.email && u.email.toLowerCase() === itemEmail) ||
                  (itemEmpId && u.employeeId && u.employeeId.toUpperCase() === itemEmpId.toUpperCase()) ||
                  (itemEmpName && u.name && u.name.toLowerCase() === itemEmpName.toLowerCase())
              );

              const itemUserId = matchedU ? matchedU._id.toString() : `ext_${itemEmpId || item._id || Date.now()}`;
              const itemUserName = matchedU?.name || itemEmpName || 'Employee';
              const itemUserEmail = matchedU?.email || itemEmail || `${itemUserName.replace(/\s+/g, '.').toLowerCase()}@advmen.local`;

              await mongoose.connection.db.collection('attendances').updateOne(
                {
                  organizationId: targetOrgId,
                  userId: itemUserId,
                  date: itemDateStr,
                },
                {
                  $set: {
                    organizationId: targetOrgId,
                    userId: itemUserId,
                    employeeId: matchedU?.employeeId || itemEmpId || 'EMP',
                    userName: itemUserName,
                    userEmail: itemUserEmail,
                    role: matchedU?.role || item.role || 'SALES_REP',
                    department: matchedU?.department || item.department || 'Sales & Business Development',
                    date: itemDateStr,
                    loginTime: itemPunchIn,
                    status: item.status ? String(item.status).toUpperCase() : 'PRESENT',
                    source: 'EXTERNAL_ATTENDANCE_APP',
                    lastActiveAt: itemPunchOut || itemPunchIn,
                    ...(itemPunchOut ? { logoutTime: itemPunchOut } : {}),
                    ...(item.imageUrl ? { selfieUrl: item.imageUrl.startsWith('/') ? `https://atendence-crm.vercel.app${item.imageUrl}` : item.imageUrl } : {}),
                    ...(item.workReport ? { workReport: item.workReport } : {}),
                    ...(item.workCategory ? { workCategory: item.workCategory } : {}),
                    ...(item.taskSummary ? { taskSummary: item.taskSummary } : {}),
                    ...(item.developmentChanges ? { developmentChanges: item.developmentChanges } : {}),
                    ...(item.punchOutImageUrl ? { punchOutImageUrl: item.punchOutImageUrl.startsWith('/') ? `https://atendence-crm.vercel.app${item.punchOutImageUrl}` : item.punchOutImageUrl } : {}),
                    ...(item.location ? { location: item.location } : {}),
                    ...(item.logoutLocation ? { logoutLocation: item.logoutLocation } : {}),
                  },
                  $setOnInsert: {
                    loginEvents: [{
                      loginTime: itemPunchIn,
                      logoutTime: itemPunchOut,
                      logoutBy: itemPunchOut ? 'EMPLOYEE' : undefined,
                      ipAddress: 'Selfie + GPS',
                      userAgent: item.location?.address || 'Attendance CRM Web App',
                    }],
                  },
                },
                { upsert: true }
              );
              count++;
            } catch {
              // ignore single item HTTP sync err
            }
          }
        }
      } catch (httpErr: any) {
        logger.warn('External HTTP sync note:', httpErr.message);
      }

      this.lastSyncTime = Date.now();
      return { syncedCount: count, message: `Successfully synced ${count} records from attendance database.` };
    } catch (error: any) {
      logger.error('Error syncing external attendance:', error);
      return { syncedCount: 0, message: error.message };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Deduplicate attendance records ensuring only 1 record per employee per day.
   */
  async deduplicateAttendanceRecords(organizationId?: string): Promise<{ mergedCount: number; deletedCount: number }> {
    if (!mongoose.connection?.db) return { mergedCount: 0, deletedCount: 0 };
    const col = mongoose.connection.db.collection('attendances');

    const matchQuery: Record<string, any> = {
      userId: { $exists: true, $ne: null },
      date: { $exists: true, $ne: null },
    };
    if (organizationId) matchQuery.organizationId = organizationId;

    try {
      const duplicates = await col.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: {
              organizationId: '$organizationId',
              userId: '$userId',
              date: '$date',
            },
            count: { $sum: 1 },
            docs: {
              $push: {
                _id: '$_id',
                loginTime: '$loginTime',
                logoutTime: '$logoutTime',
                lastActiveAt: '$lastActiveAt',
                loginEvents: '$loginEvents',
                selfieUrl: '$selfieUrl',
                status: '$status',
                userName: '$userName',
              },
            },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ], { allowDiskUse: true }).toArray();

      let mergedCount = 0;
      let deletedCount = 0;

      for (const group of duplicates) {
        const docs = group.docs;
        docs.sort((a: any, b: any) => new Date(a.loginTime || 0).getTime() - new Date(b.loginTime || 0).getTime());

        const primaryDoc = docs[0];
        const duplicateIds = docs.slice(1).map((d: any) => d._id);

        const mergedEvents: any[] = [];
        for (const d of docs) {
          if (Array.isArray(d.loginEvents) && d.loginEvents.length > 0) {
            mergedEvents.push(...d.loginEvents);
          } else if (d.loginTime) {
            mergedEvents.push({
              loginTime: d.loginTime,
              logoutTime: d.logoutTime,
              ipAddress: 'Merged Punch',
              userAgent: 'Attendance System',
            });
          }
        }

        const uniqueEvents: any[] = [];
        for (const ev of mergedEvents) {
          const evTime = new Date(ev.loginTime).getTime();
          const exists = uniqueEvents.some(
            (u) => Math.abs(new Date(u.loginTime).getTime() - evTime) < 5000
          );
          if (!exists) {
            uniqueEvents.push(ev);
          }
        }

        let latestLogout: Date | undefined = undefined;
        let latestActive: Date = new Date(primaryDoc.lastActiveAt || primaryDoc.loginTime);

        for (const d of docs) {
          if (d.logoutTime) {
            const lDate = new Date(d.logoutTime);
            if (lDate.getFullYear() >= 2020 && (!latestLogout || lDate.getTime() > latestLogout.getTime())) {
              latestLogout = lDate;
            }
          }
          if (d.lastActiveAt) {
            const aDate = new Date(d.lastActiveAt);
            if (aDate.getTime() > latestActive.getTime()) {
              latestActive = aDate;
            }
          }
        }

        const bestSelfie = docs.find((d: any) => d.selfieUrl && d.selfieUrl.length > 10)?.selfieUrl;

        const updateFields: any = {
          loginEvents: uniqueEvents,
          lastActiveAt: latestActive,
        };
        if (latestLogout) {
          updateFields.logoutTime = latestLogout;
        }
        if (bestSelfie && !primaryDoc.selfieUrl) {
          updateFields.selfieUrl = bestSelfie;
        }

        const docWithReport = docs.find((d: any) => d.workReport || d.workCategory || d.developmentChanges);
        if (docWithReport) {
          if (docWithReport.workReport) updateFields.workReport = docWithReport.workReport;
          if (docWithReport.workCategory) updateFields.workCategory = docWithReport.workCategory;
          if (docWithReport.developmentChanges) updateFields.developmentChanges = docWithReport.developmentChanges;
          if (docWithReport.taskSummary) updateFields.taskSummary = docWithReport.taskSummary;
          if (docWithReport.reportSubmittedAt) updateFields.reportSubmittedAt = docWithReport.reportSubmittedAt;
          if (docWithReport.punchOutImageUrl) updateFields.punchOutImageUrl = docWithReport.punchOutImageUrl;
          if (docWithReport.logoutLocation) updateFields.logoutLocation = docWithReport.logoutLocation;
        }

        await col.updateOne({ _id: primaryDoc._id }, { $set: updateFields });

        if (duplicateIds.length > 0) {
          const delRes = await col.deleteMany({ _id: { $in: duplicateIds } });
          deletedCount += delRes.deletedCount || 0;
        }
        mergedCount++;
      }

      if (mergedCount > 0) {
        logger.info(`🧹 Merged ${mergedCount} employee duplicate attendance records, deleted ${deletedCount} redundant rows.`);
      }

      return { mergedCount, deletedCount };
    } catch (err: any) {
      logger.warn('Deduplication note:', err.message);
      return { mergedCount: 0, deletedCount: 0 };
    }
  }

  /**
   * Retrieves attendance records with advanced filtering, pagination, and today summary analytics.
   * Guarantees 1 single consolidated row per employee per day.
   */
  async getAttendanceList(
    organizationId: string,
    filters: AttendanceFilterQuery,
    isSuperAdmin: boolean = false
  ): Promise<{
    records: IAttendance[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    summary: {
      totalEmployees: number;
      presentToday: number;
      lateToday: number;
      absentToday: number;
      attendanceRate: number;
      selectedDate: string;
    };
  }> {
    if (Date.now() - this.lastSyncTime > 15000 && !this.isSyncing) {
      this.syncExternalAttendance(organizationId, false).catch((err) => {
        logger.warn('External attendance auto-sync note:', err.message);
      });
    }

    const selectedDate = filters.date && filters.date !== 'ALL' ? filters.date : this.getTodayDateString();
    const query: Record<string, any> = {};

    if (!isSuperAdmin && organizationId) {
      query.organizationId = filters.search && filters.search.startsWith('org_') ? filters.search : organizationId;
    } else if (filters.search && filters.search.startsWith('org_')) {
      query.organizationId = filters.search;
    }

    if (filters.date) {
      if (filters.date !== 'ALL') {
        const dateVal = filters.date;
        const dateParts = dateVal.split('-');
        if (dateParts.length === 3 && dateParts[0].length === 4) {
          const altDate1 = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
          const altDate2 = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
          query.date = { $in: [dateVal, altDate1, altDate2] };
        } else {
          query.date = dateVal;
        }
      }
    } else if (filters.startDate && filters.endDate) {
      query.date = { $gte: filters.startDate, $lte: filters.endDate };
    } else {
      const todayParts = selectedDate.split('-');
      if (todayParts.length === 3 && todayParts[0].length === 4) {
        const altToday1 = `${todayParts[2]}-${todayParts[1]}-${todayParts[0]}`;
        const altToday2 = `${todayParts[2]}/${todayParts[1]}/${todayParts[0]}`;
        query.date = { $in: [selectedDate, altToday1, altToday2] };
      } else {
        query.date = selectedDate;
      }
    }

    if (filters.userId) query.userId = filters.userId;
    if (filters.status) query.status = filters.status;
    if (filters.department && filters.department !== 'ALL') query.department = filters.department;

    if (filters.search && !filters.search.startsWith('org_')) {
      const regex = new RegExp(filters.search.trim(), 'i');
      query.$or = [
        { userName: regex },
        { userEmail: regex },
        { userPhone: regex },
        { department: regex },
        { employeeId: regex },
      ];
    }

    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(Math.max(1, Number(filters.limit) || 50), 100);
    const skip = (page - 1) * limit;

    const orgFilter = !isSuperAdmin ? { organizationId } : {};

    const [records, totalCountResult, totalStaff, todayStats] = await Promise.all([
      AttendanceModel.aggregate([
        { $match: query },
        { $sort: { loginTime: -1 } },
        {
          $group: {
            _id: {
              organizationId: '$organizationId',
              userId: { $ifNull: ['$userId', { $ifNull: ['$employeeId', { $toString: '$_id' }] }] },
              date: '$date',
            },
            doc: { $first: '$$ROOT' },
          },
        },
        { $replaceRoot: { newRoot: '$doc' } },
        { $sort: { loginTime: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $project: {
            organizationId: 1,
            userId: 1,
            employeeId: 1,
            userName: 1,
            userEmail: 1,
            userPhone: 1,
            role: 1,
            department: 1,
            date: 1,
            loginTime: 1,
            lastActiveAt: 1,
            logoutTime: 1,
            logoutBy: 1,
            logoutAdminName: 1,
            adminLogoutAt: 1,
            adminLogoutBy: 1,
            adminLogoutReLoginAt: 1,
            totalAwayDurationSeconds: 1,
            awayDurationFormatted: 1,
            isAwayPending: 1,
            loginEvents: 1,
            lunchBreaks: 1,
            totalLunchDurationSeconds: 1,
            lunchDurationFormatted: 1,
            isOnLunch: 1,
            currentLunchStart: 1,
            status: 1,
            location: 1,
            source: 1,
            externalRecordId: 1,
            ipAddress: 1,
            userAgent: 1,
            createdAt: 1,
            updatedAt: 1,
            workReport: 1,
            workCategory: 1,
            developmentChanges: 1,
            taskSummary: 1,
            reportSubmittedAt: 1,
            punchOutImageUrl: 1,
            logoutLocation: 1,
            hasSelfie: {
              $cond: {
                if: {
                  $gt: [
                    {
                      $strLenCP: {
                        $substrCP: [
                          {
                            $ifNull: [
                              '$selfieUrl',
                              { $ifNull: ['$selfie', { $ifNull: ['$selfieData', ''] }] },
                            ],
                          },
                          0,
                          50,
                        ],
                      },
                    },
                    20,
                  ],
                },
                then: true,
                else: false,
              },
            },
          },
        },
      ], { allowDiskUse: true }),
      AttendanceModel.aggregate([
        { $match: query },
        {
          $group: {
            _id: {
              organizationId: '$organizationId',
              userId: { $ifNull: ['$userId', { $ifNull: ['$employeeId', { $toString: '$_id' }] }] },
              date: '$date',
            },
          },
        },
        { $count: 'count' },
      ], { allowDiskUse: true }),
      UserModel.countDocuments({
        ...orgFilter,
        isActive: true,
        role: { $nin: ['SUPER_ADMIN', 'ORG_ADMIN'] },
      }),
      AttendanceModel.aggregate([
        {
          $match: {
            ...orgFilter,
            date: {
              $in: [
                selectedDate,
                `${selectedDate.split('-')[2] || ''}-${selectedDate.split('-')[1] || ''}-${selectedDate.split('-')[0] || ''}`,
                `${selectedDate.split('-')[2] || ''}/${selectedDate.split('-')[1] || ''}/${selectedDate.split('-')[0] || ''}`,
              ].filter(Boolean),
            },
          },
        },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ], { allowDiskUse: true }),
    ]);

    const total = totalCountResult && totalCountResult[0]?.count ? Number(totalCountResult[0].count) : 0;

    let presentToday = 0;
    let lateToday = 0;

    todayStats.forEach((st) => {
      if (st._id === 'PRESENT') presentToday += st.count;
      else if (st._id === 'LATE' || st._id === 'HALF_DAY') lateToday += st.count;
    });

    const totalMarked = presentToday + lateToday;
    const absentToday = Math.max(0, totalStaff - totalMarked);
    const attendanceRate = totalStaff > 0 ? Math.round((totalMarked / totalStaff) * 100) : 0;

    const sanitizedRecords = records.map((rec: any) => ({
      ...rec,
      selfieUrl: rec.hasSelfie ? `/api/v1/attendance/${rec._id}/selfie` : undefined,
    }));

    return {
      records: sanitizedRecords as unknown as IAttendance[],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      summary: {
        totalEmployees: totalStaff,
        presentToday,
        lateToday,
        absentToday,
        attendanceRate,
        selectedDate,
      },
    };
  }

  /**
   * Retrieves individual employee attendance history
   */
  async getEmployeeHistory(organizationId: string, userId: string, limit: number = 30): Promise<IAttendance[]> {
    const records = await AttendanceModel.find({ organizationId, userId })
      .select('-selfieUrl -selfieData -selfie')
      .sort({ date: -1 })
      .limit(limit)
      .lean();

    return records.map((rec: any) => ({
      ...rec,
      selfieUrl: `/api/v1/attendance/${rec._id}/selfie`,
    })) as unknown as IAttendance[];
  }

  /**
   * Record employee punch-out / logout with actor attribution (ADMIN or EMPLOYEE)
   */
  async recordLogout(
    organizationId: string,
    userId: string,
    logoutBy: 'ADMIN' | 'EMPLOYEE' | 'SYSTEM' = 'EMPLOYEE',
    adminName?: string
  ): Promise<IAttendance | null> {
    const today = this.getTodayDateString();
    let record = await AttendanceModel.findOne({
      organizationId,
      userId,
      date: today,
    }).sort({ loginTime: -1 });

    if (!record) {
      record = await AttendanceModel.findOne({
        organizationId,
        userId,
        logoutTime: { $exists: false },
      }).sort({ loginTime: -1 });
    }
    if (!record) return null;

    const now = new Date();
    const activeEvent = [...record.loginEvents].reverse().find((event) => !event.logoutTime);
    if (activeEvent) {
      activeEvent.logoutTime = now;
      activeEvent.logoutBy = logoutBy;
      activeEvent.logoutAdminName = adminName;
    }
    record.logoutTime = now;
    record.logoutBy = logoutBy;
    record.logoutAdminName = adminName;
    if (logoutBy === 'ADMIN') {
      record.adminLogoutAt = now;
      record.adminLogoutBy = adminName || 'Admin';
      record.isAwayPending = true;
    }
    await record.save();

    if (logoutBy === 'ADMIN') {
      try {
        const { authRepository } = await import('../auth/auth.repository.js');
        await authRepository.clearAllRefreshTokens(userId);
      } catch (err: any) {
        logger.warn('Token revocation note:', err.message);
      }

      emitTenantEvent(organizationId, 'auth:force-logout', {
        userId: record.userId,
        adminName: adminName || 'Admin',
        logoutTime: now.toISOString(),
      });
      emitUserEvent(record.userId, 'auth:force-logout', {
        userId: record.userId,
        adminName: adminName || 'Admin',
        logoutTime: now.toISOString(),
      });
    }

    try {
      emitTenantEvent(organizationId, 'attendance:logout', {
        id: record._id.toString(),
        userId: record.userId,
        userName: record.userName,
        logoutTime: now,
        logoutBy,
        logoutAdminName: adminName,
      });

      emitTenantEvent(organizationId, 'notification:new', {
        id: `att_logout_${Date.now()}`,
        type: 'attendance',
        title: `Employee Punch Out: ${record.userName}`,
        message: `${record.userName} logged out by ${logoutBy === 'ADMIN' ? `Admin (${adminName || 'Super Admin'})` : 'Employee'} at ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        severity: 'info',
        link: '/attendance',
        timestamp: now.toISOString(),
      });
    } catch (e: any) {
      logger.warn('Socket broadcast for attendance logout note:', e.message);
    }

    return record;
  }

  async deleteAttendanceRecord(organizationId: string, recordId: string, isSuperAdmin: boolean = false): Promise<boolean> {
    const query: Record<string, any> = { _id: recordId };
    if (!isSuperAdmin) {
      query.organizationId = organizationId;
    }
    const result = await AttendanceModel.deleteOne(query);
    return result.deletedCount > 0;
  }

  async clearAllAttendance(organizationId: string, isSuperAdmin: boolean = false): Promise<number> {
    const query: Record<string, any> = {};
    if (!isSuperAdmin) {
      query.organizationId = organizationId;
    }
    const result = await AttendanceModel.deleteMany(query);
    return result.deletedCount;
  }

  async startLunch(organizationId: string, userId: string, notes?: string): Promise<IAttendance> {
    const today = this.getTodayDateString();
    const now = new Date();

    let record = await AttendanceModel.findOne({ organizationId, userId, date: today });
    if (!record) {
      const user = await UserModel.findById(userId).lean();
      if (!user) {
        throw AppError.notFound('Employee record not found');
      }
      record = await AttendanceModel.create({
        organizationId,
        userId,
        employeeId: user.employeeId,
        userName: user.name,
        userEmail: user.email,
        userPhone: user.phone || '',
        role: user.role,
        department: user.department || 'Sales & Business Development',
        date: today,
        loginTime: now,
        lastActiveAt: now,
        status: 'PRESENT',
        loginEvents: [{ loginTime: now, ipAddress: 'Portal Login', userAgent: 'System' }],
        lunchBreaks: [],
        isOnLunch: false,
        totalLunchDurationSeconds: 0,
      });
    }

    if (record.isOnLunch) {
      return record;
    }

    const lunchBreak: IAttendanceLunchBreak = {
      startTime: now,
      status: 'ONGOING',
      notes: notes || 'Lunch break',
    };

    record.lunchBreaks.push(lunchBreak);
    record.isOnLunch = true;
    record.currentLunchStart = now;
    record.lastActiveAt = now;
    await record.save();

    try {
      emitTenantEvent(organizationId, 'attendance:lunch-start', {
        userId,
        userName: record.userName,
        startTime: now,
        notes,
      });

      emitTenantEvent(organizationId, 'notification:new', {
        id: `lunch_start_${Date.now()}`,
        type: 'attendance',
        title: `Lunch Break: ${record.userName}`,
        message: `${record.userName} started lunch at ${now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`,
        severity: 'info',
        link: '/attendance',
        timestamp: now.toISOString(),
      });
    } catch (e: any) {
      logger.warn('Socket broadcast for lunch start skipped:', e.message);
    }

    return record;
  }

  async endLunch(organizationId: string, userId: string): Promise<IAttendance> {
    const today = this.getTodayDateString();
    const now = new Date();

    const record = await AttendanceModel.findOne({ organizationId, userId, date: today });
    if (!record) {
      throw AppError.notFound('Today attendance record not found for employee');
    }

    const activeBreak = [...record.lunchBreaks].reverse().find(
      (b) => b.status === 'ONGOING' || !b.endTime
    );

    let durationSec = 0;
    if (activeBreak) {
      activeBreak.endTime = now;
      activeBreak.status = 'COMPLETED';
      durationSec = Math.max(0, Math.round((now.getTime() - new Date(activeBreak.startTime).getTime()) / 1000));
      activeBreak.durationSeconds = durationSec;
      activeBreak.durationFormatted = formatSecondsToDuration(durationSec);
    }

    let totalSec = 0;
    for (const b of record.lunchBreaks) {
      if (b.durationSeconds) {
        totalSec += b.durationSeconds;
      } else if (b.startTime && b.endTime) {
        totalSec += Math.max(0, Math.round((new Date(b.endTime).getTime() - new Date(b.startTime).getTime()) / 1000));
      }
    }

    record.totalLunchDurationSeconds = totalSec;
    record.lunchDurationFormatted = formatSecondsToDuration(totalSec);
    record.isOnLunch = false;
    record.currentLunchStart = undefined;
    record.lastActiveAt = now;
    await record.save();

    try {
      emitTenantEvent(organizationId, 'attendance:lunch-end', {
        userId,
        userName: record.userName,
        endTime: now,
        durationFormatted: activeBreak?.durationFormatted || '0s',
      });

      emitTenantEvent(organizationId, 'notification:new', {
        id: `lunch_end_${Date.now()}`,
        type: 'attendance',
        title: `Lunch Completed: ${record.userName}`,
        message: `${record.userName} completed lunch break (${activeBreak?.durationFormatted || '0s'})`,
        severity: 'success',
        link: '/attendance',
        timestamp: now.toISOString(),
      });
    } catch (e: any) {
      logger.warn('Socket broadcast for lunch end skipped:', e.message);
    }

    return record;
  }

  async getLunchStatus(organizationId: string, userId: string): Promise<{
    isOnLunch: boolean;
    currentLunchStart?: Date;
    lunchBreaks: IAttendanceLunchBreak[];
    totalLunchDurationSeconds: number;
    lunchDurationFormatted: string;
  }> {
    const today = this.getTodayDateString();
    const record = await AttendanceModel.findOne({ organizationId, userId, date: today }).lean();
    if (!record) {
      return {
        isOnLunch: false,
        lunchBreaks: [],
        totalLunchDurationSeconds: 0,
        lunchDurationFormatted: '0m',
      };
    }
    return {
      isOnLunch: Boolean(record.isOnLunch),
      currentLunchStart: record.currentLunchStart,
      lunchBreaks: record.lunchBreaks || [],
      totalLunchDurationSeconds: record.totalLunchDurationSeconds || 0,
      lunchDurationFormatted: record.lunchDurationFormatted || '0m',
    };
  }

  async manualRecordLunch(
    organizationId: string,
    userId: string,
    dateStr: string,
    startTimeStr: string,
    endTimeStr: string,
    notes?: string,
    isSuperAdmin: boolean = false
  ): Promise<IAttendance> {
    return this.recordManualLunch(organizationId, userId, dateStr, startTimeStr, endTimeStr, notes, isSuperAdmin);
  }

  async recordManualLunch(
    organizationId: string,
    userId: string,
    dateStr: string,
    startTimeStr: string,
    endTimeStr: string,
    notes?: string,
    isSuperAdmin: boolean = false
  ): Promise<IAttendance> {
    const start = toValidAttendanceDate(startTimeStr, dateStr);
    const end = toValidAttendanceDate(endTimeStr, dateStr);

    if (!start || !end) {
      throw AppError.badRequest('Invalid start or end time format. Example: 01:15 PM');
    }
    if (end.getTime() <= start.getTime()) {
      throw AppError.badRequest('End time must be after start time');
    }

    const durationSec = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
    const durationFormatted = formatSecondsToDuration(durationSec);

    const query: Record<string, any> = { userId, date: dateStr };
    if (organizationId && !isSuperAdmin) {
      query.organizationId = organizationId;
    }

    let record = await AttendanceModel.findOne(query);
    if (!record) {
      const user = await UserModel.findById(userId).lean();
      if (!user) {
        throw AppError.notFound('Employee not found');
      }
      record = await AttendanceModel.create({
        organizationId: organizationId || user.organizationId || 'org_advmen_platform',
        userId,
        employeeId: user.employeeId,
        userName: user.name,
        userEmail: user.email,
        userPhone: user.phone || '',
        role: user.role,
        department: user.department || 'Sales & Business Development',
        date: dateStr,
        loginTime: start,
        lastActiveAt: end,
        status: 'PRESENT',
        loginEvents: [],
        lunchBreaks: [],
        totalLunchDurationSeconds: 0,
      });
    }

    const newBreak: IAttendanceLunchBreak = {
      startTime: start,
      endTime: end,
      durationSeconds: durationSec,
      durationFormatted,
      notes: notes || 'Manual Admin Log',
      status: 'COMPLETED',
    };

    record.lunchBreaks = record.lunchBreaks || [];
    record.lunchBreaks.push(newBreak);

    let totalSec = 0;
    for (const b of record.lunchBreaks) {
      totalSec += b.durationSeconds || 0;
    }
    record.totalLunchDurationSeconds = totalSec;
    record.lunchDurationFormatted = formatSecondsToDuration(totalSec);
    await record.save();

    return record;
  }

  /**
   * Complete 30-day employee attendance and lunch history
   * Supports both (userId, monthStr) and (organizationId, userId, monthStr, isSuperAdmin)
   */
  async getEmployeeMonthlyHistory(
    organizationIdOrUserId: string,
    userIdOrMonth?: string,
    monthOrIsSuperAdmin?: string | boolean,
    isSuperAdmin: boolean = false
  ): Promise<any> {
    const isMultiTenantCall =
      Boolean(userIdOrMonth) &&
      (organizationIdOrUserId.startsWith('org_') ||
        typeof monthOrIsSuperAdmin === 'string' ||
        typeof monthOrIsSuperAdmin === 'boolean' ||
        isSuperAdmin !== false);

    const organizationId = isMultiTenantCall ? organizationIdOrUserId : undefined;
    const effectiveUserId = isMultiTenantCall ? userIdOrMonth! : organizationIdOrUserId;
    const targetMonthInput = isMultiTenantCall
      ? typeof monthOrIsSuperAdmin === 'string'
        ? monthOrIsSuperAdmin
        : undefined
      : userIdOrMonth;

    const user = await UserModel.findById(effectiveUserId).lean();
    if (!user) {
      throw AppError.notFound('Employee profile not found');
    }

    const targetMonth = targetMonthInput || this.getTodayDateString().slice(0, 7);
    const [yearNum, monthNum] = targetMonth.split('-').map(Number);
    const daysInMonth = new Date(yearNum, monthNum, 0).getDate();

    const startDate = `${targetMonth}-01`;
    const endDate = `${targetMonth}-${String(daysInMonth).padStart(2, '0')}`;

    const userConditions: any[] = [{ userId: user._id.toString() }];
    if (user.employeeId) {
      userConditions.push({ employeeId: user.employeeId });
    }

    const query: Record<string, any> = {
      $or: userConditions,
      date: { $gte: startDate, $lte: endDate },
    };
    if (organizationId && !isSuperAdmin) {
      query.organizationId = organizationId;
    }

    const rawRecords = await AttendanceModel.find(query)
      .select('-selfieData -selfie -punchOutSelfie')
      .lean();

    const recordByDate = new Map<string, any>();
    for (const r of rawRecords) {
      recordByDate.set(r.date, normalizeAttendanceSessions(r));
    }

    const todayDate = this.getTodayDateString();
    const days: any[] = [];

    let presentDays = 0;
    let fullDays = 0;
    let halfDays = 0;
    let lateDays = 0;
    let totalWorkingSec = 0;
    let totalLunchSec = 0;
    let totalLunchBreaks = 0;
    let loginTimesArr: number[] = [];
    const presentDates: string[] = [];

    const monthName = new Date(yearNum, monthNum - 1, 1).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    });

    for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
      const dateStr = `${targetMonth}-${String(dayNum).padStart(2, '0')}`;
      const dayDate = new Date(`${dateStr}T12:00:00Z`);
      const dayOfWeekNum = dayDate.getUTCDay(); // 0 is Sunday
      const dayName = dayDate.toLocaleDateString('en-US', { weekday: 'long' });

      // Weekend is strictly ONLY Sunday! (Saturday is a working day)
      const isWeekend = dayOfWeekNum === 0;
      const isToday = dateStr === todayDate;
      const isFuture = dateStr > todayDate;

      const rec = recordByDate.get(dateStr);
      const isPresent = Boolean(rec && (rec.loginTime || (rec.loginEvents && rec.loginEvents.length > 0)));

      let loginTimeFormatted = null;
      let logoutTimeFormatted = null;
      let shiftDurationFormatted = '-';
      let shiftDurationSeconds = 0;
      let status = 'ABSENT';

      if (isPresent && rec) {
        presentDays++;
        presentDates.push(dateStr);

        const fLogin = toValidAttendanceDate(rec.loginTime, dateStr);
        const fLogout = toValidAttendanceDate(rec.logoutTime, dateStr);

        if (fLogin) {
          loginTimesArr.push(fLogin.getHours() * 3600 + fLogin.getMinutes() * 60 + fLogin.getSeconds());
          loginTimeFormatted = fLogin.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
            timeZone: 'Asia/Kolkata',
          });

          // Check if arrival is after 10:05 AM IST
          const lHour = fLogin.getHours();
          const lMin = fLogin.getMinutes();
          const lSec = fLogin.getSeconds();
          const isAfter1005 = lHour > 10 || (lHour === 10 && (lMin > 5 || (lMin === 5 && lSec > 0)));
          if (isAfter1005 || rec.status === 'HALF_DAY') {
            halfDays++;
            status = 'HALF_DAY';
          } else {
            fullDays++;
            status = 'PRESENT';
          }
        }

        if (fLogout && fLogout.getFullYear() >= 2020) {
          logoutTimeFormatted = fLogout.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
            timeZone: 'Asia/Kolkata',
          });
        } else if (isToday) {
          logoutTimeFormatted = 'Active In Office';
        }

        if (fLogin && fLogout && fLogout.getFullYear() >= 2020) {
          shiftDurationSeconds = Math.max(0, Math.round((fLogout.getTime() - fLogin.getTime()) / 1000));
        } else if (fLogin && isToday) {
          shiftDurationSeconds = Math.max(0, Math.round((Date.now() - fLogin.getTime()) / 1000));
        }

        if (shiftDurationSeconds > 0) {
          totalWorkingSec += shiftDurationSeconds;
          shiftDurationFormatted = formatSecondsToDuration(shiftDurationSeconds);
        }
      } else if (isWeekend) {
        status = 'WEEKEND';
      } else if (isFuture) {
        status = 'UPCOMING';
      }

      const rawLunchBreaks: any[] = rec?.lunchBreaks || [];
      const lunchBreaksFormatted = rawLunchBreaks.map((b) => {
        const s = toValidAttendanceDate(b.startTime, dateStr);
        const e = toValidAttendanceDate(b.endTime, dateStr);
        const sec = b.durationSeconds || (s && e ? Math.max(0, Math.round((e.getTime() - s.getTime()) / 1000)) : 0);
        return {
          startTime: b.startTime,
          startTimeFormatted: s ? s.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '-',
          endTime: b.endTime,
          endTimeFormatted: e ? e.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : (isToday && rec?.isOnLunch ? 'Ongoing Break' : '-'),
          durationSeconds: sec,
          durationFormatted: formatSecondsToDuration(sec),
          isOverstay: sec > 1200,
          overstayFormatted: sec > 1200 ? formatSecondsToDuration(sec - 1200) : null,
          notes: b.notes,
          status: b.status,
        };
      });

      const dayLunchSec = rec?.totalLunchDurationSeconds || lunchBreaksFormatted.reduce((acc, b) => acc + b.durationSeconds, 0);
      totalLunchSec += dayLunchSec;
      totalLunchBreaks += lunchBreaksFormatted.length;

      const isLunchOverstay = dayLunchSec > 1200;

      days.push({
        date: dateStr,
        dayNumber: dayNum,
        dayName,
        isWeekend,
        isToday,
        isFuture,
        present: isPresent,
        status,
        loginTimeFormatted,
        logoutTimeFormatted,
        shiftDurationFormatted,
        shiftDurationSeconds,
        totalLunchDurationFormatted: formatSecondsToDuration(dayLunchSec),
        totalLunchDurationSeconds: dayLunchSec,
        isLunchOverstay,
        lunchOverstayFormatted: isLunchOverstay ? formatSecondsToDuration(dayLunchSec - 1200) : null,
        lunchBreaks: lunchBreaksFormatted,
        selfieUrl: rec?.selfieUrl
          ? (rec.selfieUrl.startsWith('data:image') && rec._id
              ? `/api/v1/attendance/${rec._id}/selfie`
              : rec.selfieUrl)
          : (rec?._id && (rec?.selfieData || rec?.selfie)
              ? `/api/v1/attendance/${rec._id}/selfie`
              : undefined),
        location: rec?.location,
        workReport: rec?.workReport,
        workCategory: rec?.workCategory,
        developmentChanges: rec?.developmentChanges,
        taskSummary: rec?.taskSummary,
        punchOutImageUrl: rec?.punchOutImageUrl
          ? (rec.punchOutImageUrl.startsWith('/')
              ? `https://atendence-crm.vercel.app${rec.punchOutImageUrl}`
              : rec.punchOutImageUrl)
          : undefined,
        logoutLocation: rec?.logoutLocation?.address || rec?.logoutLocation,
        loginEvents: (rec?.loginEvents || []).map((e: any) => {
          const inT = toValidAttendanceDate(e.loginTime, dateStr);
          const outT = toValidAttendanceDate(e.logoutTime, dateStr);
          return {
            ...e,
            loginTimeFormatted: inT ? inT.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '-',
            logoutTimeFormatted: outT && outT.getFullYear() >= 2020 ? outT.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : 'Active',
          };
        }),
      });
    }

    const workingDaysElapsed = days.filter((d) => !d.isWeekend && !d.isFuture).length;
    const workingDaysInMonth = days.filter((d) => !d.isWeekend).length;
    const absentDays = Math.max(0, workingDaysElapsed - presentDays);
    const attendancePercentage = workingDaysElapsed > 0 ? Math.round((presentDays / workingDaysElapsed) * 100) : 0;

    let avgLoginTime = '-';
    if (loginTimesArr.length > 0) {
      const avgSec = Math.round(loginTimesArr.reduce((a, b) => a + b, 0) / loginTimesArr.length);
      const h = Math.floor(avgSec / 3600);
      const m = Math.floor((avgSec % 3600) / 60);
      const ap = h >= 12 ? 'pm' : 'am';
      const disH = h % 12 || 12;
      avgLoginTime = `${String(disH).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
    }

    const todayRec = recordByDate.get(todayDate);
    const todaySelfie = todayRec?.selfieUrl?.startsWith('data:image') && todayRec?._id
      ? `/api/v1/attendance/${todayRec._id}/selfie`
      : todayRec?.selfieUrl;

    return {
      employee: {
        userId: user._id.toString(),
        name: user.name,
        email: user.email,
        phone: user.phone || '',
        employeeId: user.employeeId || 'EMP',
        role: user.role,
        department: user.department || 'Sales & Business Development',
        avatarUrl: user.avatarUrl,
        latestSelfie: todaySelfie,
      },
      month: targetMonth,
      monthLabel: monthName,
      summary: {
        totalDaysInMonth: daysInMonth,
        workingDaysInMonth,
        workingDaysElapsed,
        presentDays,
        fullDays,
        halfDays,
        presentDates,
        absentDays,
        lateDays,
        onLeaveDays: 0,
        attendancePercentage,
        totalWorkingSeconds: totalWorkingSec,
        totalWorkingFormatted: formatSecondsToDuration(totalWorkingSec),
        totalLunchBreaksCount: totalLunchBreaks,
        totalLunchSeconds: totalLunchSec,
        totalLunchFormatted: formatSecondsToDuration(totalLunchSec),
        avgDailyLunchFormatted: presentDays > 0 ? formatSecondsToDuration(Math.round(totalLunchSec / presentDays)) : '0m',
        avgLoginTime,
        currentlyActive: Boolean(recordByDate.get(todayDate)?.isCurrentlyActive),
        currentlyOnLunch: Boolean(recordByDate.get(todayDate)?.isOnLunch),
      },
      days,
    };
  }

  /**
   * Comprehensive Employee Daily Activity & Work Report
   * Supports both (userId, dateStr) and (organizationId, userId, dateStr, isSuperAdmin)
   */
  async getEmployeeDailyReport(
    organizationIdOrUserId: string,
    userIdOrDate?: string,
    dateOrIsSuperAdmin?: string | boolean,
    isSuperAdmin: boolean = false
  ): Promise<any> {
    const isMultiTenantCall =
      Boolean(userIdOrDate) &&
      (organizationIdOrUserId.startsWith('org_') ||
        typeof dateOrIsSuperAdmin === 'string' ||
        typeof dateOrIsSuperAdmin === 'boolean' ||
        isSuperAdmin !== false);

    const organizationId = isMultiTenantCall ? organizationIdOrUserId : undefined;
    const effectiveUserId = isMultiTenantCall ? userIdOrDate! : organizationIdOrUserId;
    const targetDateInput = isMultiTenantCall
      ? typeof dateOrIsSuperAdmin === 'string'
        ? dateOrIsSuperAdmin
        : undefined
      : userIdOrDate;

    const user = await UserModel.findById(effectiveUserId).lean();
    if (!user) {
      throw AppError.notFound('Employee profile not found');
    }

    const targetDate = targetDateInput || this.getTodayDateString();

    const query: Record<string, any> = {
      userId: user._id.toString(),
      date: targetDate,
    };
    if (organizationId && !isSuperAdmin) {
      query.organizationId = organizationId;
    }

    const attendanceRaw = await AttendanceModel.findOne(query)
      .select('-selfieData -selfie -punchOutSelfie')
      .lean();

    const attendance = attendanceRaw ? normalizeAttendanceSessions(attendanceRaw) : null;

    const startOfDay = new Date(`${targetDate}T00:00:00+05:30`);
    const endOfDay = new Date(`${targetDate}T23:59:59+05:30`);

    const calls = await CallModel.find({
      userId: user._id.toString(),
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    }).sort({ createdAt: 1 }).lean();

    const leads = await LeadModel.find({
      $or: [
        { ownerId: user._id.toString(), updatedAt: { $gte: startOfDay, $lte: endOfDay } },
        { 'assignedTo.id': user._id.toString(), updatedAt: { $gte: startOfDay, $lte: endOfDay } },
        { assignedTo: user._id.toString(), updatedAt: { $gte: startOfDay, $lte: endOfDay } },
      ],
    }).sort({ updatedAt: 1 }).lean();

    const tasks = await TaskModel.find({
      $and: [
        {
          $or: [
            { ownerId: user._id.toString() },
            { assignedTo: user._id.toString() },
            { assignedToName: user.name },
          ],
        },
        {
          $or: [
            { dueAt: { $gte: startOfDay, $lte: endOfDay } },
            { updatedAt: { $gte: startOfDay, $lte: endOfDay } },
          ],
        },
      ],
    }).sort({ updatedAt: 1 }).lean();

    const timeline: any[] = [];

    if (attendance) {
      const loginTime = toValidAttendanceDate(attendance.loginTime, targetDate);
      if (loginTime) {
        timeline.push({
          time: loginTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
          rawTime: loginTime,
          type: 'CHECK_IN',
          title: 'Office Arrival (Check-In)',
          description: `Checked in successfully with selfie & GPS. Arrival: ${loginTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })}`,
          badge: attendance.status === 'HALF_DAY' ? 'Half Day (>10:05 AM)' : 'On Time',
          badgeColor: attendance.status === 'HALF_DAY' ? 'amber' : 'emerald',
        });
      }

      (attendance.lunchBreaks || []).forEach((b: any, idx: number) => {
        const sTime = toValidAttendanceDate(b.startTime, targetDate);
        const eTime = toValidAttendanceDate(b.endTime, targetDate);
        if (sTime) {
          timeline.push({
            time: sTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
            rawTime: sTime,
            type: 'LUNCH_START',
            title: `Lunch Break #${idx + 1} Started`,
            description: `Employee logged out / punched out for lunch. Allowance: 20 minutes.`,
            badge: 'Lunch Break',
            badgeColor: 'amber',
          });
        }
        if (eTime) {
          const sec = b.durationSeconds || Math.max(0, Math.round((eTime.getTime() - sTime!.getTime()) / 1000));
          const isOverstay = sec > 1200;
          timeline.push({
            time: eTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
            rawTime: eTime,
            type: 'LUNCH_END',
            title: `Lunch Break #${idx + 1} Concluded`,
            description: `Punched in after lunch. Total duration taken: ${formatSecondsToDuration(sec)}${isOverstay ? ` (Overstay by ${formatSecondsToDuration(sec - 1200)})` : ' (Within 20m schedule)'}.`,
            badge: isOverstay ? `+${formatSecondsToDuration(sec - 1200)} Late` : 'On Time',
            badgeColor: isOverstay ? 'amber' : 'emerald',
          });
        }
      });

      const logoutTime = toValidAttendanceDate(attendance.logoutTime, targetDate);
      if (logoutTime && logoutTime.getFullYear() >= 2020) {
        timeline.push({
          time: logoutTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
          rawTime: logoutTime,
          type: 'CHECK_OUT',
          title: attendance.workReport ? 'Shift Punch-Out & Work Report' : 'Shift Punch-Out (Check-Out)',
          description: attendance.workReport
            ? `Report: "${attendance.workReport}" · Category: ${attendance.workCategory || 'Work Summary'}`
            : `Employee left office / concluded shift. Logged by ${attendance.logoutBy || 'Employee'}.`,
          badge: attendance.workReport ? 'Report Submitted' : 'Check Out',
          badgeColor: 'rose',
          workReport: attendance.workReport,
          workCategory: attendance.workCategory,
          developmentChanges: attendance.developmentChanges,
          punchOutImageUrl: attendance.punchOutImageUrl
            ? (attendance.punchOutImageUrl.startsWith('/')
                ? `https://atendence-crm.vercel.app${attendance.punchOutImageUrl}`
                : attendance.punchOutImageUrl)
            : undefined,
        });
      }
    }

    calls.forEach((c) => {
      const cTime = new Date(c.createdAt || Date.now());
      timeline.push({
        time: cTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
        rawTime: cTime,
        type: 'CALL',
        title: `Outbound Call with ${(c as any).contactName || (c as any).leadName || 'Prospect'}`,
        description: `Duration: ${formatSecondsToDuration(c.durationSeconds || 0)} · Outcome: ${c.status} · Notes: ${c.notes || 'No call notes'}`,
        badge: `${formatSecondsToDuration(c.durationSeconds || 0)}`,
        badgeColor: c.status === 'CONNECTED' || c.status === 'COMPLETED' ? 'emerald' : 'blue',
      });
    });

    leads.forEach((l: any) => {
      const lTime = new Date(l.updatedAt || l.createdAt || Date.now());
      const leadVal = l.value ?? l.budget ?? 0;
      timeline.push({
        time: lTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
        rawTime: lTime,
        type: 'LEAD',
        title: `Lead Activity: ${l.name}`,
        description: `Status: ${l.status || 'Active'} · Value: ₹${Number(leadVal).toLocaleString('en-IN')} · Email: ${l.email || 'N/A'}`,
        badge: l.status || 'Lead',
        badgeColor: 'blue',
      });
    });

    tasks.forEach((t: any) => {
      const tTime = new Date(t.updatedAt || t.createdAt || Date.now());
      const dueStr = t.dueAt ? new Date(t.dueAt).toLocaleDateString('en-IN') : (t.dueDate || 'Today');
      timeline.push({
        time: tTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
        rawTime: tTime,
        type: 'TASK',
        title: `Task: ${t.title}`,
        description: `Priority: ${t.priority || 'Normal'} · Status: ${t.status || 'Pending'} · Due: ${dueStr}`,
        badge: t.status || 'Task',
        badgeColor: t.isCompleted || t.status === 'COMPLETED' ? 'emerald' : 'purple',
      });
    });

    timeline.sort((a, b) => a.rawTime.getTime() - b.rawTime.getTime());

    let shiftSec = 0;
    const fLogin = attendance ? toValidAttendanceDate(attendance.loginTime, targetDate) : null;
    const fLogout = attendance ? toValidAttendanceDate(attendance.logoutTime, targetDate) : null;
    if (fLogin && fLogout && fLogout.getFullYear() >= 2020) {
      shiftSec = Math.max(0, Math.round((fLogout.getTime() - fLogin.getTime()) / 1000));
    } else if (fLogin && targetDate === this.getTodayDateString()) {
      shiftSec = Math.max(0, Math.round((Date.now() - fLogin.getTime()) / 1000));
    }

    const totalLunchSec = attendance?.totalLunchDurationSeconds || 0;
    const isLunchOverstay = totalLunchSec > 1200;

    return {
      employee: {
        userId: user._id.toString(),
        name: user.name,
        email: user.email,
        phone: user.phone || '',
        employeeId: user.employeeId || 'EMP',
        role: user.role,
        department: user.department || 'Sales & Business Development',
        avatarUrl: user.avatarUrl,
      },
      date: targetDate,
      attendance: attendance ? {
        status: attendance.status,
        isHalfDay: attendance.status === 'HALF_DAY',
        loginTime: fLogin,
        loginTimeFormatted: fLogin ? fLogin.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : null,
        logoutTime: fLogout && fLogout.getFullYear() >= 2020 ? fLogout : null,
        logoutTimeFormatted: fLogout && fLogout.getFullYear() >= 2020
          ? fLogout.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
          : targetDate === this.getTodayDateString() ? 'Active In Office' : '-',
        shiftDurationFormatted: shiftSec > 0 ? formatSecondsToDuration(shiftSec) : '-',
        shiftDurationSeconds: shiftSec,
        isOnLunch: Boolean(attendance.isOnLunch),
        totalLunchDurationSeconds: totalLunchSec,
        totalLunchFormatted: formatSecondsToDuration(totalLunchSec),
        isLunchOverstay,
        lunchOverstayFormatted: isLunchOverstay ? formatSecondsToDuration(totalLunchSec - 1200) : null,
        lunchBreaks: (attendance.lunchBreaks || []).map((b: any) => {
          const s = toValidAttendanceDate(b.startTime, targetDate);
          const e = toValidAttendanceDate(b.endTime, targetDate);
          const sec = b.durationSeconds || (s && e ? Math.max(0, Math.round((e.getTime() - s.getTime()) / 1000)) : 0);
          return {
            startTimeFormatted: s ? s.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '-',
            endTimeFormatted: e ? e.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : 'Ongoing',
            durationFormatted: formatSecondsToDuration(sec),
            durationSeconds: sec,
            isOverstay: sec > 1200,
            overstayFormatted: sec > 1200 ? formatSecondsToDuration(sec - 1200) : null,
          };
        }),
        sessions: (attendance.loginEvents || []).map((ev: any, idx: number) => {
          const inT = toValidAttendanceDate(ev.loginTime, targetDate);
          const outT = toValidAttendanceDate(ev.logoutTime, targetDate);
          return {
            sessionNumber: idx + 1,
            loginTimeFormatted: inT ? inT.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '-',
            logoutTimeFormatted: outT && outT.getFullYear() >= 2020 ? outT.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : 'Active',
            ipAddress: ev.ipAddress,
            logoutBy: ev.logoutBy,
          };
        }),
        selfieUrl: attendance.selfieUrl,
        location: attendance.location?.address,
        workReport: attendance.workReport,
        workCategory: attendance.workCategory,
        developmentChanges: attendance.developmentChanges,
        taskSummary: attendance.taskSummary,
        reportSubmittedAt: attendance.reportSubmittedAt,
        punchOutImageUrl: attendance.punchOutImageUrl
          ? (attendance.punchOutImageUrl.startsWith('/')
              ? `https://atendence-crm.vercel.app${attendance.punchOutImageUrl}`
              : attendance.punchOutImageUrl)
          : undefined,
        logoutLocation: attendance.logoutLocation?.address || attendance.logoutLocation,
      } : null,
      summary: {
        totalCalls: calls.length,
        connectedCalls: calls.filter((c) => c.status === 'CONNECTED' || c.status === 'COMPLETED').length,
        totalCallDurationFormatted: formatSecondsToDuration(calls.reduce((acc, c) => acc + (c.durationSeconds || 0), 0)),
        totalLeadsHandled: leads.length,
        totalTasksCompleted: tasks.filter((t) => t.isCompleted || t.status === 'COMPLETED').length,
        totalTimelineEvents: timeline.length,
      },
      timeline,
    };
  }
}

export const attendanceService = new AttendanceService();
export default attendanceService;
