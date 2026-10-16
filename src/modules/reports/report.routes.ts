import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { tenantMiddleware } from '../../middleware/tenant.middleware.js';
import { reportController } from './report.controller.js';

export const reportRouter = Router();

reportRouter.use(authMiddleware, tenantMiddleware);

// Analytics Overview
reportRouter.get('/overview', (req, res, next) => {
  reportController.getOverview(req, res).catch(next);
});

// Employee Daily Work Reports Collection
reportRouter.get('/work-reports', (req, res, next) => {
  reportController.getWorkReports(req, res).catch(next);
});

reportRouter.post('/work-reports', (req, res, next) => {
  reportController.submitWorkReport(req, res).catch(next);
});

reportRouter.post('/work-reports/sync', (req, res, next) => {
  reportController.syncWorkReports(req, res).catch(next);
});

reportRouter.get('/work-reports/:id', (req, res, next) => {
  reportController.getWorkReportById(req, res).catch(next);
});

reportRouter.patch('/work-reports/:id/review', (req, res, next) => {
  reportController.reviewWorkReport(req, res).catch(next);
});
