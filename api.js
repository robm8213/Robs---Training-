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

module.exports=async(req,res)=>{
  try{
    const u=new URL(req.url,"https://robs-training.local");
    const action=u.searchParams.get("action");

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
      await pool.query(
        `insert into athlete_submissions(athlete_id,kind,payload)
         values($1,$2,$3)`,
        [q.rows[0].athlete_id,b.kind||"unknown",b.payload||{}]
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
