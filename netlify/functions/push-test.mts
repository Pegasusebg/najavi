import webpush from "web-push";
import { getStore } from "@netlify/blobs";
import { json, requireSession } from "./_shared/auth.mts";

export default async(req:Request)=>{
  const {error,session}=await requireSession(req); if(error)return error;
  if(req.method!=="POST")return json({error:"Method not allowed"},405);
  const pub=Netlify.env.get("VAPID_PUBLIC_KEY"),priv=Netlify.env.get("VAPID_PRIVATE_KEY"),subject=Netlify.env.get("VAPID_SUBJECT")||"https://www.studio7.rs";
  if(!pub||!priv)return json({error:"Push nije konfigurisan."},503);
  webpush.setVapidDetails(subject,pub,priv);
  const store=getStore("najava-push",{consistency:"strong"});
  const historyStore=getStore("najava-history",{consistency:"strong"});
  const list=await store.list({prefix:session!.userId+"/"});
  if(!list.blobs.length)return json({error:"Nema registrovanog uređaja."},404);
  let sent=0;
  const errors:any[]=[];
  for(const b of list.blobs){
    const row=await store.get(b.key,{type:"json"}) as any;
    try{
      await webpush.sendNotification(row.subscription,JSON.stringify({title:"Najavi je spreman",body:"Push obaveštenja rade na ovom uređaju.",url:"/",tag:"najavi-test"}));
      sent++;
    }catch(e:any){
      errors.push({statusCode:e?.statusCode||null,message:e?.message||String(e),body:e?.body||null});
      if(e?.statusCode===404||e?.statusCode===410)await store.delete(b.key);
    }
  }
  if(sent>0){
    const sentAt=new Date().toISOString();
    await historyStore.setJSON(`${session!.userId}/${Date.now()}-test`,{
      id:"test-"+Date.now(),kind:"test",sentAt,
      title:"Najavi je spreman",body:"Test push notifikacija je uspešno poslata.",
      utility:null,addressLabel:null,street:null,number:null,outageDate:null,start:null,end:null
    });
  }
  if(sent===0){
    const first=errors[0];
    return json({
      error:first?.statusCode===403?"Push servis je odbio VAPID autorizaciju.":first?.statusCode===404||first?.statusCode===410?"Push pretplata je istekla. Uključi push ponovo.":"Server nije uspeo da pošalje push notifikaciju.",
      details:first?.message||first?.body||null,
      sent:0
    },502);
  }
  return json({ok:true,sent});
};
export const config={path:"/api/push-test"};
