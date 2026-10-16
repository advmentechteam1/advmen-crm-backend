import { Router } from 'express';
import { attendanceController } from './attendance.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js'; 

export const attendanceRouter = Router();

attendanceRouter.get('/debug/sample', attendanceController.getSampleDebug);
attendanceRouter.get('/debug/dedup', attendanceController.triggerDedupDebug);

// Public on-demand streaming route for employee check-in selfies (enables browser caching and <img> tags)
attendanceRouter.get('/:id/selfie', attendanceController.getSelfieImage);

attendanceRouter.use(authMiddleware);

// Employee route: get own attendance history
attendanceRouter.get('/my', attendanceController.getMyAttendance);

// Employee route: punch out
attendanceRouter.post('/punch-out', attendanceController.punchOut);

// Employee / Admin route: lunch break management
attendanceRouter.post('/lunch/start', attendanceController.startLunch);
attendanceRouter.post('/lunch/end', attendanceController.endLunch);
attendanceRouter.get('/lunch/status', attendanceController.getLunchStatus);

// Employee / Admin route: detailed monthly day-wise and lunch history for employee
attendanceRouter.get('/employee/:userId/history', attendanceController.getEmployeeMonthlyHistory);
attendanceRouter.get('/employee/:userId/daily-report', attendanceController.getEmployeeDailyReport);
attendanceRouter.post('/employee/:userId/lunch', attendanceController.adminRecordLunch);

// Administrator route: view employee attendance and login history
attendanceRouter.get('/', attendanceController.getAttendanceList);

// Administrator route: force logout / punch out an employee
attendanceRouter.post('/force-logout', attendanceController.adminForceLogout);

// Administrator route: manual sync with external attendance app
attendanceRouter.post('/sync', attendanceController.syncExternalAttendance);

// Administrator route: clear all attendance records
attendanceRouter.delete('/clear-all', attendanceController.clearAll);

// Administrator route: delete a single attendance record by ID
attendanceRouter.delete('/:id', attendanceController.deleteRecord);