import { getStore } from "@netlify/blobs";
import { json, requireSession, sha } from "./_shared/auth.mts";

export default async(req:Request)=>{
  const {error,session}=await requireSession(req); if(error)return error;
  if(req.method!=="POST"&&req.method!=="DELETE")return json({error:"Method not allowed"},405);
  const store=getStore("najava-push",{consistency:"strong"});
  if(req.method==="DELETE"){
    const list=await store.list({prefix:session!.userId+"/"});
    await Promise.all(list.blobs.map(b=>store.delete(b.key)));
    return json({ok:true});
  }
  const body=await req.json().catch(()=>({})) as any;
  const sub=body.subscription;
  if(!sub?.endpoint||!sub?.keys?.p256dh||!sub?.keys?.auth)return json({error:"Neispravna push pretplata."},400);
  const key=session!.userId+"/"+sha(String(sub.endpoint));
  const existing=await store.get(key,{type:"json"}) as any;
  const now=new Date().toISOString();
  await store.setJSON(key,{
    userId:session!.userId,
    subscription:sub,
    createdAt:existing?.createdAt||now,
    lastSeenAt:now,
    userAgent:req.headers.get("user-agent")||""
  });
  return json({ok:true});
};
export const config={path:"/api/push-subscribe"};
