import { getStore, getDeployStore } from "@netlify/blobs";
import { json, requireSession, normalizeEmail, sha } from "./_shared/auth.mts";

const DEFAULT_ADMIN_EMAILS=["office@studio7.rs","goran@studio7.rs"];

function adminEmails(){
  const configured=String(Netlify.env.get("NAJAVI_ADMIN_EMAILS")||"")
    .split(",").map(normalizeEmail).filter(Boolean);
  return new Set(configured.length?configured:DEFAULT_ADMIN_EMAILS);
}
function isAdmin(email:string){ return adminEmails().has(normalizeEmail(email)); }

function analyticsStore(){
  const production=Netlify.env.get("CONTEXT")==="production";
  return production
    ? getStore("najava-analytics",{consistency:"strong"})
    : getDeployStore("najava-analytics");
}
function safeDeviceId(value:any){
  const raw=String(value||"").trim();
  return raw.length>=8&&raw.length<=160?raw:"";
}
function dayKey(date=new Date()){
  return date.toISOString().slice(0,10);
}
function daysAgo(n:number){
  return Date.now()-n*86400000;
}

export default async(req:Request)=>{
  const {error,session}=await requireSession(req); if(error)return error;
  const analytics=analyticsStore();

  if(req.method==="POST"){
    const body=await req.json().catch(()=>({})) as any;
    const event=String(body.event||"");
    const deviceId=safeDeviceId(body.deviceId);
    if(!deviceId)return json({error:"Nedostaje identifikator uređaja."},400);

    const deviceHash=sha(deviceId);
    const now=new Date().toISOString();
    const ua=req.headers.get("user-agent")||"";

    if(event==="install"){
      const key=`install/${session!.userId}/${deviceHash}`;
      const existing=await analytics.get(key,{type:"json"}) as any;
      await analytics.setJSON(key,{
        userId:session!.userId,
        firstInstalledAt:existing?.firstInstalledAt||now,
        lastSeenAt:now,
        source:String(body.source||"standalone").slice(0,40),
        userAgent:ua.slice(0,300)
      });
      return json({ok:true});
    }

    if(event==="app_open"){
      const key=`open/${dayKey()}/${session!.userId}/${deviceHash}`;
      const existing=await analytics.get(key,{type:"json"}) as any;
      await analytics.setJSON(key,{
        userId:session!.userId,
        firstOpenedAt:existing?.firstOpenedAt||now,
        lastOpenedAt:now,
        installed:Boolean(body.installed),
        userAgent:ua.slice(0,300)
      });
      return json({ok:true});
    }

    return json({error:"Nepoznat analytics događaj."},400);
  }

  if(req.method!=="GET")return json({error:"Method not allowed"},405);
  if(!isAdmin(session!.email))return json({error:"Nemate pristup analitici."},403);

  const auth=getStore("najava-auth",{consistency:"strong"});
  const push=getStore("najava-push",{consistency:"strong"});
  const [userList,installList,pushList,openList]=await Promise.all([
    auth.list({prefix:"user/"}),
    analytics.list({prefix:"install/"}),
    push.list(),
    analytics.list({prefix:"open/"})
  ]);

  const users=await Promise.all(userList.blobs.map(b=>auth.get(b.key,{type:"json"}) as Promise<any>));
  const installs=await Promise.all(installList.blobs.map(b=>analytics.get(b.key,{type:"json"}) as Promise<any>));

  const cutoff7=daysAgo(7);
  const totalAccounts=users.filter(Boolean).length;
  const accounts7d=users.filter(u=>u?.createdAt&&new Date(u.createdAt).getTime()>=cutoff7).length;

  const installedUserIds=new Set(installs.filter(Boolean).map(i=>String(i.userId||"")).filter(Boolean));
  const installs7d=installs.filter(i=>i?.firstInstalledAt&&new Date(i.firstInstalledAt).getTime()>=cutoff7);
  const installedUsers7d=new Set(installs7d.map(i=>String(i.userId||"")).filter(Boolean)).size;

  const pushUserIds=new Set(pushList.blobs.map(b=>String(b.key).split("/")[0]).filter(Boolean));

  const activeUserIds7d=new Set<string>();
  for(const blob of openList.blobs){
    const parts=String(blob.key).split("/");
    if(parts.length<4)continue;
    const date=Date.parse(parts[1]+"T00:00:00Z");
    if(Number.isFinite(date)&&date>=cutoff7)activeUserIds7d.add(parts[2]);
  }

  const conversion=totalAccounts?Math.round((installedUserIds.size/totalAccounts)*1000)/10:0;

  return json({
    generatedAt:new Date().toISOString(),
    totalAccounts,
    accounts7d,
    installedUsers:installedUserIds.size,
    installedUsers7d,
    deviceInstallations:installList.blobs.length,
    pushUsers:pushUserIds.size,
    pushDevices:pushList.blobs.length,
    activeUsers7d:activeUserIds7d.size,
    accountToInstallConversion:conversion
  });
};

export const config={path:"/api/analytics"};
