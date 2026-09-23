import { getStore } from "@netlify/blobs";
import { randomBytes, randomUUID } from "node:crypto";
import { json, normalizeEmail, sha, hashPassword, verifyPassword, createSession, getSession, destroySession } from "./_shared/auth.mts";

const RESET_MINUTES=30;
const RESET_PREFIX="reset/";
const RESET_USER_PREFIX="reset-user/";

async function sendResetEmail(email:string, token:string){
  const apiKey=Netlify.env.get("RESEND_API_KEY");
  const from=Netlify.env.get("NAJAVI_EMAIL_FROM")||"Najavi <noreply@reviewtrack.app>";
  const base=(Netlify.env.get("APP_BASE_URL")||"https://najavi.rs").replace(/\/$/,"");
  if(!apiKey)throw new Error("Email servis nije konfigurisan.");
  const resetUrl=`${base}/app/?reset=${encodeURIComponent(token)}`;
  const res=await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{"Authorization":`Bearer ${apiKey}`,"Content-Type":"application/json"},
    body:JSON.stringify({
      from,
      to:[email],
      subject:"Reset lozinke — Najavi",
      html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#17251c">
        <h2 style="margin:0 0 14px">Reset lozinke</h2>
        <p style="line-height:1.6;color:#5f7063">Dobili smo zahtev za promenu lozinke na Najavi nalogu.</p>
        <p style="margin:24px 0"><a href="${resetUrl}" style="display:inline-block;background:#3d9d5a;color:#fff;text-decoration:none;padding:13px 18px;border-radius:12px;font-weight:700">Postavi novu lozinku</a></p>
        <p style="line-height:1.6;color:#5f7063">Link važi ${RESET_MINUTES} minuta i može da se iskoristi samo jednom.</p>
        <p style="line-height:1.6;color:#8a988d;font-size:13px">Ako niste tražili reset lozinke, ignorišite ovu poruku.</p>
      </div>`,
      text:`Reset lozinke za Najavi\n\nOtvorite link: ${resetUrl}\n\nLink važi ${RESET_MINUTES} minuta i može da se iskoristi samo jednom.`
    })
  });
  if(!res.ok){
    const body=await res.text().catch(()=>"");
    throw new Error(`Email provider error ${res.status}: ${body.slice(0,180)}`);
  }
}

async function invalidateUserSessions(store:any,userId:string){
  const list=await store.list({prefix:"session/"});
  for(const blob of list.blobs){
    const row=await store.get(blob.key,{type:"json"}) as any;
    if(row?.userId===userId)await store.delete(blob.key);
  }
}

export default async (req:Request)=>{
  if(req.method==="GET"){
    const session=await getSession(req);
    return session?json({user:{id:session.userId,email:session.email}}):json({user:null},401);
  }
  if(req.method!=="POST")return json({error:"Method not allowed"},405);

  const body=await req.json().catch(()=>({})) as any;
  const action=String(body.action||"");
  const store=getStore("najava-auth",{consistency:"strong"});

  if(action==="logout"){
    const cookie=await destroySession(req);
    return json({ok:true},200,{"Set-Cookie":cookie});
  }

  if(action==="request-reset"){
    const email=normalizeEmail(body.email);
    if(!email.includes("@"))return json({error:"Unesite ispravan email."},400);

    const userKey="user/"+sha(email);
    const existing=await store.get(userKey,{type:"json"}) as any;
    if(existing){
      const token=randomBytes(32).toString("base64url");
      const tokenHash=sha(token);
      const expiresAt=Date.now()+RESET_MINUTES*60*1000;
      const activeKey=RESET_USER_PREFIX+existing.id;

      const previous=await store.get(activeKey,{type:"json"}) as any;
      if(previous?.tokenHash)await store.delete(RESET_PREFIX+previous.tokenHash);

      await store.setJSON(RESET_PREFIX+tokenHash,{userKey,userId:existing.id,email,expiresAt});
      await store.setJSON(activeKey,{tokenHash,expiresAt});
      try{
        await sendResetEmail(email,token);
      }catch(err){
        console.error("Najavi reset email failed",err);
      }
    }
    return json({ok:true,message:"Ako nalog sa tim emailom postoji, poslali smo link za reset lozinke."});
  }

  if(action==="reset-password"){
    const token=String(body.token||"");
    const password=String(body.password||"");
    if(token.length<20)return json({error:"Reset link nije važeći."},400);
    if(password.length<8)return json({error:"Nova lozinka mora imati najmanje 8 karaktera."},400);

    const tokenHash=sha(token);
    const resetKey=RESET_PREFIX+tokenHash;
    const reset=await store.get(resetKey,{type:"json"}) as any;
    if(!reset||Number(reset.expiresAt)<Date.now()){
      if(reset)await store.delete(resetKey);
      return json({error:"Reset link je istekao ili je već iskorišćen."},400);
    }

    const activeKey=RESET_USER_PREFIX+reset.userId;
    const active=await store.get(activeKey,{type:"json"}) as any;
    if(!active||active.tokenHash!==tokenHash||Number(active.expiresAt)<Date.now()){
      await store.delete(resetKey);
      return json({error:"Reset link više nije važeći."},400);
    }

    const existing=await store.get(reset.userKey,{type:"json"}) as any;
    if(!existing)return json({error:"Nalog više ne postoji."},404);

    const {salt,hash}=hashPassword(password);
    const updated={...existing,passwordSalt:salt,passwordHash:hash,passwordChangedAt:new Date().toISOString()};
    await store.setJSON(reset.userKey,updated);
    await store.delete(resetKey);
    await store.delete(activeKey);
    await invalidateUserSessions(store,existing.id);

    const session=await createSession(updated);
    return json({user:{id:updated.id,email:updated.email},message:"Lozinka je uspešno promenjena."},200,{"Set-Cookie":session.cookie});
  }

  const email=normalizeEmail(body.email);
  const password=String(body.password||"");
  if(!email.includes("@")||password.length<8)return json({error:"Unesite ispravan email i lozinku od najmanje 8 karaktera."},400);

  const userKey="user/"+sha(email);
  const existing=await store.get(userKey,{type:"json"}) as any;

  if(action==="register"){
    if(existing)return json({error:"Nalog sa ovim emailom već postoji."},409);
    const {salt,hash}=hashPassword(password);
    const user={id:randomUUID(),email,passwordSalt:salt,passwordHash:hash,createdAt:new Date().toISOString()};
    await store.setJSON(userKey,user);
    const session=await createSession(user);
    return json({user:{id:user.id,email:user.email}},201,{"Set-Cookie":session.cookie});
  }

  if(action==="login"){
    if(!existing||!verifyPassword(password,existing.passwordSalt,existing.passwordHash))return json({error:"Pogrešan email ili lozinka."},401);
    const session=await createSession(existing);
    return json({user:{id:existing.id,email:existing.email}},200,{"Set-Cookie":session.cookie});
  }

  return json({error:"Nepoznata akcija."},400);
};
export const config={path:"/api/auth"};
