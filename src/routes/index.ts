import { Router, Request, Response } from 'express';
import { healthRouter } from './health.routes.js';
import { authRouter } from '../modules/auth/auth.routes.js';
import { leadRouter } from '../modules/leads/lead.routes.js';
import { dealRouter } from '../modules/deals/deal.routes.js';
import { callRouter } from '../modules/calls/call.routes.js';
import { aiRouter } from '../modules/ai/ai.routes.js';
import { taskRouter } from '../modules/tasks/task.routes.js';
import { proposalRouter } from '../modules/proposals/proposal.routes.js';
import { invoiceRouter } from '../modules/invoices-payments/invoice.routes.js';
import { activityRouter } from '../modules/activities/activity.routes.js';
import { automationRouter } from '../modules/automations/automation.routes.js';
import { userRouter } from '../modules/users/user.routes.js';
import { organizationRouter } from '../modules/organizations/organization.routes.js';
import { attendanceRouter } from '../modules/attendance/attendance.routes.js';
import { reportRouter } from '../modules/reports/report.routes.js';
import { departmentRouter } from '../modules/departments/department.routes.js';

export const apiRouter = Router();

// Root API v1 Information
apiRouter.use('/health', healthRouter);

apiRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    app: 'ADVMEN SalesOS API',
    version: 'v1.0.0',
    documentation: '/api/v1/docs',
    timestamp: new Date().toISOString(),
  });
});

// Domain Modules
apiRouter.use('/auth', authRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/departments', departmentRouter);
apiRouter.use('/organizations', organizationRouter);
apiRouter.use('/attendance', attendanceRouter);
apiRouter.use('/leads', leadRouter);
apiRouter.use('/deals', dealRouter);
apiRouter.use('/calls', callRouter);
apiRouter.use('/ai', aiRouter);
apiRouter.use('/tasks', taskRouter);
apiRouter.use('/proposals', proposalRouter);
apiRouter.use('/invoices', invoiceRouter);
apiRouter.use('/activities', activityRouter);
apiRouter.use('/automations', automationRouter);
apiRouter.use('/reports', reportRouter);








