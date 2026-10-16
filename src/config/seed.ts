import bcrypt from 'bcryptjs';
import { connectDB, disconnectDB } from './db.js';
import { OrganizationModel } from '../modules/organizations/organization.model.js';
import { UserModel } from '../modules/auth/auth.model.js';
import { SuperAdminModel } from '../modules/auth/superAdmin.model.js';
import { EmployeeCounterModel } from '../modules/users/employeeCounter.model.js';
import { LeadModel } from '../modules/leads/lead.model.js';
import { DealModel } from '../modules/deals/deal.model.js';
import { TaskModel } from '../modules/tasks/task.model.js';
import { AutomationModel } from '../modules/automations/automation.model.js';
import { ProposalModel } from '../modules/proposals/proposal.model.js';
import { InvoiceModel } from '../modules/invoices-payments/invoice.model.js';
import { CallModel } from '../modules/calls/call.model.js';
import { ActivityModel } from '../modules/activities/activity.model.js';
import { USER_ROLES, ROLE_DEFAULT_PERMISSIONS } from './constants.js';
import { env } from './env.js';
import { logger } from '../shared/logger/logger.js';

export async function seedDatabase(forceClean: boolean = false): Promise<void> {
  logger.info('🌱 Verifying Platform Database & Super Admin Setup...');

  // Only purge when explicitly requested via CLI with forceClean flag
  if (forceClean) {
    logger.info('🧹 forceClean requested: purging mock records...');
    const [leadsRes, dealsRes, tasksRes, autoRes, propRes, invRes, callRes, actRes, orgsRes, usersRes] = await Promise.all([
      LeadModel.deleteMany({}),
      DealModel.deleteMany({}),
      TaskModel.deleteMany({}),
      AutomationModel.deleteMany({}),
      ProposalModel.deleteMany({}),
      InvoiceModel.deleteMany({}),
      CallModel.deleteMany({}),
      ActivityModel.deleteMany({}),
      OrganizationModel.deleteMany({ organizationId: { $ne: 'org_advmen_platform' } }),
      UserModel.deleteMany({ role: { $ne: USER_ROLES.SUPER_ADMIN } }),
    ]);
    logger.info(
      `🧹 Cleared records: ${leadsRes.deletedCount} leads, ${dealsRes.deletedCount} deals, ${tasksRes.deletedCount} tasks, ${orgsRes.deletedCount} orgs, ${usersRes.deletedCount} users.`
    );
  }

  // 1. Initialize / Upsert Platform Operations Root Workspace
  const platformOrg = {
    organizationId: 'org_advmen_platform',
    name: 'ADVMEN Platform Ops',
    slug: 'advmen-platform',
    planTier: 'ENTERPRISE',
    planStatus: 'ACTIVE',
    limits: {
      maxUsers: 500,
      maxLeads: 1000000,
      maxStorageMb: 102400,
      aiTokensIncluded: 5000000,
    },
    settings: {
      timezone: 'UTC',
      currency: 'USD',
      leadResponseSlaMinutes: 15,
      allowTelephonyRecording: true,
    },
  };

  await OrganizationModel.findOneAndUpdate(
    { organizationId: platformOrg.organizationId },
    { $set: platformOrg },
    { upsert: true, new: true }
  );
  logger.info(`✅ Root platform workspace ready (${platformOrg.name})`);

  // 2. Provision / Upsert Sole Super Admin Account in Dedicated 'superadmins' Collection
  const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || env.SUPER_ADMIN_EMAIL || 'admin@advmen.local').toLowerCase().trim();
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || env.SUPER_ADMIN_PASSWORD || 'Advmen@Admin2026!';

  if (superAdminEmail && superAdminPassword) {
    const superAdminPasswordHash = await bcrypt.hash(superAdminPassword, 12);

    const adminUserDoc = {
      organizationId: 'org_advmen_platform',
      name: 'Super Administrator',
      email: superAdminEmail,
      normalizedEmail: superAdminEmail,
      passwordHash: superAdminPasswordHash,
      role: USER_ROLES.SUPER_ADMIN,
      permissions: ['*'],
      avatarUrl: '',
      isActive: true,
      isEmailVerified: true,
    };

    // Clean up any extra/legacy accounts in 'superadmins' collection
    await SuperAdminModel.deleteMany({ normalizedEmail: { $ne: superAdminEmail } });

    // 1. Dedicated primary 'superadmins' collection (Sole Super Admin lives here!)
    await SuperAdminModel.findOneAndUpdate(
      { normalizedEmail: superAdminEmail },
      { $set: adminUserDoc },
      { upsert: true, new: true }
    );
    logger.info(`👑 Sole Super Admin provisioned in dedicated 'superadmins' collection: ${superAdminEmail}`);

    // 2. Compatibility sync to 'users' collection so current Render & legacy deployments authenticate without 401
    await UserModel.findOneAndUpdate(
      { normalizedEmail: superAdminEmail },
      { $set: adminUserDoc },
      { upsert: true, new: true }
    );
    logger.info(`🔄 Super Admin credentials synchronized for cross-deployment compatibility.`);
  } else {
    logger.info('ℹ️ SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD not set in environment; skipping super admin upsert.');
  }

  // 3. Ensure Demo Admin Account (admin@platform.com / password123)
  const adminPasswordHash = await bcrypt.hash('password123', 10);
  await UserModel.findOneAndUpdate(
    { normalizedEmail: 'admin@platform.com' },
    {
      $set: {
        organizationId: 'org_advmen_platform',
        name: 'Workspace Administrator',
        email: 'admin@platform.com',
        normalizedEmail: 'admin@platform.com',
        passwordHash: adminPasswordHash,
        role: USER_ROLES.ORG_ADMIN,
        department: 'Operations & Management',
        phone: '9800000001',
        permissions: ROLE_DEFAULT_PERMISSIONS[USER_ROLES.ORG_ADMIN],
        isActive: true,
        isEmailVerified: true,
      },
    },
    { upsert: true, new: true }
  );

  // 4. Ensure Demo Employee Account with Mobile (9876543210 / rahul.employee@platform.com / password123)
  const empPasswordHash = await bcrypt.hash('password123', 10);
  const demoEmployee = await UserModel.findOneAndUpdate(
    { normalizedEmail: 'rahul.employee@platform.com' },
    {
      $set: {
        organizationId: 'org_advmen_platform',
        name: 'Rahul Sharma (Sales Executive)',
        email: 'rahul.employee@platform.com',
        normalizedEmail: 'rahul.employee@platform.com',
        phone: '9876543210',
        passwordHash: empPasswordHash,
        role: USER_ROLES.SALES_REP,
        department: 'Sales & Business Development',
        permissions: ROLE_DEFAULT_PERMISSIONS[USER_ROLES.SALES_REP],
        isActive: true,
        isEmailVerified: true,
      },
    },
    { upsert: true, new: true }
  );
  if (demoEmployee && !demoEmployee.employeeId) {
    const year = new Date().getFullYear();
    const employeeCounter = await EmployeeCounterModel.findByIdAndUpdate(
      `employee-${year}`,
      { $inc: { sequence: 1 } },
      { new: true, upsert: true }
    );
    if (!employeeCounter) {
      throw new Error('Could not allocate an Employee ID for the demo employee.');
    }
    demoEmployee.employeeId = `EMP-${year}-${String(employeeCounter.sequence).padStart(4, '0')}`;
    await demoEmployee.save();
  } else if (demoEmployee?.employeeId) {
    const existingId = demoEmployee.employeeId.match(/^EMP-(\d{4})-(\d+)$/i);
    if (existingId) {
      await EmployeeCounterModel.findByIdAndUpdate(
        `employee-${existingId[1]}`,
        { $max: { sequence: Number(existingId[2]) } },
        { new: true, upsert: true }
      );
    }
  }
  logger.info(`👤 Demo Admin and Demo Employee (${demoEmployee?.employeeId || 'Employee ID unavailable'}) ready.`);

  // 5. Seed Real Initial Leads into MongoDB if database has no leads
  const leadsCount = await LeadModel.countDocuments({ organizationId: platformOrg.organizationId });
  if (leadsCount === 0) {
    const rahulUser = await UserModel.findOne({ normalizedEmail: 'rahul.employee@platform.com' }).lean();
    const demoLeads: any[] = [
      {
        leadId: 'LD-10001',
        organizationId: platformOrg.organizationId,
        name: 'Amitabh Verma',
        phone: '+91 9811223344',
        normalizedPhone: '+919811223344',
        email: 'amitabh.verma@techcorp.in',
        normalizedEmail: 'amitabh.verma@techcorp.in',
        company: 'TechCorp Solutions India',
        title: 'VP of Technology',
        source: 'WEBSITE',
        status: 'NEW',
        score: 85,
        scoreCategory: 'HOT',
        budget: 150000,
        requirement: 'Enterprise CRM implementation for 45 telecallers and sales reps.',
        slaStatus: 'ON_TIME',
        tags: ['Enterprise', 'High Priority'],
      },
      {
        leadId: 'LD-10002',
        organizationId: platformOrg.organizationId,
        name: 'Pooja Singhania',
        phone: '+91 9822334455',
        normalizedPhone: '+919822334455',
        email: 'pooja.s@fintechcloud.com',
        normalizedEmail: 'pooja.s@fintechcloud.com',
        company: 'FinTech Cloud Pvt Ltd',
        title: 'Director of Business Development',
        source: 'META_ADS',
        status: 'NEW',
        score: 72,
        scoreCategory: 'WARM',
        budget: 85000,
        requirement: 'Inbound lead autodialer and automated WhatsApp follow-ups.',
        slaStatus: 'ON_TIME',
        tags: ['Inbound', 'FinTech'],
      },
      {
        leadId: 'LD-10003',
        organizationId: platformOrg.organizationId,
        name: 'Rohan Deshmukh',
        phone: '+91 9833445566',
        normalizedPhone: '+919833445566',
        email: 'rohan.d@logixware.com',
        normalizedEmail: 'rohan.d@logixware.com',
        company: 'Logixware Global Systems',
        title: 'Managing Director',
        source: 'GOOGLE_ADS',
        status: 'NEW',
        score: 90,
        scoreCategory: 'HOT',
        budget: 250000,
        requirement: 'Full migration from Salesforce to ADVMEN SalesOS.',
        slaStatus: 'ON_TIME',
        tags: ['Enterprise', 'Hot Prospect'],
      },
      {
        leadId: 'LD-10004',
        organizationId: platformOrg.organizationId,
        name: 'Neha Kapoor',
        phone: '+91 9844556677',
        normalizedPhone: '+919844556677',
        email: 'neha.kapoor@retailplus.in',
        normalizedEmail: 'neha.kapoor@retailplus.in',
        company: 'RetailPlus Omni Pvt Ltd',
        title: 'Operations Head',
        source: 'INBOUND_CALL',
        status: 'NEW',
        score: 65,
        scoreCategory: 'WARM',
        budget: 45000,
        requirement: 'Calling queue and call recordings integration.',
        slaStatus: 'ON_TIME',
        tags: ['Retail', 'Calling'],
      },
      {
        leadId: 'LD-10005',
        organizationId: platformOrg.organizationId,
        name: 'Vikram Malhotra',
        phone: '+91 9855667788',
        normalizedPhone: '+919855667788',
        email: 'vikram@malhotraenterprises.com',
        normalizedEmail: 'vikram@malhotraenterprises.com',
        company: 'Malhotra Logistics Group',
        title: 'Chief Operating Officer',
        source: 'WEBSITE',
        status: 'NEW',
        score: 80,
        scoreCategory: 'HOT',
        budget: 120000,
        requirement: 'Multi-branch sales tracking and custom quote generation.',
        slaStatus: 'ON_TIME',
        tags: ['Logistics', 'High Value'],
      },
      {
        leadId: 'LD-10006',
        organizationId: platformOrg.organizationId,
        name: 'Ananya Sharma',
        phone: '+91 9866778899',
        normalizedPhone: '+919866778899',
        email: 'ananya.sharma@healthfirst.org',
        normalizedEmail: 'ananya.sharma@healthfirst.org',
        company: 'HealthFirst Diagnostics',
        title: 'Head of Growth',
        source: 'META_ADS',
        status: 'NEW',
        score: 55,
        scoreCategory: 'WARM',
        budget: 35000,
        requirement: 'Automated appointment booking and CRM dispatch.',
        slaStatus: 'ON_TIME',
        tags: ['Healthcare'],
      },
      {
        leadId: 'LD-10007',
        organizationId: platformOrg.organizationId,
        name: 'Suresh Menon',
        phone: '+91 9877889900',
        normalizedPhone: '+919877889900',
        email: 'suresh@menoninfra.com',
        normalizedEmail: 'suresh@menoninfra.com',
        company: 'Menon Infrastructure Ltd',
        title: 'Procurement Director',
        source: 'REFERRAL',
        status: 'NEW',
        score: 88,
        scoreCategory: 'HOT',
        budget: 300000,
        requirement: 'Pipeline stage tracking, approvals, invoice reconciliations.',
        slaStatus: 'ON_TIME',
        tags: ['Infrastructure', 'Referral'],
      },
      {
        leadId: 'LD-10008',
        organizationId: platformOrg.organizationId,
        name: 'Kavita Chawla',
        phone: '+91 9888990011',
        normalizedPhone: '+919888990011',
        email: 'kavita@eduverse.io',
        normalizedEmail: 'kavita@eduverse.io',
        company: 'EduVerse Learning Platform',
        title: 'Founder & CEO',
        source: 'WEBSITE',
        status: 'NEW',
        score: 70,
        scoreCategory: 'WARM',
        budget: 60000,
        requirement: 'Student counseling lead management and campaign analytics.',
        slaStatus: 'ON_TIME',
        tags: ['EdTech', 'Warm'],
      },
      {
        leadId: 'LD-10009',
        organizationId: platformOrg.organizationId,
        name: 'Manish Tiwari',
        phone: '+91 9899001122',
        normalizedPhone: '+919899001122',
        email: 'manish.t@tiwariproperties.in',
        normalizedEmail: 'manish.t@tiwariproperties.in',
        company: 'Tiwari Real Estate Developers',
        title: 'Sales Director',
        source: 'GOOGLE_ADS',
        status: 'NEW',
        score: 92,
        scoreCategory: 'HOT',
        budget: 500000,
        requirement: 'Real estate buyer qualification and site visit scheduling.',
        slaStatus: 'ON_TIME',
        tags: ['Real Estate', 'High Value'],
      },
      {
        leadId: 'LD-10010',
        organizationId: platformOrg.organizationId,
        name: 'Deepak Joshi',
        phone: '+91 9800112233',
        normalizedPhone: '+919800112233',
        email: 'deepak.joshi@autotraders.co',
        normalizedEmail: 'deepak.joshi@autotraders.co',
        company: 'AutoTraders India',
        title: 'General Manager',
        source: 'WEBSITE',
        status: 'NEW',
        score: 60,
        scoreCategory: 'WARM',
        budget: 40000,
        requirement: 'Test drive inquiries tracking and salesperson lead distribution.',
        slaStatus: 'ON_TIME',
        tags: ['Automotive'],
      },
    ];

    if (rahulUser) {
      demoLeads.push(
        {
          leadId: 'LD-10011',
          organizationId: platformOrg.organizationId,
          name: 'Sunil Rao',
          phone: '+91 9711223344',
          normalizedPhone: '+919711223344',
          email: 'sunil.rao@apexfin.com',
          normalizedEmail: 'sunil.rao@apexfin.com',
          company: 'Apex Financial Services',
          title: 'Managing Partner',
          source: 'WEBSITE',
          status: 'ASSIGNED',
          ownerId: rahulUser._id.toString(),
          assignedTo: {
            id: rahulUser._id.toString(),
            name: rahulUser.name,
            avatarUrl: rahulUser.avatarUrl,
          },
          score: 82,
          scoreCategory: 'HOT',
          budget: 180000,
          requirement: 'Wealth management client onboarding CRM.',
          slaStatus: 'ON_TIME',
          tags: ['Finance', 'Assigned'],
        },
        {
          leadId: 'LD-10012',
          organizationId: platformOrg.organizationId,
          name: 'Priyanka Mittal',
          phone: '+91 9722334455',
          normalizedPhone: '+919722334455',
          email: 'priyanka@mittalchem.com',
          normalizedEmail: 'priyanka@mittalchem.com',
          company: 'Mittal Chemical Industries',
          title: 'Export Manager',
          source: 'REFERRAL',
          status: 'ASSIGNED',
          ownerId: rahulUser._id.toString(),
          assignedTo: {
            id: rahulUser._id.toString(),
            name: rahulUser.name,
            avatarUrl: rahulUser.avatarUrl,
          },
          score: 75,
          scoreCategory: 'WARM',
          budget: 95000,
          requirement: 'Export customer relationship tracking & quotation pipeline.',
          slaStatus: 'ON_TIME',
          tags: ['Chemicals', 'Assigned'],
        }
      );
    }

    await LeadModel.insertMany(demoLeads);
    logger.info(`🎯 Seeded ${demoLeads.length} initial real leads into MongoDB!`);
  }

  logger.info('🎉 Production database ready.');
}

// Support direct execution via CLI `npm run seed`
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  (async () => {
    try {
      await connectDB();
      await seedDatabase();
      await disconnectDB();
      process.exit(0);
    } catch (err) {
      logger.error('❌ Seeding failed:', err);
      process.exit(1);
    }
  })();
}
