import { deflateSync } from "node:zlib";

const W=1200, H=630;
const colors={
  bg:[245,250,246,255],
  green:[61,157,90,255],
  greenDark:[47,126,73,255],
  ink:[23,37,28,255],
  muted:[112,129,116,255],
  white:[255,255,255,255],
  soft:[231,246,234,255]
} as const;

const glyphs:Record<string,string[]>={
  A:["01110","10001","10001","11111","10001","10001","10001"],
  D:["11110","10001","10001","10001","10001","10001","11110"],
  I:["11111","00100","00100","00100","00100","00100","11111"],
  J:["00111","00010","00010","00010","10010","10010","01100"],
  N:["10001","11001","10101","10011","10001","10001","10001"],
  R:["11110","10001","10001","11110","10100","10010","10001"],
  S:["01111","10000","10000","01110","00001","00001","11110"],
  T:["11111","00100","00100","00100","00100","00100","00100"],
  U:["10001","10001","10001","10001","10001","10001","01110"],
  V:["10001","10001","10001","10001","01010","01010","00100"],
  O:["01110","10001","10001","10001","10001","10001","01110"],
  " ":["00000","00000","00000","00000","00000","00000","00000"],
  "+":["00000","00100","00100","11111","00100","00100","00000"]
};

function crc32(buf:Buffer){
  let c=0xffffffff;
  for(const b of buf){
    c^=b;
    for(let k=0;k<8;k++) c=(c>>>1)^((c&1)?0xedb88320:0);
  }
  return (c^0xffffffff)>>>0;
}
function chunk(type:string,data:Buffer){
  const t=Buffer.from(type);
  const len=Buffer.alloc(4); len.writeUInt32BE(data.length,0);
  const crc=Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t,data])),0);
  return Buffer.concat([len,t,data,crc]);
}
function pixel(raw:Buffer,x:number,y:number,c:readonly number[]){
  if(x<0||y<0||x>=W||y>=H)return;
  const row=W*4+1;
  const i=y*row+1+x*4;
  raw[i]=c[0];raw[i+1]=c[1];raw[i+2]=c[2];raw[i+3]=c[3];
}
function rect(raw:Buffer,x:number,y:number,w:number,h:number,c:readonly number[]){
  const x2=Math.min(W,x+w),y2=Math.min(H,y+h);
  for(let yy=Math.max(0,y);yy<y2;yy++) for(let xx=Math.max(0,x);xx<x2;xx++) pixel(raw,xx,yy,c);
}
function roundRect(raw:Buffer,x:number,y:number,w:number,h:number,r:number,c:readonly number[]){
  for(let yy=y;yy<y+h;yy++) for(let xx=x;xx<x+w;xx++){
    const dx=xx< x+r ? x+r-xx : xx>=x+w-r ? xx-(x+w-r-1) : 0;
    const dy=yy< y+r ? y+r-yy : yy>=y+h-r ? yy-(y+h-r-1) : 0;
    if(dx===0||dy===0||dx*dx+dy*dy<=r*r) pixel(raw,xx,yy,c);
  }
}
function polygon(raw:Buffer,pts:[number,number][],c:readonly number[]){
  const minX=Math.max(0,Math.floor(Math.min(...pts.map(p=>p[0]))));
  const maxX=Math.min(W-1,Math.ceil(Math.max(...pts.map(p=>p[0]))));
  const minY=Math.max(0,Math.floor(Math.min(...pts.map(p=>p[1]))));
  const maxY=Math.min(H-1,Math.ceil(Math.max(...pts.map(p=>p[1]))));
  for(let y=minY;y<=maxY;y++) for(let x=minX;x<=maxX;x++){
    let inside=false;
    for(let i=0,j=pts.length-1;i<pts.length;j=i++){
      const [xi,yi]=pts[i],[xj,yj]=pts[j];
      const cross=((yi>y)!==(yj>y)) && x < (xj-xi)*(y-yi)/(yj-yi)+xi;
      if(cross)inside=!inside;
    }
    if(inside)pixel(raw,x,y,c);
  }
}
function text(raw:Buffer,value:string,x:number,y:number,scale:number,c:readonly number[]){
  let cursor=x;
  for(const ch of value.toUpperCase()){
    const g=glyphs[ch]||glyphs[" "];
    for(let gy=0;gy<7;gy++) for(let gx=0;gx<5;gx++) if(g[gy][gx]==="1")
      rect(raw,cursor+gx*scale,y+gy*scale,scale,scale,c);
    cursor+=6*scale;
  }
}
function image(){
  const row=W*4+1;
  const raw=Buffer.alloc(row*H);
  for(let y=0;y<H;y++){
    raw[y*row]=0;
    for(let x=0;x<W;x++)pixel(raw,x,y,colors.bg);
  }
  // soft brand blocks
  roundRect(raw,0,0,560,630,0,colors.soft);
  roundRect(raw,880,390,320,240,80,[238,248,240,255]);

  // icon
  roundRect(raw,72,70,150,150,42,colors.green);
  polygon(raw,[
    [145,92],[104,160],[135,160],[124,202],[177,139],[146,139]
  ],colors.white);

  text(raw,"NAJAVI",260,86,13,colors.ink);
  roundRect(raw,260,174,305,48,24,[239,249,241,255]);
  text(raw,"STRUJA + VODA",284,187,4,colors.greenDark);

  text(raw,"NAJAVI",72,320,17,colors.ink);
  text(raw,"NA VREME",72,470,9,colors.greenDark);

  // live status card
  roundRect(raw,850,72,280,140,28,colors.white);
  roundRect(raw,885,105,24,24,12,colors.green);
  text(raw,"UZIVO",935,101,7,colors.greenDark);
  text(raw,"STRUJA + VODA",885,158,4,colors.muted);

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

export default async()=>{
  return new Response(image(),{
    headers:{
      "Content-Type":"image/png",
      "Cache-Control":"public, max-age=86400, s-maxage=604800",
      "Content-Disposition":"inline; filename=\"najavi-social-share.png\""
    }
  });
};

export const config={path:"/social-share.png"};
