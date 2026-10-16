import mongoose from 'mongoose';

const uri = 'mongodb+srv://advmentechteam1_db_user:dDpfP4BsDtmsg8x6@cluster0.qshoyyn.mongodb.net/test?appName=Cluster0';

async function test() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const cols = await db.listCollections().toArray();
  console.log('Collections in test:', cols.map(c => c.name));
  
  if (cols.some(c => c.name === 'attendance')) {
    const attCount = await db.collection('attendance').countDocuments();
    console.log('attendance count:', attCount);
  }
  
  if (cols.some(c => c.name === 'attendances')) {
    const attsCount = await db.collection('attendances').countDocuments();
    console.log('attendances count:', attsCount);
  }

  const priyaAtt = await db.collection('attendance').find({
    $or: [{ empId: /0025/i }, { employeeId: /0025/i }, { empName: /priya/i }, { userName: /priya/i }]
  }).toArray();
  console.log('Priya in attendance collection:', priyaAtt.length);
  for (const p of priyaAtt) {
    console.log('Priya doc:', {
      _id: p._id,
      userId: p.userId,
      employeeId: p.employeeId,
      empId: p.empId,
      name: p.userName || p.empName,
      date: p.date,
      loginTime: p.loginTime,
      logoutTime: p.logoutTime,
      status: p.status,
      lunchBreaks: p.lunchBreaks,
      totalLunchDurationSeconds: p.totalLunchDurationSeconds,
      lunchDurationFormatted: p.lunchDurationFormatted,
      loginEvents: p.loginEvents
    });
  }

  const priyaUser = await db.collection('users').find({
    $or: [{ employeeId: /0025/i }, { name: /priya/i }]
  }).toArray();
  console.log('Priya in users collection:', priyaUser.length);
  for (const u of priyaUser) {
    console.log('Priya user:', { _id: u._id, employeeId: u.employeeId, name: u.name, email: u.email });
  }

  process.exit(0);
}

test().catch(e => { console.error(e); process.exit(1); });
