"use strict";(()=>{var R={};window.wtState=R;window.addEventListener("message",e=>{let{type:t,...o}=e.data;if(t?.startsWith("RT_")){R[t]=o;return}$(t,o)});function $(e,t){e==="REHYDRATE"&&window.dispatchEvent(new CustomEvent("wt-rehydrate",{detail:t}))}var c=document.getElementById("rt-canvas"),s=c.getContext("2d"),g=window.innerWidth/2,u=window.innerHeight/2,D=g,L=u,v=0,T=0,d="idle",S="",E=!0;window.addEventListener("message",function(e){e.data&&e.data.type==="WT_SCRIPTED_PILL_TOGGLE"&&(E=!!e.data.enabled)});var W=[],y=[],q=0,w=0;function O(){c.width=window.innerWidth,c.height=window.innerHeight}window.addEventListener("resize",O);O();var H=.15,A=.6,Y=0,x=0,C=0;var U=0,P=0;function M(){let e=window.wtState||{};e.RT_CURSOR_MOVE&&(g=e.RT_CURSOR_MOVE.x,u=e.RT_CURSOR_MOVE.y,d=e.RT_CURSOR_MOVE.phase||"idle",delete e.RT_CURSOR_MOVE),e.RT_CLICK&&(K(e.RT_CLICK.x,e.RT_CLICK.y,"#3b82f6"),d="clicking",C=Date.now(),setTimeout(()=>{d==="clicking"&&(d="idle")},300),delete e.RT_CLICK),e.RT_SCROLL&&(q=e.RT_SCROLL.y,w=e.RT_SCROLL.ratio,delete e.RT_SCROLL);let t=W.length>0||y.length>0||S||d!=="idle"||Math.abs(g-U)>.5||Math.abs(u-P)>.5;if(U=g,P=u,!t){w>0&&w<1&&(s.clearRect(0,0,c.width,c.height),I()),requestAnimationFrame(M);return}s.clearRect(0,0,c.width,c.height),v+=(g-D)*H,T+=(u-L)*H,v*=A,T*=A;let o=Date.now();if(S&&d!=="typing"&&d!=="clicking"){Y+=.016,x+=.03;let n=3;g+=Math.sin(x)*n,u+=Math.cos(x*.7)*n,Math.random()<.02&&(x+=.5)}if(d==="clicking"&&o-C<300){let r=(Math.random()-.5)*2.5,h=(Math.random()-.5)*2.5;g+=r,u+=h;let l=(o-C)/50;g+=Math.sin(l)*1,u+=Math.cos(l)*1}D+=v,L+=T,E&&N(),E&&I(),requestAnimationFrame(M)}function K(e,t,o){for(let n=0;n<15;n++){let r=Math.random()*Math.PI*2,h=Math.random()*4+1;W.push({x:e,y:t,vx:Math.cos(r)*h,vy:Math.sin(r)*h,life:1,color:o})}for(let n=0;n<3;n++)setTimeout(()=>{y.push({x:e,y:t,radius:0,alpha:1})},n*100)}function N(){for(let e=y.length-1;e>=0;e--){let t=y[e];if(t.radius+=3,t.alpha-=.015,t.alpha<=0){y.splice(e,1);continue}s.beginPath(),s.arc(t.x,t.y,t.radius,0,Math.PI*2),s.strokeStyle=`rgba(59, 130, 246, ${t.alpha})`,s.lineWidth=3,s.shadowColor="#3b82f6",s.shadowBlur=10,s.stroke()}}function I(){if(w<=0||w>=1)return;let e=4,t=60,o=c.width-e-10,n=10+(c.height-t-20)*w;s.fillStyle="rgba(59, 130, 246, 0.5)",s.beginPath(),s.roundRect(o,n,e,t,2),s.fill()}requestAnimationFrame(M);var p=!0;function F(){window.addEventListener("message",e=>{e.data.type==="TOGGLE_HUD"&&B()}),window.toggleHUD=B}function B(){p=!p;let e=document.getElementById("rt-canvas"),t=document.getElementById("widgets");e&&(e.style.display=p?"block":"none"),t&&(t.style.display=p?"block":"none"),window.parent.postMessage({type:"HUD_STATE_CHANGED",state:{hudVisible:p}},"*")}function G(e){p=e;let t=document.getElementById("rt-canvas"),o=document.getElementById("widgets");t&&(t.style.display=p?"block":"none"),o&&(o.style.display=p?"block":"none")}var b=!1,a=null,i=null,X="console";function z(){console.log("[Weavetab HUD] Debug menu initialized"),window.addEventListener("message",e=>{console.log("[Weavetab HUD] Received message:",e.data.type),e.data.type==="TOGGLE_DEBUG"&&(console.log("[Weavetab HUD] Toggling debug menu"),V())}),window.toggleDebugMenu=V,console.log("[Weavetab HUD] Debug menu ready - use Ctrl+F3 or WeaveTabHUD.toggleDebugMenu()")}function V(){console.log("[Weavetab HUD] toggleDebugMenu called, current state:",b),b=!b,a||(console.log("[Weavetab HUD] Creating debug menu container"),J()),a&&(a.style.display=b?"flex":"none",console.log("[Weavetab HUD] Debug menu visibility set to:",b)),window.parent.postMessage({type:"HUD_STATE_CHANGED",state:{debugMenuVisible:b}},"*")}function J(){a=document.createElement("div"),a.id="wt-debug-menu",a.style.cssText=`
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
    <span style="color: #6b7280; font-size: 10px;">Ctrl+F3 to toggle</span>
  `,a.appendChild(e);let t=document.createElement("div");t.style.cssText=`
    display: flex;
    border-bottom: 1px solid #2a2a30;
    padding: 8px 16px;
    gap: 4px;
  `,["Console","State","Actions","Network"].forEach((l,f)=>{let m=document.createElement("button");m.textContent=l,m.dataset.tab=l.toLowerCase(),m.style.cssText=`
      padding: 6px 12px;
      background: ${f===0?"#3b82f6":"transparent"};
      border: none;
      color: ${f===0?"#fff":"#9ca3af"};
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-family: inherit;
    `,m.onclick=()=>Q(l.toLowerCase()),t.appendChild(m)}),a.appendChild(t);let n=document.createElement("div");n.id="wt-debug-content",n.style.cssText=`
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
    <div style="color: #6b7280;">Press Ctrl+F3 to close this menu</div>
    <div style="color: #6b7280; margin-top: 8px;">Use browserAsk to test messaging system</div>
  `,n.appendChild(i),a.appendChild(n);let r=document.createElement("div");r.style.cssText=`
    padding: 8px 16px;
    border-top: 1px solid #2a2a30;
    display: flex;
    gap: 8px;
  `,[{label:"Clear",color:"#6b7280",action:()=>Z()},{label:"Test Ask",color:"#3b82f6",action:()=>ee()},{label:"Export",color:"#22c55e",action:()=>te()}].forEach(l=>{let f=document.createElement("button");f.textContent=l.label,f.style.cssText=`
      padding: 4px 12px;
      background: transparent;
      border: 1px solid ${l.color};
      color: ${l.color};
      border-radius: 4px;
      cursor: pointer;
      font-size: 10px;
      font-family: inherit;
    `,f.onclick=l.action,r.appendChild(f)}),a.appendChild(r),document.getElementById("widgets").appendChild(a)}function Q(e){X=e,a?.querySelectorAll("button[dataset-tab]")?.forEach(o=>{let n=o.dataset.tab===e;o.style.background=n?"#3b82f6":"transparent",o.style.color=n?"#fff":"#9ca3af"}),i&&(e==="console"?i.style.display="block":(i.style.display="none",i.innerHTML=`<div style="color: #6b7280;">[${e.charAt(0).toUpperCase()+e.slice(1)} Tab - Coming Soon]</div>`))}function Z(){i&&(i.innerHTML='<div style="color: #6b7280;">[Console Cleared]</div>')}function ee(){_("Testing ask system...","info"),window.parent.postMessage({type:"TEST_ASK_SYSTEM"},"*")}function te(){if(_("Exporting logs...","info"),i){let e=i.innerText,t=new Blob([e],{type:"text/plain"}),o=URL.createObjectURL(t),n=document.createElement("a");n.href=o,n.download="weavetab-debug-logs.txt",n.click(),URL.revokeObjectURL(o),_("Logs exported successfully","info")}}function _(e,t="info"){if(!i)return;let o={info:"#60a5fa",warn:"#f59e0b",error:"#ef4444"},n=new Date().toLocaleTimeString(),r=document.createElement("div");r.style.cssText=`
    margin-bottom: 4px;
    color: ${o[t]};
  `,r.innerHTML=`<span style="color: #6b7280;">[${n}]</span> ${e}`,i.appendChild(r),i.scrollTop=i.scrollHeight}function j(e){b=e,a&&(a.style.display=b?"flex":"none")}var ne=!1;function k(){try{ne=window.parent.__wt_devMode===!0}catch(e){console.log("[Weavetab HUD] Could not check devMode:",e)}}F();z();k();window.addEventListener("message",e=>{e.data.type==="WT_CONFIG_UPDATE"&&k()});window.addEventListener("message",e=>{if(e.data.type==="REHYDRATE"){let t=e.data.state||{};t.hudVisible!==void 0&&G(t.hudVisible),t.debugMenuVisible!==void 0&&j(t.debugMenuVisible),k(),window.dispatchEvent(new CustomEvent("wt-rehydrate",{detail:t}))}});window.WeaveTabHUD={};})();
