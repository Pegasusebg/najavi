import { getStore } from "@netlify/blobs";
import { json, requireSession } from "./_shared/auth.mts";

const defaults={addresses:[],prefs:{dayBefore:true,morning:true,twoHours:false}};
function clean(body:any){
  const addresses=Array.isArray(body.addresses)?body.addresses.slice(0,3).map((a:any)=>({
    id:String(a.id||crypto.randomUUID()),label:String(a.label||"").slice(0,40),street:String(a.street||"").slice(0,120),
    number:String(a.number||"").slice(0,20),municipality:String(a.municipality||"").slice(0,80),
    electricity:Boolean(a.electricity),water:Boolean(a.water)
  })).filter((a:any)=>a.label&&a.street&&a.number):[];
  const p=body.prefs||{};
  return {addresses,prefs:{dayBefore:Boolean(p.dayBefore),morning:Boolean(p.morning),twoHours:Boolean(p.twoHours)},updatedAt:new Date().toISOString()};
}
export default async(req:Request)=>{
  const {error,session}=await requireSession(req); if(error)return error;
  const store=getStore("najava-user-data",{consistency:"strong"});
  const key="user/"+session!.userId;
  if(req.method==="GET")return json(await store.get(key,{type:"json"})||defaults);
  if(req.method==="PUT"){
    const body=await req.json().catch(()=>({}));
    const data=clean(body);
    await store.setJSON(key,data);
    return json(data);
  }
  return json({error:"Method not allowed"},405);
};
export const config={path:"/api/user-data"};
