"use strict";(()=>{var S={};window.wtState=S;window.addEventListener("message",e=>{let{type:t,...i}=e.data;if(t?.startsWith("RT_")){S[t]=i;return}$(t,i)});function $(e,t){e==="REHYDRATE"&&window.dispatchEvent(new CustomEvent("wt-rehydrate",{detail:t}))}var c=document.getElementById("rt-canvas"),s=c.getContext("2d"),d=window.innerWidth/2,u=window.innerHeight/2,D=d,L=u,v=0,_=0,g="idle",T="",A=!1,E=!0,Y=!1;window.addEventListener("message",function(e){e.data&&(e.data.type==="WT_SIDEPANEL_STATE"&&(A=!!e.data.open,A&&(T="")),e.data.type==="WT_SUPPRESS_THOUGHT_HUD"&&(Y=!0,T=""),e.data.type==="WT_SCRIPTED_PILL_TOGGLE"&&(E=!!e.data.enabled))});var W=[],y=[],N=0,h=0;function F(){c.width=window.innerWidth,c.height=window.innerHeight}window.addEventListener("resize",F);F();var H=.15,P=.6,K=0,x=0,C=0;var U=0,I=0;function M(){let e=window.wtState||{};e.RT_CURSOR_MOVE&&(d=e.RT_CURSOR_MOVE.x,u=e.RT_CURSOR_MOVE.y,g=e.RT_CURSOR_MOVE.phase||"idle",delete e.RT_CURSOR_MOVE),e.RT_CLICK&&(X(e.RT_CLICK.x,e.RT_CLICK.y,"#3b82f6"),g="clicking",C=Date.now(),setTimeout(()=>{g==="clicking"&&(g="idle")},300),delete e.RT_CLICK),e.RT_SCROLL&&(N=e.RT_SCROLL.y,h=e.RT_SCROLL.ratio,delete e.RT_SCROLL);let t=W.length>0||y.length>0||T||g!=="idle"||Math.abs(d-U)>.5||Math.abs(u-I)>.5;if(U=d,I=u,!t){h>0&&h<1&&(s.clearRect(0,0,c.width,c.height),O()),requestAnimationFrame(M);return}s.clearRect(0,0,c.width,c.height),v+=(d-D)*H,_+=(u-L)*H,v*=P,_*=P;let i=Date.now();if(T&&g!=="typing"&&g!=="clicking"){K+=.016,x+=.03;let n=3;d+=Math.sin(x)*n,u+=Math.cos(x*.7)*n,Math.random()<.02&&(x+=.5)}if(g==="clicking"&&i-C<300){let r=(Math.random()-.5)*2.5,w=(Math.random()-.5)*2.5;d+=r,u+=w;let l=(i-C)/50;d+=Math.sin(l)*1,u+=Math.cos(l)*1}D+=v,L+=_,E&&J(),E&&O(),requestAnimationFrame(M)}function X(e,t,i){for(let n=0;n<15;n++){let r=Math.random()*Math.PI*2,w=Math.random()*4+1;W.push({x:e,y:t,vx:Math.cos(r)*w,vy:Math.sin(r)*w,life:1,color:i})}for(let n=0;n<3;n++)setTimeout(()=>{y.push({x:e,y:t,radius:0,alpha:1})},n*100)}function J(){for(let e=y.length-1;e>=0;e--){let t=y[e];if(t.radius+=3,t.alpha-=.015,t.alpha<=0){y.splice(e,1);continue}s.beginPath(),s.arc(t.x,t.y,t.radius,0,Math.PI*2),s.strokeStyle=`rgba(59, 130, 246, ${t.alpha})`,s.lineWidth=3,s.shadowColor="#3b82f6",s.shadowBlur=10,s.stroke()}}function O(){if(h<=0||h>=1)return;let e=4,t=60,i=c.width-e-10,n=10+(c.height-t-20)*h;s.fillStyle="rgba(59, 130, 246, 0.5)",s.beginPath(),s.roundRect(i,n,e,t,2),s.fill()}requestAnimationFrame(M);var p=!0;function B(){window.addEventListener("message",e=>{e.data.type==="TOGGLE_HUD"&&z()}),window.toggleHUD=z}function z(){p=!p;let e=document.getElementById("rt-canvas"),t=document.getElementById("widgets");e&&(e.style.display=p?"block":"none"),t&&(t.style.display=p?"block":"none"),window.parent.postMessage({type:"HUD_STATE_CHANGED",state:{hudVisible:p}},"*")}function G(e){p=e;let t=document.getElementById("rt-canvas"),i=document.getElementById("widgets");t&&(t.style.display=p?"block":"none"),i&&(i.style.display=p?"block":"none")}var b=!1,a=null,o=null,Q="console";function q(){console.log("[Weavetab HUD] Debug menu initialized"),window.addEventListener("message",e=>{console.log("[Weavetab HUD] Received message:",e.data.type),e.data.type==="TOGGLE_DEBUG"&&(console.log("[Weavetab HUD] Toggling debug menu"),V())}),window.toggleDebugMenu=V,console.log("[Weavetab HUD] Debug menu ready - use Ctrl+F3 or WeaveTabHUD.toggleDebugMenu()")}function V(){console.log("[Weavetab HUD] toggleDebugMenu called, current state:",b),b=!b,a||(console.log("[Weavetab HUD] Creating debug menu container"),Z()),a&&(a.style.display=b?"flex":"none",console.log("[Weavetab HUD] Debug menu visibility set to:",b)),window.parent.postMessage({type:"HUD_STATE_CHANGED",state:{debugMenuVisible:b}},"*")}function Z(){a=document.createElement("div"),a.id="wt-debug-menu",a.style.cssText=`
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
    `,m.onclick=()=>ee(l.toLowerCase()),t.appendChild(m)}),a.appendChild(t);let n=document.createElement("div");n.id="wt-debug-content",n.style.cssText=`
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    min-height: 300px;
  `,o=document.createElement("div"),o.id="wt-debug-console",o.style.cssText=`
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    line-height: 1.4;
  `,o.innerHTML=`
    <div style="color: #6b7280;">[Debug Console Ready]</div>
    <div style="color: #6b7280;">Press Ctrl+F3 to close this menu</div>
    <div style="color: #6b7280; margin-top: 8px;">Use browserAsk to test messaging system</div>
  `,n.appendChild(o),a.appendChild(n);let r=document.createElement("div");r.style.cssText=`
    padding: 8px 16px;
    border-top: 1px solid #2a2a30;
    display: flex;
    gap: 8px;
  `,[{label:"Clear",color:"#6b7280",action:()=>te()},{label:"Test Ask",color:"#3b82f6",action:()=>ne()},{label:"Export",color:"#22c55e",action:()=>ie()}].forEach(l=>{let f=document.createElement("button");f.textContent=l.label,f.style.cssText=`
      padding: 4px 12px;
      background: transparent;
      border: 1px solid ${l.color};
      color: ${l.color};
      border-radius: 4px;
      cursor: pointer;
      font-size: 10px;
      font-family: inherit;
    `,f.onclick=l.action,r.appendChild(f)}),a.appendChild(r),document.getElementById("widgets").appendChild(a)}function ee(e){Q=e,a?.querySelectorAll("button[dataset-tab]")?.forEach(i=>{let n=i.dataset.tab===e;i.style.background=n?"#3b82f6":"transparent",i.style.color=n?"#fff":"#9ca3af"}),o&&(e==="console"?o.style.display="block":(o.style.display="none",o.innerHTML=`<div style="color: #6b7280;">[${e.charAt(0).toUpperCase()+e.slice(1)} Tab - Coming Soon]</div>`))}function te(){o&&(o.innerHTML='<div style="color: #6b7280;">[Console Cleared]</div>')}function ne(){R("Testing ask system...","info"),window.parent.postMessage({type:"TEST_ASK_SYSTEM"},"*")}function ie(){if(R("Exporting logs...","info"),o){let e=o.innerText,t=new Blob([e],{type:"text/plain"}),i=URL.createObjectURL(t),n=document.createElement("a");n.href=i,n.download="weavetab-debug-logs.txt",n.click(),URL.revokeObjectURL(i),R("Logs exported successfully","info")}}function R(e,t="info"){if(!o)return;let i={info:"#60a5fa",warn:"#f59e0b",error:"#ef4444"},n=new Date().toLocaleTimeString(),r=document.createElement("div");r.style.cssText=`
    margin-bottom: 4px;
    color: ${i[t]};
  `,r.innerHTML=`<span style="color: #6b7280;">[${n}]</span> ${e}`,o.appendChild(r),o.scrollTop=o.scrollHeight}function j(e){b=e,a&&(a.style.display=b?"flex":"none")}var oe=!1;function k(){try{oe=window.parent.__wt_devMode===!0}catch(e){console.log("[Weavetab HUD] Could not check devMode:",e)}}B();q();k();window.addEventListener("message",e=>{e.data.type==="WT_CONFIG_UPDATE"&&k()});window.addEventListener("message",e=>{if(e.data.type==="REHYDRATE"){let t=e.data.state||{};t.hudVisible!==void 0&&G(t.hudVisible),t.debugMenuVisible!==void 0&&j(t.debugMenuVisible),k(),window.dispatchEvent(new CustomEvent("wt-rehydrate",{detail:t}))}});window.WeaveTabHUD={};})();
