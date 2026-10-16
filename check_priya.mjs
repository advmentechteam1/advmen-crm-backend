import mongoose from 'mongoose';

const uri = 'mongodb+srv://advmentechteam1_db_user:dDpfP4BsDtmsg8x6@cluster0.qshoyyn.mongodb.net/?appName=Cluster0';

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  console.log('=== PRIYA SHARMA ATTENDANCE DOCS ===');
  const priyaDocs = await db.collection('attendances').find({
    $or: [{ empId: /0025/i }, { employeeId: /0025/i }, { empName: /priya/i }, { userName: /priya/i }]
  }).sort({ _id: -1 }).toArray();

  for (const d of priyaDocs) {
    console.log(JSON.stringify({
      _id: d._id,
      empId: d.empId,
      employeeId: d.employeeId,
      empName: d.empName,
      userName: d.userName,
      date: d.date,
      loginTime: d.loginTime,
      logoutTime: d.logoutTime,
      punchIn: d.punchIn,
      punchOut: d.punchOut,
      status: d.status,
      isOnLunch: d.isOnLunch,
      lunchBreaks: d.lunchBreaks,
      createdAt: d.createdAt
    }, null, 2));
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
