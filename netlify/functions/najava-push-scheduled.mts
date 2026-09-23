import webpush from "web-push";
import { getStore } from "@netlify/blobs";

const CYR:any={'а':'a','б':'b','в':'v','г':'g','д':'d','ђ':'dj','е':'e','ж':'z','з':'z','и':'i','ј':'j','к':'k','л':'l','љ':'lj','м':'m','н':'n','њ':'nj','о':'o','п':'p','р':'r','с':'s','т':'t','ћ':'c','у':'u','ф':'f','х':'h','ц':'c','ч':'c','џ':'dz','ш':'s'};
const translit=(s="")=>String(s).toLowerCase().split("").map(ch=>CYR[ch]||ch).join("");
const norm=(s="")=>translit(s).normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();
function normStreet(s=""){let x=norm(s).replace(/^ulica\s+/,"").replace(/\s+ulica$/,"").trim();const p=x.split(" ");let w=p[p.length-1]||"";if(/skoj$/.test(w))w=w.replace(/skoj$/,"ska");else if(/evoj$/.test(w))w=w.replace(/evoj$/,"eva");else if(/ovoj$/.test(w))w=w.replace(/ovoj$/,"ova");else if(/ckoj$/.test(w))w=w.replace(/ckoj$/,"cka");else if(/oj$/.test(w)&&w.length>4)w=w.replace(/oj$/,"a");if(p.length)p[p.length-1]=w;return p.join(" ")}
const houseNum=(v:any)=>{const m=String(v||"").match(/\d+/);return m?Number(m[0]):null};
function matchesNumberSpec(spec:any,n:any){if(n==null||!spec)return false;return String(spec).split(",").some(raw=>{const t=raw.trim();const nums=(t.match(/\d+/g)||[]).map(Number);if(!nums.length)return false;if(t.includes("-")&&nums.length>=2){const a=nums[0],b=nums[1],lo=Math.min(a,b),hi=Math.max(a,b);if(n<lo||n>hi)return false;if(a>0&&b>0&&a%2===b%2&&Math.abs(a-b)>=2)return n%2===a%2;return true}return n===nums[0]})}
function match(a:any,e:any){if(a.municipality&&norm(a.municipality)!==norm(e.municipality))return false;if(normStreet(a.street)!==normStreet(e.street))return false;if(e.utility==="electricity"&&!a.electricity)return false;if(e.utility==="water"&&!a.water)return false;const n=houseNum(a.number);if(e.scope==="all")return true;if(e.scope==="numbers")return matchesNumberSpec(e.numberSpec,n);return true}
function offsetFor(date:string){const d=new Date(date+"T12:00:00Z");const z=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Belgrade",timeZoneName:"shortOffset",hour:"2-digit"}).formatToParts(d).find(p=>p.type==="timeZoneName")?.value||"GMT+1";const m=z.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);const mins=m?(Number(m[2])*60+Number(m[3]||0))*(m[1]==="-"?-1:1):60;const sign=mins>=0?"+":"-";const abs=Math.abs(mins);return sign+String(Math.floor(abs/60)).padStart(2,"0")+":"+String(abs%60).padStart(2,"0")}
function eventDate(e:any){return new Date(`${e.date}T${e.start}:00${offsetFor(e.date)}`)}
function localParts(d=new Date()){const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Belgrade",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(d);const g=(t:string)=>p.find(x=>x.type===t)?.value||"";return {date:`${g("year")}-${g("month")}-${g("day")}`,hour:Number(g("hour"))}}
function kindFor(e:any,prefs:any,now=new Date()){const diff=(eventDate(e).getTime()-now.getTime())/3600000;const lp=localParts(now);if(prefs.twoHours&&diff>=1.5&&diff<2.5)return"twoHours";if(prefs.dayBefore&&diff>=23.5&&diff<24.5)return"dayBefore";if(prefs.morning&&e.date===lp.date&&lp.hour>=7&&lp.hour<9&&diff>0)return"morning";return null}
function copy(kind:string,e:any,a:any){const utility=e.utility==="electricity"?"struje":"vode";const prefix=kind==="dayBefore"?"Sutra":kind==="twoHours"?"Za oko 2 sata":"Danas";return {title:`${prefix}: prekid ${utility} — ${a.label}`,body:`${a.street} ${a.number} · ${e.start}–${e.end}`,url:"/app/",tag:`najavi-${e.id}-${kind}`}}
export default async()=>{
  const pub=Netlify.env.get("VAPID_PUBLIC_KEY"),priv=Netlify.env.get("VAPID_PRIVATE_KEY"),subject=Netlify.env.get("VAPID_SUBJECT")||"https://najavi.rs";
  if(!pub||!priv)return;
  webpush.setVapidDetails(subject,pub,priv);
  const res=await fetch("https://najavi.rs/api/outages").catch(()=>null);
  if(!res?.ok)return;
  const payload:any=await res.json(); const events=Array.isArray(payload.events)?payload.events:[];
  const dataStore=getStore("najava-user-data",{consistency:"strong"});
  const pushStore=getStore("najava-push",{consistency:"strong"});
  const sentStore=getStore("najava-sent",{consistency:"strong"});
  const historyStore=getStore("najava-history",{consistency:"strong"});
  const users=await dataStore.list({prefix:"user/"});
  const now=new Date();
  for(const ub of users.blobs){
    const userId=ub.key.slice(5); const data=await dataStore.get(ub.key,{type:"json"}) as any;
    if(!data?.addresses?.length)continue;
    const subs=await pushStore.list({prefix:userId+"/"}); if(!subs.blobs.length)continue;
    for(const a of data.addresses)for(const e of events){
      if(!match(a,e))continue;
      const kind=kindFor(e,data.prefs||{},now); if(!kind)continue;
      const sentKey=`${userId}/${e.id}/${kind}`; if(await sentStore.get(sentKey))continue;
      const msg=JSON.stringify(copy(kind,e,a)); let any=false;
      for(const sb of subs.blobs){
        const row=await pushStore.get(sb.key,{type:"json"}) as any;
        try{await webpush.sendNotification(row.subscription,msg);any=true}catch(err:any){if(err?.statusCode===404||err?.statusCode===410)await pushStore.delete(sb.key)}
      }
      if(any){
        const sentAt=new Date().toISOString();
        await sentStore.setJSON(sentKey,{sentAt});
        const notification=copy(kind,e,a);
        await historyStore.setJSON(`${userId}/${Date.now()}-${e.id}-${kind}`,{
          id:`${e.id}-${kind}`,kind,sentAt,
          title:notification.title,body:notification.body,
          utility:e.utility,addressLabel:a.label,street:a.street,number:a.number,
          outageDate:e.date,start:e.start,end:e.end
        });
      }
    }
  }
};
export const config={schedule:"*/30 * * * *"};
