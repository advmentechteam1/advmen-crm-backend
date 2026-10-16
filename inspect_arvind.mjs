import mongoose from 'mongoose';

const uri = 'mongodb+srv://advmentechteam1_db_user:dDpfP4BsDtmsg8x6@cluster0.qshoyyn.mongodb.net/?appName=Cluster0';

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  console.log('=== USERS matching Arvind ===');
  const users = await db.collection('users').find({
    $or: [{ name: /arvind/i }, { empId: /0022/i }, { employeeId: /0022/i }, { email: /arvind/i }]
  }).toArray();
  console.log(JSON.stringify(users, null, 2));

  console.log('=== ATTENDANCES matching Arvind ===');
  const atts = await db.collection('attendances').find({
    $or: [{ name: /arvind/i }, { userName: /arvind/i }, { empName: /arvind/i }, { empId: /0022/i }, { employeeId: /0022/i }, { employeeId: /0015/i }]
  }).sort({ createdAt: -1 }).toArray();
  console.log(JSON.stringify(atts.map(a => ({
    _id: a._id,
    empId: a.empId,
    employeeId: a.employeeId,
    empName: a.empName,
    userName: a.userName,
    date: a.date,
    loginTime: a.loginTime,
    logoutTime: a.logoutTime,
    punchIn: a.punchIn,
    punchOut: a.punchOut,
    createdAt: a.createdAt
  })), null, 2));

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
