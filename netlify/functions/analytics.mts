import { getStore, getDeployStore } from "@netlify/blobs";
import { json, requireSession, normalizeEmail, sha } from "./_shared/auth.mts";

const DEFAULT_ADMIN_EMAILS=["office@studio7.rs","goran@studio7.rs"];
const TRACKING_STARTED_AT="2026-09-23T19:49:00Z";
const LANDING_TRACKING_STARTED_AT="2026-09-23T21:13:17Z";

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
function safeId(value:any){
  const raw=String(value||"").trim();
  return raw.length>=8&&raw.length<=180?raw:"";
}
function belgradeDayKey(value:Date|string|number=new Date()){
  const d=value instanceof Date?value:new Date(value);
  const parts=new Intl.DateTimeFormat("en-GB",{
    timeZone:"Europe/Belgrade",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(d);
  const get=(type:string)=>parts.find(p=>p.type===type)?.value||"";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function shiftDay(day:string,delta:number){
  const [y,m,d]=day.split("-").map(Number);
  const date=new Date(Date.UTC(y,m-1,d+delta,12,0,0));
  return date.toISOString().slice(0,10);
}
function validDay(value:string|null){
  return Boolean(value&&/^\d{4}-\d{2}-\d{2}$/.test(value));
}
function resolveRange(url:URL){
  const key=String(url.searchParams.get("range")||"30d");
  const today=belgradeDayKey();
  if(key==="all")return {key,from:"0001-01-01",to:today};
  if(key==="today")return {key,from:today,to:today};
  if(key==="custom"){
    const from=String(url.searchParams.get("from")||"");
    const to=String(url.searchParams.get("to")||"");
    if(!validDay(from)||!validDay(to)||from>to)return null;
    return {key,from,to};
  }
  const days=key==="7d"?7:key==="90d"?90:30;
  return {key:days+"d",from:shiftDay(today,-(days-1)),to:today};
}
function inRangeDay(day:string,range:{from:string,to:string}){
  return day>=range.from&&day<=range.to;
}
function inRangeIso(value:any,range:{from:string,to:string}){
  if(!value)return false;
  const d=new Date(value);
  if(Number.isNaN(d.getTime()))return false;
  return inRangeDay(belgradeDayKey(d),range);
}

export default async(req:Request)=>{
  const analytics=analyticsStore();

  if(req.method==="POST"){
    const body=await req.json().catch(()=>({})) as any;
    const event=String(body.event||"");
    const now=new Date().toISOString();

    // Landing analytics is deliberately anonymous and does not require login.
    if(event==="landing_view"){
      const visitorId=safeId(body.visitorId);
      const viewId=safeId(body.viewId);
      if(!visitorId||!viewId)return json({error:"Neispravan analytics identifikator."},400);
      const day=belgradeDayKey();
      const visitorHash=sha(visitorId);
      const viewHash=sha(viewId);
      await Promise.all([
        analytics.setJSON(`landing-visitor/${day}/${visitorHash}`,{
          firstSeenAt:now,lastSeenAt:now,path:"/"
        }),
        analytics.setJSON(`landing-view/${day}/${viewHash}`,{
          visitorHash,at:now,path:"/"
        })
      ]);
      return json({ok:true});
    }

    const {error,session}=await requireSession(req); if(error)return error;
    const deviceId=safeId(body.deviceId);
    if(!deviceId)return json({error:"Nedostaje identifikator uređaja."},400);
    const deviceHash=sha(deviceId);
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

    if(event==="push_enabled"){
      const key=`push-enabled/${session!.userId}/${deviceHash}`;
      const existing=await analytics.get(key,{type:"json"}) as any;
      await analytics.setJSON(key,{
        userId:session!.userId,
        firstEnabledAt:existing?.firstEnabledAt||now,
        lastSeenAt:now,
        source:String(body.source||"app").slice(0,40),
        userAgent:ua.slice(0,300)
      });
      return json({ok:true});
    }

    if(event==="app_open"){
      const day=belgradeDayKey();
      const key=`open/${day}/${session!.userId}/${deviceHash}`;
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
  const {error,session}=await requireSession(req); if(error)return error;
  if(!isAdmin(session!.email))return json({error:"Nemate pristup analitici."},403);

  const range=resolveRange(new URL(req.url));
  if(!range)return json({error:"Neispravan vremenski raspon."},400);

  const auth=getStore("najava-auth",{consistency:"strong"});
  const push=getStore("najava-push",{consistency:"strong"});
  const [userList,installList,pushList,pushEnabledList,openList,landingVisitorList,landingViewList]=await Promise.all([
    auth.list({prefix:"user/"}),
    analytics.list({prefix:"install/"}),
    push.list(),
    analytics.list({prefix:"push-enabled/"}),
    analytics.list({prefix:"open/"}),
    analytics.list({prefix:"landing-visitor/"}),
    analytics.list({prefix:"landing-view/"})
  ]);

  const [users,installs,pushRows,pushEnabledRows]=await Promise.all([
    Promise.all(userList.blobs.map(b=>auth.get(b.key,{type:"json"}) as Promise<any>)),
    Promise.all(installList.blobs.map(b=>analytics.get(b.key,{type:"json"}) as Promise<any>)),
    Promise.all(pushList.blobs.map(b=>push.get(b.key,{type:"json"}) as Promise<any>)),
    Promise.all(pushEnabledList.blobs.map(b=>analytics.get(b.key,{type:"json"}) as Promise<any>))
  ]);

  const internal=internalEmails();
  const validUsers=users.filter(u=>u?.id&&u?.email);
  const internalUsers=validUsers.filter(u=>internal.has(normalizeEmail(u.email)));
  const customerUsers=validUsers.filter(u=>!internal.has(normalizeEmail(u.email)));
  const validIds=new Set(validUsers.map(u=>String(u.id)));
  const customerIds=new Set(customerUsers.map(u=>String(u.id)));
  const internalIds=new Set(internalUsers.map(u=>String(u.id)));

  // "Aktivni nalog" here means an existing, non-deleted account in auth.
  // Range controls the "new in period" submetric, not whether the account still exists.
  const totalRegisteredAccounts=validUsers.length;
  const totalCustomerAccounts=customerUsers.length;
  const totalInternalAccounts=internalUsers.length;
  const registrationsInRange=validUsers.filter(u=>inRangeIso(u?.createdAt,range)).length;
  const customerRegistrationsInRange=customerUsers.filter(u=>inRangeIso(u?.createdAt,range)).length;

  const installRows=installs.map((row,i)=>{
    const keyUserId=String(installList.blobs[i]?.key||"").split("/")[1]||"";
    return {...(row||{}),userId:String(row?.userId||keyUserId)};
  }).filter(row=>validIds.has(row.userId));
  const installedIdsAll=new Set(installRows.map(row=>row.userId));
  const installedCustomerIdsAll=new Set(installRows.filter(row=>customerIds.has(row.userId)).map(row=>row.userId));
  const installedInternalIdsAll=new Set(installRows.filter(row=>internalIds.has(row.userId)).map(row=>row.userId));
  const installedInRange=new Set(
    installRows.filter(row=>inRangeIso(row?.firstInstalledAt,range)).map(row=>row.userId)
  );

  const normalizedPushRows=pushRows.map((row,i)=>{
    const keyUserId=String(pushList.blobs[i]?.key||"").split("/")[0]||"";
    return {...(row||{}),userId:String(row?.userId||keyUserId)};
  }).filter(row=>validIds.has(row.userId));
  const currentPushIds=new Set(normalizedPushRows.map(row=>row.userId));
  const currentPushCustomerIds=new Set(normalizedPushRows.filter(row=>customerIds.has(row.userId)).map(row=>row.userId));
  const currentPushInternalIds=new Set(normalizedPushRows.filter(row=>internalIds.has(row.userId)).map(row=>row.userId));
  const pushEnabledFromStoreInRange=new Set(
    normalizedPushRows.filter(row=>inRangeIso(row?.createdAt,range)).map(row=>row.userId)
  );

  const pushEnabledRowsNormalized=pushEnabledRows.map((row,i)=>{
    const keyUserId=String(pushEnabledList.blobs[i]?.key||"").split("/")[1]||"";
    return {...(row||{}),userId:String(row?.userId||keyUserId)};
  }).filter(row=>validIds.has(row.userId));
  const pushEnabledFromEventsInRange=new Set(
    pushEnabledRowsNormalized.filter(row=>inRangeIso(row?.firstEnabledAt,range)).map(row=>row.userId)
  );
  const notificationsEnabledInRange=new Set([
    ...pushEnabledFromStoreInRange,
    ...pushEnabledFromEventsInRange
  ]);

  const landingUniqueSet=new Set<string>();
  for(const blob of landingVisitorList.blobs){
    const parts=String(blob.key).split("/");
    if(parts.length<3)continue;
    if(inRangeDay(parts[1],range))landingUniqueSet.add(parts[2]);
  }
  let landingPageViews=0;
  for(const blob of landingViewList.blobs){
    const parts=String(blob.key).split("/");
    if(parts.length>=3&&inRangeDay(parts[1],range))landingPageViews++;
  }

  return json({
    generatedAt:new Date().toISOString(),
    trackingStartedAt:TRACKING_STARTED_AT,
    landingTrackingStartedAt:LANDING_TRACKING_STARTED_AT,
    range,
    landingUniqueVisitors:landingUniqueSet.size,
    landingPageViews,
    registrationsInRange,
    customerRegistrationsInRange,
    activeRegisteredAccounts:totalRegisteredAccounts,
    totalRegisteredAccounts,
    totalCustomerAccounts,
    totalInternalAccounts,
    notificationsEnabledInRange:notificationsEnabledInRange.size,
    currentPushUsers:currentPushIds.size,
    currentPushCustomerUsers:currentPushCustomerIds.size,
    currentPushInternalUsers:currentPushInternalIds.size,
    installsInRange:installedInRange.size,
    everInstalledUsers:installedIdsAll.size,
    everInstalledCustomerUsers:installedCustomerIdsAll.size,
    everInstalledInternalUsers:installedInternalIdsAll.size,
    deviceInstallations:installRows.length
  });
};

export const config={path:"/api/analytics"};
