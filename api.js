const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max:3,
  idleTimeoutMillis:10000,
  connectionTimeoutMillis:10000
});

function send(res,status,obj){
  res.statusCode=status;
  res.setHeader("Content-Type","application/json");
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");res.setHeader("Pragma","no-cache");res.setHeader("Expires","0");
  res.end(JSON.stringify(obj));
}
function coach(req){
  return !!process.env.COACH_KEY && req.headers["x-coach-key"]===process.env.COACH_KEY;
}
async function body(req){
  if(req.body && typeof req.body==="object") return req.body;
  if(typeof req.body==="string"){ try{return JSON.parse(req.body)}catch{} }
  let raw="";
  for await (const chunk of req) raw+=chunk;
  if(!raw) return {};
  try{return JSON.parse(raw)}catch{return {}}
}

const DAY_NAMES=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
function sydneyDateParts(date=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Australia/Sydney",year:"numeric",month:"2-digit",day:"2-digit",weekday:"long"}).formatToParts(date).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
  return{date:`${parts.year}-${parts.month}-${parts.day}`,weekday:parts.weekday};
}
function addIsoDays(iso,days){const d=new Date(iso+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
function mondayIsoForDate(iso){const d=new Date(iso+"T00:00:00Z"),offset=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-offset);return d.toISOString().slice(0,10)}
function nextWeekMeta(meta,startDate){const week=Number(meta?.weekNo)||1,roll=week>=6,block=(Number(meta?.blockNo)||1)+(roll?1:0),nextWeek=roll?1:week+1;return{...(meta||{}),blockNo:block,weekNo:nextWeek,date:startDate,name:`Block ${block} - Week ${nextWeek}`,autoCreated:true,reviewRequired:true}}
function testingItem(testId,name,unit,target){return{testId,name,unit,target}}
function automaticTestingPlan(meta,carnivals=[]){
 const start=String(meta?.date||"");if(!/^\d{4}-\d{2}-\d{2}$/.test(start))return null;const end=addIsoDays(start,6);
 const state=(carnivals||[]).find(c=>/slsnsw surf boat championships/i.test(String(c.name||""))),stateDate=state?.date||"2027-02-27",finalTarget=addIsoDays(stateDate,14);let finalStart=mondayIsoForDate(finalTarget);
 for(let i=0;i<4;i++){const finalEnd=addIsoDays(finalStart,6),hasRace=(carnivals||[]).some(c=>c.date>=finalStart&&c.date<=finalEnd);if(!hasRace)break;finalStart=addIsoDays(finalStart,7)}
 const regular=Number(meta?.weekNo)===4,final=start===finalStart;if(!regular&&!final)return null;
 const erg=start<"2026-12-25"?testingItem("erg2k","2k Erg","time","Record total time and average 500m split"):testingItem("erg1200","1200m Erg","time","Record total time and average 500m split");
 const races=(carnivals||[]).filter(c=>c.date>=start&&c.date<=end),raceWeek=races.length>0;
 return{erg,ergDay:raceWeek?"Monday":"Tuesday",gymDay:raceWeek?"Tuesday":"Thursday",raceWeek,final,races};
}
function applyAutomaticTesting(days,meta,carnivals=[],tests=[]){
 DAY_NAMES.forEach(day=>{if(!days[day])days[day]={sessions:[]};days[day].sessions=(days[day].sessions||[]).filter(s=>!s.autoTesting)});
 const plan=automaticTestingPlan(meta,carnivals);if(!plan)return false;
 const recovery=plan.raceWeek?`Carnival week: testing is early in the week to protect race-day recovery (${plan.races.map(c=>c.name).join(", ")}).`:"Testing is spaced across the week to allow recovery between tests.";
 const ergSession={id:`auto_erg_${meta.blockNo}_${meta.weekNo}_${meta.date}`,autoTesting:true,title:plan.final?"Final 1200m Erg Test":"Erg Testing",type:"Erg Testing",instructions:`Complete a thorough warm-up, then perform the ${plan.erg.name}.`,notes:recovery,testItems:[plan.erg],exercises:[]};
 const defaults=[testingItem("gym_squat","Back Squat","kg","Record best completed working set"),testingItem("gym_deadlift","Deadlift","kg","Record best completed working set"),testingItem("gym_bench","Bench Press","kg","Record best completed working set")],gymItems=(tests||[]).filter(t=>t.category==="Gym").map(t=>testingItem(t.id,t.name,t.unit||"kg",t.target||"Record best completed working set"));
 const gymSession={id:`auto_gym_${meta.blockNo}_${meta.weekNo}_${meta.date}`,autoTesting:true,title:"Gym Strength Testing",type:"Weight Testing",instructions:"Complete the programmed strength tests with full warm-up and safe technique.",notes:recovery,testItems:gymItems.length?gymItems:defaults,exercises:[]};
 days[plan.ergDay].sessions.push(ergSession);days[plan.gymDay].sessions.push(gymSession);meta.testingWeek=true;meta.testingPlan=plan.final?"Final post-State 1200m erg and gym testing":`${plan.erg.name} and gym testing`;return true;
}
function programSnapshots(data){return[...(data.archive||[]).map(x=>({meta:x.meta||{},days:x.days||{}})),{meta:data.meta||{},days:data.days||{}}]}
function snapshotForDate(data,iso){
 const dated=programSnapshots(data).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.meta?.date||"")).map(x=>({x,start:x.meta.date,end:addIsoDays(x.meta.date,6)})).filter(x=>x.start<=iso&&x.end>=iso).sort((a,b)=>b.start.localeCompare(a.start));
 return dated[0]?.x||null;
}
async function sendTwilioSms(to,message){
 const sid=process.env.TWILIO_ACCOUNT_SID,token=process.env.TWILIO_AUTH_TOKEN,from=process.env.TWILIO_FROM_NUMBER;
 if(!sid||!token||!from)throw new Error("Twilio environment variables are missing");
 const form=new URLSearchParams({To:to,From:from,Body:message}),r=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,{method:"POST",headers:{Authorization:"Basic "+Buffer.from(`${sid}:${token}`).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body:form.toString()});
 if(!r.ok)throw new Error(`Twilio ${r.status}: ${await r.text()}`);return r.json();
}
async function reminderAlreadySent(athleteId,type,date){const q=await pool.query(`select 1 from athlete_submissions where athlete_id=$1 and kind='reminder' and payload->>'type'=$2 and payload->>'date'=$3 limit 1`,[athleteId,type,date]);return q.rowCount>0}
async function recordReminder(athleteId,payload){await pool.query(`insert into athlete_submissions(athlete_id,kind,payload) values($1,'reminder',$2)`,[athleteId,payload])}
async function upsertSubmission(athleteId,kind,payload,actor){
 const client=await pool.connect();
 try{
  await client.query("begin");
  const resultId=String(payload?.id||"");
  if(resultId)await client.query(`delete from athlete_submissions where athlete_id=$1 and kind=$2 and payload->>'id'=$3`,[athleteId,kind,resultId]);
  await client.query(`insert into athlete_submissions(athlete_id,kind,payload) values($1,$2,$3)`,[athleteId,kind,payload||{}]);
  await client.query(`insert into athlete_submissions(athlete_id,kind,payload) values($1,'audit',$2)`,[athleteId,{action:resultId?"saved_or_updated":"saved",kind,resultId,actor,at:new Date().toISOString()}]);
  await client.query("commit");
 }catch(e){await client.query("rollback");throw e}finally{client.release()}
}
function athletePublicData(source){
 const clean=JSON.parse(JSON.stringify(source||{}));
 clean.athletes=[];clean.checkins=[];clean.sessionLogs=[];clean.testResults=[];clean.carnivalAvailability=[];
 return clean;
}

module.exports=async(req,res)=>{
  try{
    const u=new URL(req.url,"https://stroke-lab.local");
    const action=u.searchParams.get("action");

    if(action==="auto-create-week"&&req.method==="GET"){
      if(!process.env.CRON_SECRET||req.headers.authorization!==`Bearer ${process.env.CRON_SECRET}`)return send(res,401,{error:"Cron authorization invalid"});
      const today=sydneyDateParts();if(today.weekday!=="Sunday")return send(res,200,{ok:true,created:false,reason:"Not Sunday in Australia/Sydney"});
      const monday=addIsoDays(today.date,1),client=await pool.connect();
      try{
        await client.query("begin");await client.query("select pg_advisory_xact_lock(hashtext('stroke-lab-auto-week'))");
        const st=await client.query(`select data from app_state where id='master' for update`);if(!st.rowCount){await client.query("rollback");return send(res,404,{error:"No coach program found"})}
        const data=st.rows[0].data||{},all=programSnapshots(data),exists=all.find(x=>x.meta?.date===monday);
        if(exists){await client.query("commit");return send(res,200,{ok:true,created:false,reason:"Coming week already exists",meta:exists.meta})}
        const source=all.filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.meta?.date||"")&&x.meta.date<monday).sort((a,b)=>b.meta.date.localeCompare(a.meta.date))[0]||{meta:data.meta||{},days:data.days||{}};
        const currentKey=`${data.meta?.season||""}|${Number(data.meta?.blockNo)||1}|${Number(data.meta?.weekNo)||1}`,archive=[...(data.archive||[])];
        if(data.meta&&data.days&&!archive.some(x=>x.key===currentKey))archive.push({key:currentKey,savedAt:new Date().toISOString(),meta:data.meta,days:data.days});
        const meta=nextWeekMeta(source.meta,monday),days=JSON.parse(JSON.stringify(source.days||{}));applyAutomaticTesting(days,meta,data.carnivals||[],data.tests||[]);const next={...data,archive,meta,days};
        await client.query(`update app_state set data=$1,updated_at=now() where id='master'`,[next]);
        await client.query(`insert into athlete_submissions(athlete_id,kind,payload) values($1,'audit',$2)`,["system",{action:"auto_created_week",kind:"program",season:meta.season,blockNo:meta.blockNo,weekNo:meta.weekNo,date:monday,at:new Date().toISOString()}]);
        await client.query("commit");return send(res,200,{ok:true,created:true,meta});
      }catch(e){await client.query("rollback");throw e}finally{client.release()}
    }

    if((action==="session-reminders"||action==="checkin-reminders"||action==="daily-reminders")&&req.method==="GET"){
      if(!process.env.CRON_SECRET||req.headers.authorization!==`Bearer ${process.env.CRON_SECRET}`)return send(res,401,{error:"Cron authorization invalid"});
      const st=await pool.query(`select data from app_state where id='master'`);if(!st.rowCount)return send(res,404,{error:"No coach program found"});
      const data=st.rows[0].data||{},athletes=(data.athletes||[]).filter(a=>a.smsConsent&&/^\+[1-9]\d{7,14}$/.test(String(a.phone||"").replace(/\s/g,""))),today=sydneyDateParts(),sent=[],skipped=[];
      if(action==="session-reminders"||action==="daily-reminders"){
        const snap=snapshotForDate(data,today.date),sessions=(snap?.days?.[today.weekday]?.sessions||[]).filter(s=>s.type!=="Rest");
        if((!snap||!sessions.length)&&action==="session-reminders")return send(res,200,{ok:true,sent,reason:"No programmed sessions today"});
        if(snap&&sessions.length)for(const a of athletes){
          const q=await pool.query(`select payload from athlete_submissions where athlete_id=$1 and kind='session' and payload->>'season'=$2 and payload->>'blockNo'=$3 and payload->>'weekNo'=$4 and payload->>'day'=$5`,[String(a.id),String(snap.meta.season||""),String(Number(snap.meta.blockNo)||1),String(Number(snap.meta.weekNo)||1),today.weekday]);
          const completed=new Set(q.rows.map(x=>String(x.payload?.sessionId||""))),missing=sessions.filter(s=>!completed.has(String(s.id)));
          if(!missing.length||await reminderAlreadySent(String(a.id),"session",today.date)){skipped.push(a.id);continue}
          const titles=missing.map(s=>s.title||s.type||"training session").join(", "),message=`STROKE LAB: Hi ${a.name}, please complete today's ${today.weekday} training${missing.length>1?" sessions":" session"}: ${titles}.`;
          await sendTwilioSms(String(a.phone).replace(/\s/g,""),message);await recordReminder(String(a.id),{type:"session",date:today.date,season:snap.meta.season,blockNo:snap.meta.blockNo,weekNo:snap.meta.weekNo,day:today.weekday,sessionIds:missing.map(s=>s.id)});sent.push(a.id);
        }
      }
      if(action==="checkin-reminders"||(action==="daily-reminders"&&today.weekday==="Monday")){
        if(today.weekday!=="Monday")return send(res,200,{ok:true,sent,reason:"Not Monday in Australia/Sydney"});
        const previousDate=addIsoDays(today.date,-7),snap=snapshotForDate(data,previousDate);if(!snap)return send(res,200,{ok:true,sent,reason:"Previous training week not found"});
        for(const a of athletes){
          const q=await pool.query(`select 1 from athlete_submissions where athlete_id=$1 and kind='checkin' and payload->>'season'=$2 and payload->>'blockNo'=$3 and payload->>'weekNo'=$4 limit 1`,[String(a.id),String(snap.meta.season||""),String(Number(snap.meta.blockNo)||1),String(Number(snap.meta.weekNo)||1)]);
          if(q.rowCount||await reminderAlreadySent(String(a.id),"checkin",today.date)){skipped.push(a.id);continue}
          const message=`STROKE LAB: Hi ${a.name}, please complete your weekly check-in for Block ${Number(snap.meta.blockNo)||1}, Week ${Number(snap.meta.weekNo)||1}.`;
          await sendTwilioSms(String(a.phone).replace(/\s/g,""),message);await recordReminder(String(a.id),{type:"checkin",date:today.date,season:snap.meta.season,blockNo:snap.meta.blockNo,weekNo:snap.meta.weekNo});sent.push(a.id);
        }
      }
      return send(res,200,{ok:true,sent:sent.length,skipped:skipped.length});
    }

    if(action==="coach-sync" && req.method==="POST"){
      if(!coach(req)) return send(res,401,{error:"Coach key invalid"});
      const b=await body(req);
      await pool.query(
        `insert into app_state(id,data,updated_at) values('master',$1,now())
         on conflict(id) do update set data=excluded.data,updated_at=now()`,
        [b.data||{}]
      );
      return send(res,200,{ok:true});
    }
if(action==="coach-state"&&req.method==="GET"){if(!coach(req))return send(res,401,{error:"Coach key invalid"});const q=await pool.query(`select data,updated_at from app_state where id='master'`);if(!q.rowCount)return send(res,404,{error:"No coach program found"});return send(res,200,{data:q.rows[0].data,updatedAt:q.rows[0].updated_at});}
    if(action==="create-invite" && req.method==="POST"){
      if(!coach(req)) return send(res,401,{error:"Coach key invalid"});
      const b=await body(req), a=b.athlete;
      if(!a?.id||!a?.name) return send(res,400,{error:"Athlete required"});
      const token=crypto.randomBytes(24).toString("base64url");
      await pool.query(`update athlete_invites set active=false where athlete_id=$1`,[a.id]);
      await pool.query(
        `insert into athlete_invites(token,athlete_id,athlete_name,squad,active)
         values($1,$2,$3,$4,true)`,
        [token,a.id,a.name,a.squad||""]
      );
      return send(res,200,{token});
    }
    if(action==="revoke-athlete" && req.method==="POST"){if(!coach(req))return send(res,401,{error:"Coach key invalid"});const b=await body(req);const athleteId=String(b.athleteId||"").trim();if(!athleteId)return send(res,400,{error:"Athlete id required"});await pool.query(`update athlete_invites set active=false where athlete_id=$1`,[athleteId]);return send(res,200,{ok:true});}
    if(action==="invite-check"&&req.method==="GET"){const token=u.searchParams.get("token");const q=await pool.query(`select athlete_id from athlete_invites where token=$1 and active=true`,[token]);if(!q.rowCount)return send(res,404,{error:"Invite unavailable"});const st=await pool.query(`select data from app_state where id='master'`);if(!st.rowCount||!Array.isArray(st.rows[0].data?.athletes)||!st.rows[0].data.athletes.some(a=>String(a.id)===String(q.rows[0].athlete_id)))return send(res,404,{error:"Athlete removed"});return send(res,200,{ok:true});}
    if(action==="invite" && req.method==="GET"){
      const token=u.searchParams.get("token");
      const q=await pool.query(
        `select athlete_id,athlete_name,squad from athlete_invites
         where token=$1 and active=true`,
        [token]
      );
      if(!q.rowCount) return send(res,404,{error:"Invite unavailable"});
      const st=await pool.query(`select data from app_state where id='master'`);
      if(!st.rowCount) return send(res,404,{error:"Program not synced yet"});
     const a=q.rows[0];const hist=await pool.query(`select kind,payload,created_at from athlete_submissions where athlete_id=$1 and kind in ('checkin','session','test','availability') order by created_at desc limit 5000`,[a.athlete_id]);return send(res,200,{athlete:{id:a.athlete_id,name:a.athlete_name,squad:a.squad},data:athletePublicData(st.rows[0].data),history:hist.rows});
    }

    if(action==="athlete-submit" && req.method==="POST"){
      const b=await body(req);
      const q=await pool.query(
        `select athlete_id from athlete_invites where token=$1 and active=true`,
        [b.token]
      );
      if(!q.rowCount) return send(res,401,{error:"Invite unavailable"});
      const athleteId=q.rows[0].athlete_id,kind=b.kind||"unknown",payload=b.payload||{};
      if(!["checkin","session","test","availability"].includes(kind))return send(res,400,{error:"Submission type invalid"});
      await upsertSubmission(athleteId,kind,payload,"athlete");
      return send(res,200,{ok:true});
    }

    if(action==="coach-submissions" && req.method==="GET"){
      if(!coach(req)) return send(res,401,{error:"Coach key invalid"});
      const q=await pool.query(
        `select id,athlete_id,kind,payload,created_at
         from athlete_submissions order by created_at desc limit 5000`
      );
      return send(res,200,{items:q.rows});
    }

    if(action==="coach-upsert-result" && req.method==="POST"){
      if(!coach(req)) return send(res,401,{error:"Coach key invalid"});
      const b=await body(req),athleteId=String(b.athleteId||"").trim(),kind=String(b.kind||"unknown"),payload=b.payload||{},resultId=String(payload.id||"");
      if(!athleteId) return send(res,400,{error:"Athlete is required"});
      if(!["checkin","session","test","availability"].includes(kind))return send(res,400,{error:"Submission type invalid"});
      await upsertSubmission(athleteId,kind,payload,"coach");
      return send(res,200,{ok:true});
    }

    if(action==="delete-athlete-result" && req.method==="POST"){
      if(!coach(req)) return send(res,401,{error:"Coach key invalid"});
      const b=await body(req),athleteId=String(b.athleteId||"").trim(),resultId=String(b.resultId||"").trim();
      if(!athleteId||!resultId) return send(res,400,{error:"Athlete and result are required"});
      const client=await pool.connect();let deleted=0;
      try{
       await client.query("begin");
       const found=await client.query(`select payload from athlete_submissions where athlete_id=$1 and kind='session' and payload->>'id'=$2 limit 1`,[athleteId,resultId]);
       const session=found.rows[0]?.payload||{};
       const q=await client.query(`delete from athlete_submissions where athlete_id=$1 and kind='session' and payload->>'id'=$2`,[athleteId,resultId]);deleted+=q.rowCount;
       if(session.sessionId)deleted+=(await client.query(`delete from athlete_submissions where athlete_id=$1 and kind='test' and payload->>'sessionId'=$2 and payload->>'season'=$3 and payload->>'blockNo'=$4 and payload->>'weekNo'=$5`,[athleteId,String(session.sessionId),String(session.season||""),String(session.blockNo||""),String(session.weekNo||"")])).rowCount;
       await client.query(`insert into athlete_submissions(athlete_id,kind,payload) values($1,'audit',$2)`,[athleteId,{action:"deleted",kind:"session",resultId,actor:"coach",at:new Date().toISOString()}]);
       await client.query("commit");
      }catch(e){await client.query("rollback");throw e}finally{client.release()}
      return send(res,200,{ok:true,deleted});
    }

    return send(res,404,{error:"Unknown action"});
  }catch(e){
    console.error(e);
    return send(res,500,{error:"Server error"});
  }
};
