const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
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

module.exports=async(req,res)=>{
  try{
    const u=new URL(req.url,"https://stroke-lab.local");
    const action=u.searchParams.get("action");

    if((action==="session-reminders"||action==="checkin-reminders")&&req.method==="GET"){
      if(!process.env.CRON_SECRET||req.headers.authorization!==`Bearer ${process.env.CRON_SECRET}`)return send(res,401,{error:"Cron authorization invalid"});
      const st=await pool.query(`select data from app_state where id='master'`);if(!st.rowCount)return send(res,404,{error:"No coach program found"});
      const data=st.rows[0].data||{},athletes=(data.athletes||[]).filter(a=>a.smsConsent&&/^\+[1-9]\d{7,14}$/.test(String(a.phone||"").replace(/\s/g,""))),today=sydneyDateParts(),sent=[],skipped=[];
      if(action==="session-reminders"){
        const snap=snapshotForDate(data,today.date),sessions=(snap?.days?.[today.weekday]?.sessions||[]).filter(s=>s.type!=="Rest");
        if(!snap||!sessions.length)return send(res,200,{ok:true,sent,reason:"No programmed sessions today"});
        for(const a of athletes){
          const q=await pool.query(`select payload from athlete_submissions where athlete_id=$1 and kind='session' and payload->>'season'=$2 and payload->>'blockNo'=$3 and payload->>'weekNo'=$4 and payload->>'day'=$5`,[String(a.id),String(snap.meta.season||""),String(Number(snap.meta.blockNo)||1),String(Number(snap.meta.weekNo)||1),today.weekday]);
          const completed=new Set(q.rows.map(x=>String(x.payload?.sessionId||""))),missing=sessions.filter(s=>!completed.has(String(s.id)));
          if(!missing.length||await reminderAlreadySent(String(a.id),"session",today.date)){skipped.push(a.id);continue}
          const titles=missing.map(s=>s.title||s.type||"training session").join(", "),message=`STROKE LAB: Hi ${a.name}, please complete today's ${today.weekday} training${missing.length>1?" sessions":" session"}: ${titles}.`;
          await sendTwilioSms(String(a.phone).replace(/\s/g,""),message);await recordReminder(String(a.id),{type:"session",date:today.date,season:snap.meta.season,blockNo:snap.meta.blockNo,weekNo:snap.meta.weekNo,day:today.weekday,sessionIds:missing.map(s=>s.id)});sent.push(a.id);
        }
      }else{
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
     const a=q.rows[0];const hist=await pool.query(`select kind,payload,created_at from athlete_submissions where athlete_id=$1 order by created_at desc limit 500`,[a.athlete_id]);return send(res,200,{athlete:{id:a.athlete_id,name:a.athlete_name,squad:a.squad},data:st.rows[0].data,history:hist.rows});
    }

    if(action==="athlete-submit" && req.method==="POST"){
      const b=await body(req);
      const q=await pool.query(
        `select athlete_id from athlete_invites where token=$1 and active=true`,
        [b.token]
      );
      if(!q.rowCount) return send(res,401,{error:"Invite unavailable"});
      const athleteId=q.rows[0].athlete_id,kind=b.kind||"unknown",payload=b.payload||{},resultId=String(payload.id||"");
      if(resultId)await pool.query(
        `delete from athlete_submissions where athlete_id=$1 and kind=$2 and payload->>'id'=$3`,
        [athleteId,kind,resultId]
      );
      await pool.query(
        `insert into athlete_submissions(athlete_id,kind,payload) values($1,$2,$3)`,
        [athleteId,kind,payload]
      );
      return send(res,200,{ok:true});
    }

    if(action==="coach-submissions" && req.method==="GET"){
      if(!coach(req)) return send(res,401,{error:"Coach key invalid"});
      const q=await pool.query(
        `select id,athlete_id,kind,payload,created_at
         from athlete_submissions order by created_at desc limit 500`
      );
      return send(res,200,{items:q.rows});
    }

    if(action==="coach-upsert-result" && req.method==="POST"){
      if(!coach(req)) return send(res,401,{error:"Coach key invalid"});
      const b=await body(req),athleteId=String(b.athleteId||"").trim(),kind=String(b.kind||"unknown"),payload=b.payload||{},resultId=String(payload.id||"");
      if(!athleteId) return send(res,400,{error:"Athlete is required"});
      if(resultId)await pool.query(
        `delete from athlete_submissions where athlete_id=$1 and kind=$2 and payload->>'id'=$3`,
        [athleteId,kind,resultId]
      );
      await pool.query(`insert into athlete_submissions(athlete_id,kind,payload) values($1,$2,$3)`,[athleteId,kind,payload]);
      return send(res,200,{ok:true});
    }

    if(action==="delete-athlete-result" && req.method==="POST"){
      if(!coach(req)) return send(res,401,{error:"Coach key invalid"});
      const b=await body(req),athleteId=String(b.athleteId||"").trim(),resultId=String(b.resultId||"").trim();
      if(!athleteId||!resultId) return send(res,400,{error:"Athlete and result are required"});
      const q=await pool.query(
        `delete from athlete_submissions
         where athlete_id=$1 and kind='session' and payload->>'id'=$2
         returning id`,
        [athleteId,resultId]
      );
      return send(res,200,{ok:true,deleted:q.rowCount});
    }

    return send(res,404,{error:"Unknown action"});
  }catch(e){
    console.error(e);
    return send(res,500,{error:"Server error"});
  }
};
