import { getStore, getDeployStore } from "@netlify/blobs";
import { json, requireSession, normalizeEmail, sha } from "./_shared/auth.mts";

const DEFAULT_ADMIN_EMAILS=["office@studio7.rs","goran@studio7.rs"];
const TRACKING_STARTED_AT="2026-09-23T19:49:00Z";

function adminEmails(){
  const configured=String(Netlify.env.get("NAJAVI_ADMIN_EMAILS")||"")
    .split(",").map(normalizeEmail).filter(Boolean);
  return new Set([...DEFAULT_ADMIN_EMAILS,...configured]);
}
function isAdmin(email:string){ return adminEmails().has(normalizeEmail(email)); }
function internalEmails(){
  const configured=String(Netlify.env.get("NAJAVI_INTERNAL_EMAILS")||"")
    .split(",").map(normalizeEmail).filter(Boolean);
  return new Set([...adminEmails(),...configured]);
}

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
      const row={
        userId:session!.userId,
        firstOpenedAt:existing?.firstOpenedAt||now,
        lastOpenedAt:now,
        installed:Boolean(body.installed),
        userAgent:ua.slice(0,300)
      };
      await analytics.setJSON(key,row);

      const activityKey=`activity/${session!.userId}/${deviceHash}`;
      const activity=await analytics.get(activityKey,{type:"json"}) as any;
      await analytics.setJSON(activityKey,{
        userId:session!.userId,
        firstOpenedAt:activity?.firstOpenedAt||row.firstOpenedAt,
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
  const [userList,installList,pushList,activityList,openList]=await Promise.all([
    auth.list({prefix:"user/"}),
    analytics.list({prefix:"install/"}),
    push.list(),
    analytics.list({prefix:"activity/"}),
    analytics.list({prefix:"open/"})
  ]);

  const [users,installs,pushRows,activities,openRows]=await Promise.all([
    Promise.all(userList.blobs.map(b=>auth.get(b.key,{type:"json"}) as Promise<any>)),
    Promise.all(installList.blobs.map(b=>analytics.get(b.key,{type:"json"}) as Promise<any>)),
    Promise.all(pushList.blobs.map(b=>push.get(b.key,{type:"json"}) as Promise<any>)),
    Promise.all(activityList.blobs.map(b=>analytics.get(b.key,{type:"json"}) as Promise<any>)),
    Promise.all(openList.blobs.map(b=>analytics.get(b.key,{type:"json"}) as Promise<any>))
  ]);

  const internal=internalEmails();
  const validUsers=users.filter(u=>u?.id&&u?.email);
  const internalUsers=validUsers.filter(u=>internal.has(normalizeEmail(u.email)));
  const customerUsers=validUsers.filter(u=>!internal.has(normalizeEmail(u.email)));
  const customerIds=new Set(customerUsers.map(u=>String(u.id)));

  const cutoff1=daysAgo(1);
  const cutoff7=daysAgo(7);
  const cutoff30=daysAgo(30);

  const customerAccounts=customerUsers.length;
  const accounts7d=customerUsers.filter(u=>u?.createdAt&&new Date(u.createdAt).getTime()>=cutoff7).length;

  const installRows=installs.map((row,i)=>{
    const keyUserId=String(installList.blobs[i]?.key||"").split("/")[1]||"";
    return {...(row||{}),userId:String(row?.userId||keyUserId)};
  }).filter(row=>customerIds.has(row.userId));

  const everInstalledUserIds=new Set(installRows.map(row=>row.userId));
  const installs7d=installRows.filter(row=>row?.firstInstalledAt&&new Date(row.firstInstalledAt).getTime()>=cutoff7);
  const installedUsers7d=new Set(installs7d.map(row=>row.userId)).size;
  const activeInstallRows30d=installRows.filter(row=>row?.lastSeenAt&&new Date(row.lastSeenAt).getTime()>=cutoff30);
  const activeInstallUsers30d=new Set(activeInstallRows30d.map(row=>row.userId));

  const customerPushRows=pushRows.map((row,i)=>{
    const keyUserId=String(pushList.blobs[i]?.key||"").split("/")[0]||"";
    return {...(row||{}),userId:String(row?.userId||keyUserId)};
  }).filter(row=>customerIds.has(row.userId));
  const pushUserIds=new Set(customerPushRows.map(row=>row.userId));

  // Merge compact activity summaries with historical daily-open rows so the
  // dashboard remains correct across the analytics upgrade.
  const activityByDevice=new Map<string,{userId:string,lastOpenedAt:string,installed:boolean}>();
  const absorb=(row:any,keyFallback="")=>{
    const userId=String(row?.userId||keyFallback);
    const lastOpenedAt=String(row?.lastOpenedAt||row?.firstOpenedAt||"");
    if(!customerIds.has(userId)||!lastOpenedAt)return;
    const deviceKey=String(row?.deviceHash||"");
    const key=deviceKey?`${userId}/${deviceKey}`:`${userId}/${sha(String(row?.userAgent||"")+"|"+lastOpenedAt.slice(0,10))}`;
    const prev=activityByDevice.get(key);
    if(!prev||new Date(lastOpenedAt).getTime()>new Date(prev.lastOpenedAt).getTime()){
      activityByDevice.set(key,{userId,lastOpenedAt,installed:Boolean(row?.installed)});
    }
  };
  activities.forEach((row,i)=>{
    const parts=String(activityList.blobs[i]?.key||"").split("/");
    absorb({...row,deviceHash:parts[2]||""},parts[1]||"");
  });
  openRows.forEach((row,i)=>{
    const parts=String(openList.blobs[i]?.key||"").split("/");
    absorb({...row,deviceHash:parts[3]||""},parts[2]||"");
  });

  const activeUsersSince=(cutoff:number)=>{
    const ids=new Set<string>();
    for(const row of activityByDevice.values()){
      if(new Date(row.lastOpenedAt).getTime()>=cutoff)ids.add(row.userId);
    }
    return ids.size;
  };

  const activeUsers1d=activeUsersSince(cutoff1);
  const activeUsers7d=activeUsersSince(cutoff7);
  const activeUsers30d=activeUsersSince(cutoff30);
  const conversion=customerAccounts?Math.round((everInstalledUserIds.size/customerAccounts)*1000)/10:0;

  return json({
    generatedAt:new Date().toISOString(),
    trackingStartedAt:TRACKING_STARTED_AT,
    customerAccounts,
    totalAccounts:customerAccounts,
    accounts7d,
    internalAccounts:internalUsers.length,
    everInstalledUsers:everInstalledUserIds.size,
    installedUsers:everInstalledUserIds.size,
    installedUsers7d,
    deviceInstallations:installRows.length,
    activeInstallUsers30d:activeInstallUsers30d.size,
    activeInstallDevices30d:activeInstallRows30d.length,
    pushUsers:pushUserIds.size,
    pushDevices:customerPushRows.length,
    activeUsers1d,
    activeUsers7d,
    activeUsers30d,
    accountToInstallConversion:conversion
  });
};

export const config={path:"/api/analytics"};
