
const EDS_SOURCE = "https://elektrodistribucija.rs/planirana-iskljucenja/planirana-bgd";
const EDS_DAY_BASE = "https://elektrodistribucija.rs/planirana-iskljucenja-beograd";
const WATER_LIST = "https://www.beograd.rs/lat/servisne-informacije/vodovod-i-kanalizacija";
const HEATING_LIST = "https://www.beograd.rs/lat/servisne-informacije/grejanje";
const HEATING_PLANNED = "https://beoelektrane.co.rs/planirani-radovi/radovi-na-toplovodnoj-mrezi/";

const MUNICIPALITIES = [
  "Barajevo","Čukarica","Grocka","Lazarevac","Mladenovac","Novi Beograd","Obrenovac",
  "Palilula","Rakovica","Savski venac","Sopot","Stari grad","Surčin","Voždovac","Vračar","Zemun","Zvezdara"
];

const MONTHS: Record<string, number> = {
  januara:1, februara:2, marta:3, aprila:4, maja:5, juna:6,
  jula:7, avgusta:8, septembra:9, oktobra:10, novembra:11, decembra:12
};

type OutageEvent = {
  id: string;
  utility: "electricity" | "water" | "heating";
  date: string;
  endDate?: string | null;
  start: string;
  end: string;
  municipality: string;
  street: string;
  numberSpec: string;
  scope: "numbers" | "all" | "partial";
  source: string;
  sourceUrl: string;
  note: string;
  kind?: "outage" | "planned_work";
  publishedAt?: string | null;
};

function decodeHtml(input = "") {
  const named: Record<string,string> = {amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" "};
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h,16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d,10)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

function cleanText(input = "") {
  return decodeHtml(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h1|h2|h3|h4|section|article)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
  .replace(/\r/g,"")
  .replace(/[ \t]+/g," ")
  .replace(/\n[ \t]+/g,"\n")
  .replace(/\n{3,}/g,"\n\n")
  .trim();
}

function inlineText(input = "") {
  return cleanText(input).replace(/\s+/g," ").trim();
}

function titleText(html: string) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? inlineText(m[1]) : "";
}

async function fetchText(url: string) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Najava/0.1 (+public utility outage notifier; source reader)",
      "Accept": "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(url + " -> HTTP " + res.status);
  return await res.text();
}

function isoDate(y: number, m: number, d: number) {
  return [y, String(m).padStart(2,"0"), String(d).padStart(2,"0")].join("-");
}

function extractSerbianDate(text: string): string | null {
  const monthNames = Object.keys(MONTHS).join("|");
  const m = text.match(new RegExp("(\\d{1,2})\\.\\s*(" + monthNames + ")\\s*(\\d{4})","i"));
  if (!m) return null;
  return isoDate(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
}

function stableId(parts: string[]) {
  let h = 2166136261;
  const s = parts.join("|");
  for (let i=0;i<s.length;i++) { h ^= s.charCodeAt(i); h = Math.imul(h,16777619); }
  return (h >>> 0).toString(36);
}

function parseTime(s: string) {
  const m = s.match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);
  return m ? {start:m[1].padStart(5,"0"),end:m[2].padStart(5,"0")} : null;
}

function removeSettlementPrefixes(s: string) {
  let out = s;
  for (let i=0;i<5;i++) {
    const next = out
      .replace(/(?:Насеље|насеље)\s+[^:]{1,80}:\s*/g,"")
      .replace(/(?:Општина|општина)\s+[^:]{1,80}:\s*/g,"");
    if (next === out) break;
    out = next;
  }
  return out;
}

function parseEdsStreetGroups(raw: string) {
  const text = removeSettlementPrefixes(raw.replace(/\s+/g," ").trim());
  const groups: {street:string; numberSpec:string}[] = [];
  const re = /(?:^|,\s)([^,:]{2,90}):\s*([^:]*?)(?=(?:,\s[^,:]{2,90}:)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const street = m[1].trim().replace(/^[-–—]\s*/,"");
    const numberSpec = m[2].trim().replace(/,\s*$/,"");
    if (!street || /^насеље\b/i.test(street) || /^општина\b/i.test(street)) continue;
    groups.push({street, numberSpec});
  }
  if (!groups.length && text) groups.push({street:text,numberSpec:""});
  return groups;
}

function parseEds(html: string, sourceUrl: string): OutageEvent[] {
  const text = cleanText(html);
  const date = text.match(/датум:\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
  if (!date) return [];

  const out: OutageEvent[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html))) {
    const cells: string[] = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(row[1]))) cells.push(inlineText(c[1]));
    if (cells.length < 3) continue;
    const time = parseTime(cells[1]);
    if (!time) continue;
    const municipality = cells[0].trim();
    for (const g of parseEdsStreetGroups(cells.slice(2).join(" "))) {
      out.push({
        id:"eds-"+stableId([date,municipality,time.start,time.end,g.street,g.numberSpec]),
        utility:"electricity",
        date,
        start:time.start,
        end:time.end,
        municipality,
        street:g.street,
        numberSpec:g.numberSpec,
        scope:g.numberSpec && !/^бб$/i.test(g.numberSpec) ? "numbers" : "partial",
        source:"Elektrodistribucija Srbije",
        sourceUrl,
        note:g.numberSpec ? ("Zvanično navedeni brojevi: " + g.numberSpec) : "Zvanična najava bez preciznog raspona kućnih brojeva."
      });
    }
  }
  return out;
}

function absUrl(href: string, base: string) {
  try { return new URL(href, base).toString(); } catch { return ""; }
}

function waterArticleLinks(html: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  const aRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html))) {
    const href = m[1];
    const label = inlineText(m[2]).toLowerCase();
    if (!/planiran[ia]\s+radov/i.test(label) && !/Planirani-radovi-na-vodovodnoj-mrezi/i.test(href)) continue;
    const url = absUrl(href, WATER_LIST);
    if (url && !seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out.slice(0,10);
}

function normalizeLine(s: string) {
  return s.replace(/^[•*\-–—]\s*/,"").replace(/\s+/g," ").trim();
}

function sectionTime(text: string) {
  let m = text.match(/periodu od\s*(\d{1,2}:\d{2})\s*do\s*(\d{1,2}:\d{2})/i);
  if (m) return {start:m[1].padStart(5,"0"),end:m[2].padStart(5,"0")};
  m = text.match(/od\s+[^.\n]*?u\s*(\d{1,2}:\d{2})\s*(?:sati)?\s*do\s+[^.\n]*?u\s*(\d{1,2}:\d{2})/i);
  if (m) return {start:m[1].padStart(5,"0"),end:m[2].padStart(5,"0")};
  m = text.match(/od\s*(\d{1,2}:\d{2})\s*do\s*(\d{1,2}:\d{2})/i);
  return m ? {start:m[1].padStart(5,"0"),end:m[2].padStart(5,"0")} : null;
}

function cleanWaterStreetLine(line: string) {
  let x = normalizeLine(line);
  x = x.replace(/^u\s+(?:delu\s+)?/i,"").replace(/\s+ulice\b/i,"");
  x = x.replace(/^sledećim ulicama\s*:?\s*/i,"");
  return x.trim();
}

function streetFromPhrase(phrase: string) {
  let x = phrase.trim().replace(/[.;]+$/,"");
  x = x.replace(/^delu\s+/i,"");
  const paren = x.indexOf("(");
  const qualifier = paren >= 0 ? x.slice(paren).trim() : "";
  if (paren >= 0) x = x.slice(0,paren).trim();
  x = x.replace(/\s+ulice$/i,"").trim();
  if (x.includes(",")) {
    const [first, ...rest] = x.split(",");
    return {street:first.trim(), qualifier:(rest.join(",").trim()+" "+qualifier).trim()};
  }
  return {street:x, qualifier};
}

function waterStreetCandidates(sectionLines: string[]) {
  const found: {street:string; numberSpec:string; scope:"all"|"partial"|"numbers"; note:string}[] = [];
  const joined = sectionLines.join("\n");

  const inline = joined.match(/bez vode će ostati potrošači u\s+(.+?)(?:\n|\.|$)/i);
  if (inline && !/sledećim ulicama/i.test(inline[1])) {
    const p = streetFromPhrase(inline[1]);
    if (p.street) {
      const nums = p.qualifier.match(/od\s+(?:broja\s*)?(\d+\w*)\s+do\s+(?:broja\s*)?(\d+\w*)/i);
      found.push({
        street:p.street,
        numberSpec:nums ? nums[1]+"-"+nums[2] : "",
        scope:nums ? "numbers" : (p.qualifier ? "partial" : "all"),
        note:inline[1].trim()
      });
    }
  }

  const marker = sectionLines.findIndex(l => /sledećim ulicama/i.test(l));
  if (marker >= 0) {
    for (let i=marker+1;i<sectionLines.length;i++) {
      let line = cleanWaterStreetLine(sectionLines[i]);
      if (!line) continue;
      if (/^(za najnužnije|iz beogradskog|ukoliko|umanjen pritisak|zbog )/i.test(line)) break;
      if (line.length > 180 || /bez vode|potrošači|periodu|godine|radov/i.test(line)) continue;
      const p = streetFromPhrase(line);
      if (!p.street || p.street.length > 100) continue;
      const nums = p.qualifier.match(/od\s+(?:broja\s*)?(\d+\w*)\s+do\s+(?:broja\s*)?(\d+\w*)/i);
      found.push({
        street:p.street,
        numberSpec:nums ? nums[1]+"-"+nums[2] : "",
        scope:nums ? "numbers" : (p.qualifier ? "partial" : "all"),
        note:line
      });
    }
  }

  const unique = new Map<string,typeof found[number]>();
  for (const f of found) unique.set(f.street.toLowerCase()+"|"+f.numberSpec, f);
  return [...unique.values()];
}

function parseWater(html: string, sourceUrl: string): OutageEvent[] {
  const title = titleText(html);
  const date = extractSerbianDate(title) || extractSerbianDate(cleanText(html));
  if (!date) return [];
  const lines = cleanText(html).split("\n").map(normalizeLine).filter(Boolean);
  const municipalityIndexes: {idx:number; municipality:string}[] = [];

  for (let i=0;i<lines.length;i++) {
    const municipality = MUNICIPALITIES.find(m => m.toLocaleUpperCase("sr") === lines[i].toLocaleUpperCase("sr"));
    if (municipality) municipalityIndexes.push({idx:i,municipality});
  }

  const out: OutageEvent[] = [];
  for (let s=0;s<municipalityIndexes.length;s++) {
    const cur = municipalityIndexes[s];
    const endIdx = municipalityIndexes[s+1]?.idx ?? lines.length;
    const sectionLines = lines.slice(cur.idx+1,endIdx);
    const section = sectionLines.join("\n");
    const time = sectionTime(section);
    if (!time) continue;
    const streets = waterStreetCandidates(sectionLines);
    for (const st of streets) {
      out.push({
        id:"water-"+stableId([date,cur.municipality,time.start,time.end,st.street,st.numberSpec,sourceUrl]),
        utility:"water",
        date,
        start:time.start,
        end:time.end,
        municipality:cur.municipality,
        street:st.street,
        numberSpec:st.numberSpec,
        scope:st.scope,
        source:"Grad Beograd / Beogradski vodovod",
        sourceUrl,
        note:st.note || "Planirani radovi na vodovodnoj mreži."
      });
    }
  }
  return out;
}


function heatingArticleLinks(html: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  const aRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html))) {
    const href = m[1];
    const label = inlineText(m[2]).toLowerCase();
    if (!/prekid[u]?\s+u\s+isporuci\s+toplotne\s+energije/i.test(label) &&
        !/Prekid-u-isporuci-toplotne-energije/i.test(href)) continue;
    const url = absUrl(href, HEATING_LIST);
    if (url && !seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out.slice(0,12);
}

function parseHeatingAddress(raw: string) {
  const left = raw.split(/\s+-\s+/)[0]?.trim() || "";
  if (!left) return null;
  const cleaned = left.replace(/\s*\([^)]*\)\s*$/,"").trim();
  const m = cleaned.match(/^(.+?)\s+(\d+[A-Za-zА-Яа-я]{0,4}(?:\s*(?:-|,|\/|\bi\b)\s*\d+[A-Za-zА-Яа-я]{0,4})*)$/iu);
  if (!m) return null;
  return {street:m[1].trim(), numberSpec:m[2].replace(/\s+i\s+/gi,",").replace(/\s+/g,"").trim()};
}

function parseHeating(html: string, sourceUrl: string): OutageEvent[] {
  const title = titleText(html);
  const date = extractSerbianDate(title) || extractSerbianDate(cleanText(html));
  if (!date) return [];
  const lines = cleanText(html).split("\n").map(normalizeLine).filter(Boolean);
  const out: OutageEvent[] = [];
  for (const line of lines) {
    if (!line.includes(" - ")) continue;
    const parsed = parseHeatingAddress(line);
    if (!parsed) continue;
    const note = line.split(/\s+-\s+/).slice(1).join(" - ").trim() || "Prekid u isporuci toplotne energije.";
    if (/potrošne\s+tople\s+vode/i.test(note) && !/grejanj/i.test(note)) continue;
    out.push({
      id:"heating-"+stableId([date,parsed.street,parsed.numberSpec,sourceUrl]),
      utility:"heating",
      date,
      start:"00:00",
      end:"23:59",
      municipality:"",
      street:parsed.street,
      numberSpec:parsed.numberSpec,
      scope:"numbers",
      source:"Beogradske elektrane / Grad Beograd",
      sourceUrl,
      note
    });
  }
  return out;
}

async function loadHeating() {
  const listHtml = await fetchText(HEATING_LIST);
  const links = heatingArticleLinks(listHtml);
  const settled = await Promise.allSettled(links.map(fetchText));
  const events: OutageEvent[] = [];
  const errors: string[] = [];
  settled.forEach((r,i) => {
    if (r.status === "fulfilled") events.push(...parseHeating(r.value,links[i]));
    else errors.push(String(r.reason));
  });
  return {events:events.filter(e=>withinWindow(e.date)), ok:true, errors, articlesChecked:links.length};
}


function plannedWorksPublishedDate(html: string) {
  const datetime = html.match(/<time\b[^>]*datetime=["'](\d{4}-\d{2}-\d{2})/i)?.[1];
  if (datetime) return datetime;
  const text = cleanText(html);
  const latin = extractSerbianDate(text);
  if (latin) return latin;
  const months: Record<string,number> = {
    jan:1,feb:2,mar:3,apr:4,maj:5,jun:6,jul:7,avg:8,sep:9,okt:10,nov:11,dec:12,
    "јан":1,"феб":2,"мар":3,"апр":4,"мај":5,"јун":6,"јул":7,"авг":8,"сеп":9,"окт":10,"нов":11,"дец":12
  };
  const m=text.match(/(\d{1,2})\s+([a-zа-я]{3})\s+(\d{4})/i);
  return m&&months[m[2].toLowerCase()]?isoDate(Number(m[3]),months[m[2].toLowerCase()],Number(m[1])):null;
}

function canonicalHeatingStreet(raw: string) {
  return raw
    .trim()
    .replace(/[.;]+$/,"")
    .replace(/^u\s+/i,"")
    .replace(/^(?:Ulici|ulici|Ulica|ulica|ulicama)\s+/i,"")
    .replace(/^Bulevaru\s+/i,"Bulevar ")
    .replace(/^Trgu\s+/i,"Trg ")
    .replace(/\s+[–—-]\s+Stari\s+Merkator.*$/i,"")
    .trim();
}

function plannedWorkTargets(line: string) {
  const clean=normalizeLine(line);
  const out:{street:string;numberSpec:string;scope:"numbers"|"partial";note:string}[]=[];
  if(!/radov|popravk|izgradnj|remont/i.test(clean))return out;

  const corner=clean.match(/na\s+uglu\s+ulica\s+(.+?)\s+i\s+(.+?)(?:\s*\(|[.;]|$)/i);
  if(corner){
    for(const raw of [corner[1],corner[2]]){
      const street=canonicalHeatingStreet(raw);
      if(street)out.push({street,numberSpec:"",scope:"partial",note:clean});
    }
    return out;
  }

  let phrase=clean.match(/(?:\bu\s+|\boko\s+)(.+)$/i)?.[1]||"";
  if(!phrase)return out;
  phrase=phrase.replace(/\s*\([^)]*\)\s*$/,"").trim();

  const split=phrase.split(/\s+i\s+(?=(?:Ulici|ulici|Ulica|ulica)\b)/i);
  for(let raw of split){
    raw=canonicalHeatingStreet(raw);
    if(!raw)continue;

    let numberSpec="";
    const kod=raw.match(/\s+kod\s+broja\s+(\d+[A-Za-zА-Яа-я]?)/i);
    if(kod){
      numberSpec=kod[1];
      raw=raw.slice(0,kod.index).trim();
    }else{
      const range=raw.match(/\s+(\d+[A-Za-zА-Яа-я]?)(?:\s*[–—-]\s*(\d+[A-Za-zА-Яа-я]?))$/u);
      if(range){
        numberSpec=range[2]?range[1]+"-"+range[2]:range[1];
        raw=raw.slice(0,range.index).trim();
      }
    }

    const street=canonicalHeatingStreet(raw);
    if(street)out.push({street,numberSpec,scope:numberSpec?"numbers":"partial",note:clean});
  }
  return out;
}

function parseHeatingPlannedWorks(html: string, sourceUrl: string): OutageEvent[] {
  const published=plannedWorksPublishedDate(html);
  if(!published || published<localIsoDay(-14))return [];
  const lines=cleanText(html).split("\n").map(normalizeLine).filter(Boolean);
  let municipality="";
  const out:OutageEvent[]=[];
  for(const line of lines){
    if(/Radovi\s+na\s+toplovodnoj\s+mreži/i.test(line)){
      const found=MUNICIPALITIES.find(m=>line.toLocaleLowerCase("sr").includes(m.toLocaleLowerCase("sr")));
      if(found){municipality=found;continue;}
    }
    if(!municipality)continue;
    for(const target of plannedWorkTargets(line)){
      out.push({
        id:"heating-plan-"+stableId([published,municipality,target.street,target.numberSpec,target.note]),
        utility:"heating",
        kind:"planned_work",
        publishedAt:published,
        date:published,
        endDate:localIsoDay(7),
        start:"00:00",
        end:"23:59",
        municipality,
        street:target.street,
        numberSpec:target.numberSpec,
        scope:target.scope,
        source:"Beogradske elektrane — Planirani radovi",
        sourceUrl,
        note:target.note
      });
    }
  }
  return out;
}

async function loadHeatingPlannedWorks() {
  const html=await fetchText(HEATING_PLANNED);
  const events=parseHeatingPlannedWorks(html,HEATING_PLANNED);
  return {events,ok:true,errors:[],publishedAt:plannedWorksPublishedDate(html)};
}

function localIsoDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays*86400000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone:"Europe/Belgrade", year:"numeric", month:"2-digit", day:"2-digit"
  }).formatToParts(d);
  const get=(t:string)=>parts.find(p=>p.type===t)?.value || "";
  return get("year")+"-"+get("month")+"-"+get("day");
}

function withinWindow(date: string) {
  const min = localIsoDay(-1);
  const max = localIsoDay(7);
  return date >= min && date <= max;
}

async function loadElectricity() {
  const urls = [0,1,2,3].map(d => EDS_DAY_BASE + "/Dan_" + d + "_Iskljucenja.htm");
  const settled = await Promise.allSettled(urls.map(fetchText));
  const events: OutageEvent[] = [];
  const errors: string[] = [];
  settled.forEach((r,i) => {
    if (r.status === "fulfilled") events.push(...parseEds(r.value,urls[i]));
    else errors.push(String(r.reason));
  });
  return {events:events.filter(e=>withinWindow(e.date)), ok:events.length>0 || errors.length<4, errors};
}

async function loadWater() {
  const listHtml = await fetchText(WATER_LIST);
  const links = waterArticleLinks(listHtml);
  const settled = await Promise.allSettled(links.map(fetchText));
  const events: OutageEvent[] = [];
  const errors: string[] = [];
  settled.forEach((r,i) => {
    if (r.status === "fulfilled") events.push(...parseWater(r.value,links[i]));
    else errors.push(String(r.reason));
  });
  return {events:events.filter(e=>withinWindow(e.date)), ok:true, errors, articlesChecked:links.length};
}

export default async (_req: Request) => {
  const checkedAt = new Date().toISOString();
  const [electricity, water, heating, heatingPlanned] = await Promise.allSettled([loadElectricity(),loadWater(),loadHeating(),loadHeatingPlannedWorks()]);

  const e = electricity.status === "fulfilled" ? electricity.value : {events:[],ok:false,errors:[String(electricity.reason)]};
  const w = water.status === "fulfilled" ? water.value : {events:[],ok:false,errors:[String(water.reason)],articlesChecked:0};
  const h = heating.status === "fulfilled" ? heating.value : {events:[],ok:false,errors:[String(heating.reason)],articlesChecked:0};
  const hp = heatingPlanned.status === "fulfilled" ? heatingPlanned.value : {events:[],ok:false,errors:[String(heatingPlanned.reason)],publishedAt:null};

  const events = [...e.events,...w.events,...h.events,...hp.events]
    .sort((a,b)=>(a.date+a.start+a.municipality+a.street).localeCompare(b.date+b.start+b.municipality+b.street));

  return new Response(JSON.stringify({
    generatedAt:checkedAt,
    events,
    sources:{
      electricity:{
        ok:e.ok,
        source:"Elektrodistribucija Srbije",
        sourceUrl:EDS_SOURCE,
        count:e.events.length,
        error:e.errors.length ? e.errors.join(" | ").slice(0,600) : null
      },
      water:{
        ok:w.ok,
        source:"Grad Beograd / Beogradski vodovod",
        sourceUrl:WATER_LIST,
        count:w.events.length,
        articlesChecked:w.articlesChecked,
        error:w.errors.length ? w.errors.join(" | ").slice(0,600) : null
      },
      heating:{
        ok:h.ok || hp.ok,
        source:"Beogradske elektrane / Grad Beograd",
        sourceUrl:HEATING_PLANNED,
        count:h.events.length + hp.events.length,
        interruptionCount:h.events.length,
        plannedWorkCount:hp.events.length,
        plannedWorksPublishedAt:hp.publishedAt,
        articlesChecked:h.articlesChecked,
        error:[...h.errors,...hp.errors].length ? [...h.errors,...hp.errors].join(" | ").slice(0,600) : null
      }
    }
  }),{
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"public, max-age=0, s-maxage=900, stale-while-revalidate=3600"
    }
  });
};

export const config = { path:"/api/outages" };
