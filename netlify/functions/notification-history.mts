import { getStore } from "@netlify/blobs";
import { json, requireSession } from "./_shared/auth.mts";

export default async(req:Request)=>{
  const {error,session}=await requireSession(req); if(error)return error;
  if(req.method!=="GET")return json({error:"Method not allowed"},405);
  const store=getStore("najava-history",{consistency:"strong"});
  const list=await store.list({prefix:session!.userId+"/"});
  const items:any[]=[];
  for(const b of list.blobs){
    const row=await store.get(b.key,{type:"json"}) as any;
    if(row)items.push(row);
  }
  items.sort((a,b)=>String(b.sentAt||"").localeCompare(String(a.sentAt||"")));
  return json({items:items.slice(0,30)});
};
export const config={path:"/api/notification-history"};
