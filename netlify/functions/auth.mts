import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";
import { json, normalizeEmail, sha, hashPassword, verifyPassword, createSession, getSession, destroySession } from "./_shared/auth.mts";

export default async (req:Request)=>{
  if(req.method==="GET"){
    const session=await getSession(req);
    return session?json({user:{id:session.userId,email:session.email}}):json({user:null},401);
  }
  if(req.method!=="POST")return json({error:"Method not allowed"},405);
  const body=await req.json().catch(()=>({})) as any;
  const action=String(body.action||"");
  if(action==="logout"){
    const cookie=await destroySession(req);
    return json({ok:true},200,{"Set-Cookie":cookie});
  }
  const email=normalizeEmail(body.email);
  const password=String(body.password||"");
  if(!email.includes("@")||password.length<8)return json({error:"Unesite ispravan email i lozinku od najmanje 8 karaktera."},400);

  const store=getStore("najava-auth",{consistency:"strong"});
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
