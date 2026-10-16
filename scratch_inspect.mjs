import mongoose from 'mongoose';

const uri = 'mongodb+srv://advmentechteam1_db_user:dDpfP4BsDtmsg8x6@cluster0.qshoyyn.mongodb.net/?appName=Cluster0';

async function run() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  const latestAttendances = await db.collection('attendances').find().sort({ _id: -1 }).limit(5).toArray();
  console.log('Latest 5 attendances:');
  for (const a of latestAttendances) {
    console.log({
      _id: a._id,
      userId: a.userId,
      empId: a.empId,
      employeeId: a.employeeId,
      empName: a.empName,
      userName: a.userName,
      name: a.name,
      email: a.email,
      userEmail: a.userEmail,
      date: a.date,
      dateType: typeof a.date,
      punchIn: a.punchIn,
      loginTime: a.loginTime,
      status: a.status,
      location: a.location?.address || a.location,
      source: a.source,
      organizationId: a.organizationId
    });
  }

  const ashutoshUser = await db.collection('users').find({
    name: /ashutosh/i
  }).toArray();
  console.log('Ashutosh in users:', ashutoshUser);

  await mongoose.disconnect();
}

run().catch(console.error);
