import mongoose from 'mongoose';

const uri = 'mongodb+srv://advmentechteam1_db_user:dDpfP4BsDtmsg8x6@cluster0.qshoyyn.mongodb.net/test?appName=Cluster0';

async function test() {
  await mongoose.connect(uri);
  const user = await mongoose.connection.db.collection('users').findOne({
    $or: [{ employeeId: /0025/i }, { name: /priya/i }]
  });
  console.log('User doc:', user);

  // Now simulate GET /api/v1/attendance/employee/emp-2026-0025/history
  // with an admin who has organizationId: 'org_advmen_platform'
  const { attendanceService } = await import('./dist/modules/attendance/attendance.service.js');
  try {
    const res = await attendanceService.getEmployeeMonthlyHistory(
      'org_advmen_platform',
      'emp-2026-0025',
      '2026-10',
      false // test isSuperAdmin = false
    );
    console.log('Result when isSuperAdmin=false:', Boolean(res));
  } catch (err) {
    console.log('ERROR when isSuperAdmin=false:', err.name, err.message, err);
  }

  process.exit(0);
}

test().catch(e => { console.error(e); process.exit(1); });
