import mongoose from 'mongoose';

const uri = 'mongodb+srv://advmentechteam1_db_user:dDpfP4BsDtmsg8x6@cluster0.qshoyyn.mongodb.net/?appName=Cluster0';

async function main() {
  await mongoose.connect(uri);
  const col = mongoose.connection.db.collection('attendances');

  console.log('--- RECENT 10 DOCS IN ATTENDANCES ---');
  const recent = await col.find({}).sort({ _id: -1 }).limit(10).toArray();
  for (const d of recent) {
    console.log(JSON.stringify({
      _id: d._id,
      empId: d.empId,
      employeeId: d.employeeId,
      empName: d.empName,
      userName: d.userName,
      date: d.date,
      punchIn: d.punchIn,
      loginTime: d.loginTime,
      punchOut: d.punchOut,
      logoutTime: d.logoutTime,
      isOnLunch: d.isOnLunch,
      lunchBreaks: d.lunchBreaks,
      status: d.status,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt
    }, null, 2));
  }

  console.log('--- SEARCHING FOR ARVIND ---');
  const arvindDocs = await col.find({
    $or: [
      { empId: /0022/i },
      { employeeId: /0022/i },
      { empName: /arvind/i },
      { userName: /arvind/i }
    ]
  }).toArray();
  console.log('Arvind docs found:', arvindDocs.length);
  for (const d of arvindDocs) {
    console.log(JSON.stringify(d, null, 2));
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
