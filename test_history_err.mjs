import mongoose from 'mongoose';
import { attendanceService } from './dist/modules/attendance/attendance.service.js';

const uri = 'mongodb+srv://advmentechteam1_db_user:dDpfP4BsDtmsg8x6@cluster0.qshoyyn.mongodb.net/test?appName=Cluster0';

async function test() {
  await mongoose.connect(uri);
  console.log('Connected to DB');
  try {
    const res = await attendanceService.getEmployeeMonthlyHistory(
      'org_advmen_platform',
      'emp-2026-0025',
      '2026-10',
      true
    );
    console.log('Success! Employee:', res.employee);
    console.log('Total days with attendance:', res.history.filter(h => h.present).length);
  } catch (err) {
    console.error('FAILED with error:', err);
  }
  process.exit(0);
}

test().catch(e => { console.error(e); process.exit(1); });
