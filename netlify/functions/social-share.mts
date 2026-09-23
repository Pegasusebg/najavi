import { deflateSync } from "node:zlib";

const W=1200, H=630;
const C={
  bg:[247,251,248,255],
  green:[61,157,90,255],
  greenDark:[47,126,73,255],
  ink:[23,37,28,255],
  muted:[111,128,115,255],
  white:[255,255,255,255],
  soft:[229,244,232,255],
  soft2:[238,248,240,255],
  line:[214,231,218,255]
} as const;

function crc32(buf:Buffer){
  let c=0xffffffff;
  for(const b of buf){
    c^=b;
    for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);
  }
  return (c^0xffffffff)>>>0;
}
function chunk(type:string,data:Buffer){
  const t=Buffer.from(type);
  const len=Buffer.alloc(4);len.writeUInt32BE(data.length,0);
  const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])),0);
  return Buffer.concat([len,t,data,crc]);
}
function px(raw:Buffer,x:number,y:number,c:readonly number[]){
  if(x<0||y<0||x>=W||y>=H)return;
  const row=W*4+1,i=y*row+1+x*4;
  raw[i]=c[0];raw[i+1]=c[1];raw[i+2]=c[2];raw[i+3]=c[3];
}
function rect(raw:Buffer,x:number,y:number,w:number,h:number,c:readonly number[]){
  const x2=Math.min(W,x+w),y2=Math.min(H,y+h);
  for(let yy=Math.max(0,y);yy<y2;yy++)for(let xx=Math.max(0,x);xx<x2;xx++)px(raw,xx,yy,c);
}
function roundRect(raw:Buffer,x:number,y:number,w:number,h:number,r:number,c:readonly number[]){
  const rr=Math.max(0,Math.min(r,Math.floor(Math.min(w,h)/2)));
  for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++){
    const dx=xx<x+rr?x+rr-xx:xx>=x+w-rr?xx-(x+w-rr-1):0;
    const dy=yy<y+rr?y+rr-yy:yy>=y+h-rr?yy-(y+h-rr-1):0;
    if(dx===0||dy===0||dx*dx+dy*dy<=rr*rr)px(raw,xx,yy,c);
  }
}
function polygon(raw:Buffer,pts:[number,number][],c:readonly number[]){
  const minX=Math.max(0,Math.floor(Math.min(...pts.map(p=>p[0]))));
  const maxX=Math.min(W-1,Math.ceil(Math.max(...pts.map(p=>p[0]))));
  const minY=Math.max(0,Math.floor(Math.min(...pts.map(p=>p[1]))));
  const maxY=Math.min(H-1,Math.ceil(Math.max(...pts.map(p=>p[1]))));
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
    let inside=false;
    for(let i=0,j=pts.length-1;i<pts.length;j=i++){
      const [xi,yi]=pts[i],[xj,yj]=pts[j];
      if(((yi>y)!==(yj>y))&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
    }
    if(inside)px(raw,x,y,c);
  }
}
function line(raw:Buffer,x:number,y:number,w:number,h:number,c:readonly number[]){
  roundRect(raw,x,y,w,h,Math.floor(h/2),c);
}
function image(){
  const row=W*4+1,raw=Buffer.alloc(row*H);
  for(let y=0;y<H;y++){
    raw[y*row]=0;
    for(let x=0;x<W;x++)px(raw,x,y,C.bg);
  }

  // Calm branded background, deliberately text-free so social apps render
  // the real title/description below it without duplicated or cropped copy.
  roundRect(raw,-180,-170,690,690,345,C.soft);
  roundRect(raw,930,390,420,420,210,C.soft2);
  roundRect(raw,560,-120,760,250,125,[244,250,245,255]);

  // Large Najavi app icon.
  roundRect(raw,92,118,300,300,82,C.green);
  polygon(raw,[
    [245,155],[165,286],[226,286],[202,383],[310,252],[250,252]
  ],C.white);

  // Small decorative status dot.
  roundRect(raw,118,463,24,24,12,C.green);
  line(raw,156,466,190,18,C.greenDark);
  line(raw,156,494,130,12,C.muted);

  // Right-side app preview cards.
  roundRect(raw,620,92,470,445,42,C.white);
  // header
  roundRect(raw,662,132,52,52,16,C.green);
  polygon(raw,[
    [688,141],[674,166],[686,166],[681,180],[703,157],[691,157]
  ],C.white);
  line(raw,740,139,146,20,C.ink);
  line(raw,740,170,92,12,C.muted);
  roundRect(raw,949,132,101,44,22,C.soft2);
  roundRect(raw,970,148,12,12,6,C.green);
  line(raw,992,148,37,12,C.greenDark);

  // today / safe card
  line(raw,662,229,76,12,C.greenDark);
  line(raw,662,256,205,28,C.ink);
  line(raw,662,300,292,14,C.muted);
  roundRect(raw,662,346,386,126,28,C.soft2);
  roundRect(raw,692,377,62,62,18,[225,244,230,255]);
  roundRect(raw,712,397,22,22,11,C.green);
  line(raw,780,373,210,20,C.ink);
  line(raw,780,407,235,12,C.muted);

  // tiny address row hint
  roundRect(raw,834,498,214,16,8,C.line);
  roundRect(raw,662,498,132,16,8,[194,224,201,255]);

  const ihdr=Buffer.alloc(13);
  ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);
  ihdr[8]=8;ihdr[9]=6;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk("IHDR",ihdr),
    chunk("IDAT",deflateSync(raw,{level:9})),
    chunk("IEND",Buffer.alloc(0))
  ]);
}

export default async()=>new Response(image(),{
  headers:{
    "Content-Type":"image/png",
    "Cache-Control":"public, max-age=3600, s-maxage=86400",
    "Content-Disposition":"inline; filename=\"najavi-social-share.png\""
  }
});

export const config={path:"/social-share.png"};