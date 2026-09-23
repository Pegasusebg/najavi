const CACHE="najavi-v2";
const STATIC=["/","/manifest.webmanifest","/najava-icon.svg"];
self.addEventListener("install",event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC)).catch(()=>{}));self.skipWaiting()});
self.addEventListener("activate",event=>{event.waitUntil(self.clients.claim())});
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET"||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith(fetch(event.request).then(res=>{const copy=res.clone();caches.open(CACHE).then(c=>c.put(event.request,copy)).catch(()=>{});return res}).catch(()=>caches.match(event.request).then(r=>r||caches.match("/"))));
});
self.addEventListener("push",event=>{
  let data={title:"Najavi",body:"Imate novo obaveštenje.",url:"/",tag:"najava"};
  try{if(event.data)data={...data,...event.data.json()}}catch{}
  event.waitUntil(self.registration.showNotification(data.title,{
    body:data.body,
    icon:"/najava-icon.svg",
    badge:"/najava-icon.svg",
    tag:data.tag,
    data:{url:data.url||"/"},
    renotify:true
  }));
});
self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const target=new URL(event.notification.data?.url||"/",self.registration.scope).href;
  event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
    for(const client of list){if("focus"in client&&client.url.startsWith(self.registration.scope)){client.navigate(target);return client.focus()}}
    return clients.openWindow(target);
  }));
});