import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SESSION_DAYS = 30;
const authStore = () => getStore("najava-auth", { consistency: "strong" });

export const json = (data: unknown, status=200, headers: Record<string,string>={}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type":"application/json; charset=utf-8", ...headers } });

export const sha = (value:string) => createHash("sha256").update(value).digest("hex");
export const normalizeEmail = (value:string) => String(value||"").trim().toLowerCase();

function parseCookies(req:Request){
  const raw=req.headers.get("cookie")||"";
  return Object.fromEntries(raw.split(";").map(v=>v.trim()).filter(Boolean).map(v=>{
    const i=v.indexOf("="); return i<0?[v,""]:[v.slice(0,i),decodeURIComponent(v.slice(i+1))];
  }));
}

export function hashPassword(password:string, salt=randomBytes(16).toString("hex")){
  const derived=scryptSync(password,salt,64).toString("hex");
  return {salt,hash:derived};
}
export function verifyPassword(password:string,salt:string,stored:string){
  const a=Buffer.from(scryptSync(password,salt,64));
  const b=Buffer.from(stored,"hex");
  return a.length===b.length && timingSafeEqual(a,b);
}

export async function createSession(user:{id:string,email:string}){
  const token=randomBytes(32).toString("base64url");
  const expiresAt=Date.now()+SESSION_DAYS*86400000;
  await authStore().setJSON("session/"+sha(token),{userId:user.id,email:user.email,expiresAt});
  const cookie=`najava_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS*86400}`;
  return {token,cookie,expiresAt};
}

export async function getSession(req:Request){
  const token=parseCookies(req).najava_session;
  if(!token)return null;
  const key="session/"+sha(token);
  const session=await authStore().get(key,{type:"json"}) as any;
  if(!session)return null;
  if(Number(session.expiresAt)<Date.now()){ await authStore().delete(key); return null; }
  return {...session,token,key};
}

export async function requireSession(req:Request){
  const session=await getSession(req);
  if(!session) return {error:json({error:"Niste prijavljeni."},401),session:null};
  return {error:null,session};
}

export async function destroySession(req:Request){
  const session=await getSession(req);
  if(session)await authStore().delete(session.key);
  return "najava_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
}
