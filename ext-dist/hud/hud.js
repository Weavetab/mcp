"use strict";(()=>{var R={};window.wtState=R;window.addEventListener("message",e=>{if(!e.data||typeof e.data!="object")return;let{type:t,...n}=e.data;if(typeof t=="string"&&t.startsWith("RT_")){R[t]=n;return}$(t,n)});function $(e,t){e==="WT_HUD_UPDATE"&&Y(t.state||t.action||t.badge,t.detail||t.groupState)}function Y(e,t){let n=document.getElementById("widgets");if(!n)return;let o=document.getElementById("wt-plugin-hud-badge");if(!e||e==="idle"){o&&o.remove();return}o||(o=document.createElement("div"),o.id="wt-plugin-hud-badge",o.style.cssText="position:fixed;bottom:14px;right:14px;padding:5px 10px;border-radius:999px;background:rgba(15,23,42,0.88);border:1px solid rgba(59,130,246,0.45);color:#e2e8f0;font-size:11px;display:flex;align-items:center;gap:6px;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,0.35);",n.appendChild(o)),o.textContent=t?`${e}: ${t}`:e}var r=document.getElementById("rt-canvas"),s=r.getContext("2d"),c=window.innerWidth/2,p=window.innerHeight/2,_=c,S=p,E=0,C=0,y="idle",L=!0;window.addEventListener("message",function(e){!e.data||typeof e.data!="object"||e.data.type==="WT_SCRIPTED_PILL_TOGGLE"&&(L=!!e.data.enabled)});var w=[],F=0,b=0,h=!1;function I(){r.width=window.innerWidth,r.height=window.innerHeight,h=!0}window.addEventListener("resize",I);I();var D=.15,k=.6,v=0,H=c,A=p;function M(){let e=window.wtState||{};e.RT_CURSOR_MOVE&&(c=e.RT_CURSOR_MOVE.x,p=e.RT_CURSOR_MOVE.y,y=e.RT_CURSOR_MOVE.phase||"idle",delete e.RT_CURSOR_MOVE),e.RT_CLICK&&(q(e.RT_CLICK.x,e.RT_CLICK.y),y="clicking",v=Date.now(),setTimeout(()=>{y==="clicking"&&(y="idle")},300),delete e.RT_CLICK),e.RT_SCROLL&&(F=e.RT_SCROLL.y,b!==e.RT_SCROLL.ratio&&(b=e.RT_SCROLL.ratio,h=!0),delete e.RT_SCROLL);let t=w.length>0||y!=="idle"||Math.abs(c-H)>.5||Math.abs(p-A)>.5;if(H=c,A=p,!t){h&&(h=!1,s.clearRect(0,0,r.width,r.height),L&&b>0&&b<1&&O()),requestAnimationFrame(M);return}h=!1,s.clearRect(0,0,r.width,r.height),E+=(c-_)*D,C+=(p-S)*D,E*=k,C*=k;let n=Date.now();if(y==="clicking"&&n-v<300){c+=(Math.random()-.5)*2.5,p+=(Math.random()-.5)*2.5;let l=(n-v)/50;c+=Math.sin(l),p+=Math.cos(l)}_+=E,S+=C,L&&(K(),O()),requestAnimationFrame(M)}function q(e,t){for(let n=0;n<3;n++)setTimeout(()=>{w.push({x:e,y:t,radius:0,alpha:1})},n*100)}function K(){for(let e=w.length-1;e>=0;e--){let t=w[e];if(t.radius+=3,t.alpha-=.015,t.alpha<=0){w.splice(e,1);continue}s.beginPath(),s.arc(t.x,t.y,t.radius,0,Math.PI*2),s.strokeStyle=`rgba(59, 130, 246, ${t.alpha})`,s.lineWidth=3,s.shadowColor="#3b82f6",s.shadowBlur=10,s.stroke()}}function O(){if(b<=0||b>=1)return;let e=4,t=60,n=r.width-e-10,o=10+(r.height-t-20)*b;s.fillStyle="rgba(59, 130, 246, 0.5)",s.beginPath(),s.roundRect(n,o,e,t,2),s.fill()}requestAnimationFrame(M);var u=!0;function B(){window.addEventListener("message",e=>{!e.data||typeof e.data!="object"||e.data.type==="TOGGLE_HUD"&&U()}),window.toggleHUD=U}function U(){u=!u;let e=document.getElementById("rt-canvas"),t=document.getElementById("widgets");e&&(e.style.display=u?"block":"none"),t&&(t.style.display=u?"block":"none"),window.parent.postMessage({type:"HUD_STATE_CHANGED",state:{hudVisible:u}},"*")}function V(e){u=e;let t=document.getElementById("rt-canvas"),n=document.getElementById("widgets");t&&(t.style.display=u?"block":"none"),n&&(n.style.display=u?"block":"none")}var m=!1,a=null,i=null,f=null,X="console";function G(){window.addEventListener("message",e=>{!e.data||typeof e.data!="object"||e.data.type==="TOGGLE_DEBUG"&&P()}),window.toggleDebugMenu=P}function P(){m=!m,a||W(),a&&(a.style.display=m?"flex":"none"),window.parent.postMessage({type:"HUD_STATE_CHANGED",state:{debugMenuVisible:m}},"*")}function W(){a=document.createElement("div"),a.id="wt-debug-menu",a.style.cssText=`
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 700px;
    max-height: 80vh;
    background: rgba(17, 17, 19, 0.98);
    border: 1px solid #3b82f6;
    border-radius: 8px;
    pointer-events: auto;
    z-index: 1000;
    display: none;
    flex-direction: column;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    color: #e8e8f0;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
  `;let e=document.createElement("div");e.style.cssText=`
    padding: 12px 16px;
    border-bottom: 1px solid #2a2a30;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: rgba(59, 130, 246, 0.1);
  `,e.innerHTML=`
    <span style="color: #60a5fa; font-weight: 600;">\u{1F527} WeaveTab Debug Menu</span>
    <span style="color: #6b7280; font-size: 10px;">Alt+Shift+D to toggle</span>
  `,a.appendChild(e);let t=document.createElement("div");t.style.cssText=`
    display: flex;
    border-bottom: 1px solid #2a2a30;
    padding: 8px 16px;
    gap: 4px;
  `,["Console","State","Actions","Network"].forEach((d,g)=>{let x=document.createElement("button");x.textContent=d,x.dataset.tab=d.toLowerCase(),x.style.cssText=`
      padding: 6px 12px;
      background: ${g===0?"#3b82f6":"transparent"};
      border: none;
      color: ${g===0?"#fff":"#9ca3af"};
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-family: inherit;
    `,x.onclick=()=>N(d.toLowerCase()),t.appendChild(x)}),a.appendChild(t);let o=document.createElement("div");o.id="wt-debug-content",o.style.cssText=`
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    min-height: 300px;
  `,i=document.createElement("div"),i.id="wt-debug-console",i.style.cssText=`
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    line-height: 1.4;
  `,i.innerHTML=`
    <div style="color: #6b7280;">[Debug Console Ready]</div>
    <div style="color: #6b7280;">Press Alt+Shift+D to close this menu</div>
  `,o.appendChild(i),f=document.createElement("div"),f.id="wt-debug-tab-placeholder",f.style.cssText=`
    display: none;
    color: #6b7280;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    line-height: 1.4;
  `,o.appendChild(f),a.appendChild(o);let l=document.createElement("div");l.style.cssText=`
    padding: 8px 16px;
    border-top: 1px solid #2a2a30;
    display: flex;
    gap: 8px;
  `,[{label:"Clear",color:"#6b7280",action:()=>J()},{label:"Export",color:"#22c55e",action:()=>Q()}].forEach(d=>{let g=document.createElement("button");g.textContent=d.label,g.style.cssText=`
      padding: 4px 12px;
      background: transparent;
      border: 1px solid ${d.color};
      color: ${d.color};
      border-radius: 4px;
      cursor: pointer;
      font-size: 10px;
      font-family: inherit;
    `,g.onclick=d.action,l.appendChild(g)}),a.appendChild(l),document.getElementById("widgets").appendChild(a)}function N(e){X=e,a?.querySelectorAll("button[data-tab]")?.forEach(n=>{let o=n.dataset.tab===e;n.style.background=o?"#3b82f6":"transparent",n.style.color=o?"#fff":"#9ca3af"}),i&&f&&(e==="console"?(i.style.display="block",f.style.display="none"):(i.style.display="none",f.style.display="block",f.textContent=`[${e.charAt(0).toUpperCase()+e.slice(1)} Tab - Coming Soon]`))}function J(){i&&(i.innerHTML='<div style="color: #6b7280;">[Console Cleared]</div>')}function Q(){if(j("Exporting logs...","info"),i){let e=i.innerText,t=new Blob([e],{type:"text/plain"}),n=URL.createObjectURL(t),o=document.createElement("a");o.href=n,o.download="weavetab-debug-logs.txt",o.click(),URL.revokeObjectURL(n),j("Logs exported successfully","info")}}function j(e,t="info"){if(!i)return;let n={info:"#60a5fa",warn:"#f59e0b",error:"#ef4444"},o=new Date().toLocaleTimeString(),l=document.createElement("div");l.style.cssText=`
    margin-bottom: 4px;
    color: ${n[t]};
  `;let T=document.createElement("span");T.style.color="#6b7280",T.textContent=`[${o}] `,l.appendChild(T),l.appendChild(document.createTextNode(e)),i.appendChild(l),i.scrollTop=i.scrollHeight}function z(e){m=e,m&&!a&&W(),a&&(a.style.display=m?"flex":"none")}B();G();window.addEventListener("message",e=>{if(!(!e.data||typeof e.data!="object")&&e.data.type==="REHYDRATE"){let t=e.data.state||{},n=t.hudVisible!==!1;V(n),window.parent.postMessage({type:"HUD_STATE_CHANGED",state:{hudVisible:n}},"*"),t.debugMenuVisible!==void 0&&z(t.debugMenuVisible)}});})();
