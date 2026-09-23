const CACHE="najavi-v4";
const STATIC=["/","/app/","/manifest.webmanifest","/najava-icon.svg"];
self.addEventListener("install",event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC)).catch(()=>{}));self.skipWaiting()});
self.addEventListener("activate",event=>{event.waitUntil(Promise.all([
  caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))),
  self.clients.claim()
]))});
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET"||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith(fetch(event.request).then(res=>{const copy=res.clone();caches.open(CACHE).then(c=>c.put(event.request,copy)).catch(()=>{});return res}).catch(()=>caches.match(event.request).then(r=>r||caches.match(new URL(event.request.url).pathname.startsWith("/app")?"/app/":"/"))));
});
self.addEventListener("push",event=>{
  let data={title:"Najavi",body:"Imate novo obaveštenje.",url:"/app/",tag:"najava"};
  try{if(event.data)data={...data,...event.data.json()}}catch{}
  event.waitUntil(self.registration.showNotification(data.title,{
    body:data.body,
    icon:"/najava-icon.svg",
    badge:"/najava-icon.svg",
    tag:data.tag,
    data:{url:data.url||"/app/"},
    renotify:true
  }));
});
self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const target=new URL(event.notification.data?.url||"/app/",self.registration.scope).href;
  event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
    for(const client of list){if("focus"in client&&client.url.startsWith(self.registration.scope)){client.navigate(target);return client.focus()}}
    return clients.openWindow(target);
  }));
});