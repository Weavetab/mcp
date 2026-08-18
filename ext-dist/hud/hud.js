"use strict";(()=>{var U={};window.wtState=U;window.addEventListener("message",e=>{let{type:t,...i}=e.data;if(t?.startsWith("RT_")){U[t]=i;return}K(t,i)});function K(e,t){e==="REHYDRATE"&&window.dispatchEvent(new CustomEvent("wt-rehydrate",{detail:t}))}var d=document.getElementById("rt-canvas"),n=d.getContext("2d"),u=window.innerWidth/2,p=window.innerHeight/2,E=u,M=p,w=0,m=0,r="idle",k="",W=!1,L=!0,X=!1;window.addEventListener("message",function(e){e.data&&(e.data.type==="WT_SIDEPANEL_STATE"&&(W=!!e.data.open,W&&(k="")),e.data.type==="WT_SUPPRESS_THOUGHT_HUD"&&(X=!0,k=""),e.data.type==="WT_SCRIPTED_PILL_TOGGLE"&&(L=!!e.data.enabled))});var a=[],v=[],_=[],J=0,y=0;function G(){d.width=window.innerWidth,d.height=window.innerHeight}window.addEventListener("resize",G);G();var I=.15,O=.6,Q=0,C=0,R=0,S=0,D=0,F=0,z=0;function A(){let e=window.wtState||{};e.RT_CURSOR_MOVE&&(u=e.RT_CURSOR_MOVE.x,p=e.RT_CURSOR_MOVE.y,r=e.RT_CURSOR_MOVE.phase||"idle",delete e.RT_CURSOR_MOVE),e.RT_CLICK&&(Z(e.RT_CLICK.x,e.RT_CLICK.y,"#3b82f6"),r="clicking",R=Date.now(),setTimeout(()=>{r==="clicking"&&(r="idle")},300),delete e.RT_CLICK),e.RT_SCROLL&&(J=e.RT_SCROLL.y,y=e.RT_SCROLL.ratio,delete e.RT_SCROLL);let t=v.length>0||_.length>0||k||r!=="idle"||Math.abs(u-F)>.5||Math.abs(p-z)>.5;if(F=u,z=p,!t){y>0&&y<1&&(n.clearRect(0,0,d.width,d.height),B()),requestAnimationFrame(A);return}n.clearRect(0,0,d.width,d.height),w+=(u-E)*I,m+=(p-M)*I,w*=O,m*=O;let i=Date.now();if(k&&r!=="typing"&&r!=="clicking"){Q+=.016,C+=.03;let o=3;u+=Math.sin(C)*o,p+=Math.cos(C*.7)*o,Math.random()<.02&&(C+=.5)}if(r==="clicking"&&i-R<300){let c=(Math.random()-.5)*2.5,x=(Math.random()-.5)*2.5;u+=c,p+=x;let g=(i-R)/50;u+=Math.sin(g)*1,p+=Math.cos(g)*1}E+=w,M+=m,L&&(a.push({x:E,y:M,age:0}),a.length>60&&a.shift(),ee(),te(),ne(),ie()),L&&B(),requestAnimationFrame(A)}function Z(e,t,i){for(let o=0;o<15;o++){let c=Math.random()*Math.PI*2,x=Math.random()*4+1;v.push({x:e,y:t,vx:Math.cos(c)*x,vy:Math.sin(c)*x,life:1,color:i})}for(let o=0;o<3;o++)setTimeout(()=>{_.push({x:e,y:t,radius:0,alpha:1})},o*100)}function ee(){if(a.length<2)return;n.beginPath(),n.moveTo(a[0].x,a[0].y);for(let t=1;t<a.length-1;t++){let i=(a[t].x+a[t+1].x)/2,o=(a[t].y+a[t+1].y)/2;n.quadraticCurveTo(a[t].x,a[t].y,i,o)}n.lineTo(a[a.length-1].x,a[a.length-1].y);let e=n.createLinearGradient(a[0].x,a[0].y,a[a.length-1].x,a[a.length-1].y);r==="idle"?(e.addColorStop(0,"rgba(255, 255, 255, 0)"),e.addColorStop(1,"rgba(255, 255, 255, 0.6)")):(e.addColorStop(0,"rgba(59, 130, 246, 0)"),e.addColorStop(1,"rgba(59, 130, 246, 0.9)")),n.strokeStyle=e,n.lineWidth=4,n.lineCap="round",n.stroke();for(let t=a.length-1;t>=0;t--)a[t].age+=.04,a[t].age>1&&a.splice(t,1)}function te(){for(let e=v.length-1;e>=0;e--){let t=v[e];if(t.x+=t.vx,t.y+=t.vy,t.vy+=.1,t.life-=.03,t.life<=0){v.splice(e,1);continue}n.beginPath(),n.arc(t.x,t.y,Math.max(.5,t.life*3),0,Math.PI*2),n.fillStyle=`rgba(59, 130, 246, ${t.life})`,n.fill()}}function ne(){for(let e=_.length-1;e>=0;e--){let t=_[e];if(t.radius+=3,t.alpha-=.015,t.alpha<=0){_.splice(e,1);continue}n.beginPath(),n.arc(t.x,t.y,t.radius,0,Math.PI*2),n.strokeStyle=`rgba(59, 130, 246, ${t.alpha})`,n.lineWidth=3,n.shadowColor="#3b82f6",n.shadowBlur=10,n.stroke()}}function ie(){if(n.save(),n.translate(E,M),Math.sqrt(w*w+m*m)>.5){let i=Math.atan2(m,w);n.rotate(i)}n.beginPath();let t=r==="clicking"?.75:r==="typing"?.85:1;if(n.scale(t,t),n.moveTo(14,0),n.lineTo(0,7),n.lineTo(-14,0),n.lineTo(0,-7),n.closePath(),r==="idle"?(n.fillStyle="#ffffff",n.strokeStyle="#ffffff"):(n.fillStyle="#3b82f6",n.strokeStyle="#ffffff"),n.fill(),n.lineWidth=3,n.shadowColor=r==="idle"?"#ffffff":"#3b82f6",n.shadowBlur=20,n.stroke(),n.beginPath(),n.moveTo(8,0),n.lineTo(0,4),n.lineTo(-8,0),n.lineTo(0,-4),n.closePath(),n.fillStyle=r==="idle"?"rgba(255, 255, 255, 0.8)":"rgba(59, 130, 246, 0.8)",n.fill(),r==="typing"){D+=.016,D>.5&&(D=0,S=(S+1)%4),n.save(),n.translate(20,0),n.fillStyle="#3b82f6",n.font="bold 16px monospace",n.shadowColor="#3b82f6",n.shadowBlur=10;let i=".".repeat(S);n.fillText(i,0,5),n.restore()}n.restore()}function B(){if(y<=0||y>=1)return;let e=4,t=60,i=d.width-e-10,o=10+(d.height-t-20)*y;n.fillStyle="rgba(59, 130, 246, 0.5)",n.beginPath(),n.roundRect(i,o,e,t,2),n.fill()}requestAnimationFrame(A);var f=!0;function q(){window.addEventListener("message",e=>{e.data.type==="TOGGLE_HUD"&&V()}),window.toggleHUD=V}function V(){f=!f;let e=document.getElementById("rt-canvas"),t=document.getElementById("widgets");e&&(e.style.display=f?"block":"none"),t&&(t.style.display=f?"block":"none"),window.parent.postMessage({type:"HUD_STATE_CHANGED",state:{hudVisible:f}},"*")}function j(e){f=e;let t=document.getElementById("rt-canvas"),i=document.getElementById("widgets");t&&(t.style.display=f?"block":"none"),i&&(i.style.display=f?"block":"none")}var b=!1,l=null,s=null,oe="console";function Y(){console.log("[Weavetab HUD] Debug menu initialized"),window.addEventListener("message",e=>{console.log("[Weavetab HUD] Received message:",e.data.type),e.data.type==="TOGGLE_DEBUG"&&(console.log("[Weavetab HUD] Toggling debug menu"),$())}),window.toggleDebugMenu=$,console.log("[Weavetab HUD] Debug menu ready - use Ctrl+F3 or WeaveTabHUD.toggleDebugMenu()")}function $(){console.log("[Weavetab HUD] toggleDebugMenu called, current state:",b),b=!b,l||(console.log("[Weavetab HUD] Creating debug menu container"),ae()),l&&(l.style.display=b?"flex":"none",console.log("[Weavetab HUD] Debug menu visibility set to:",b)),window.parent.postMessage({type:"HUD_STATE_CHANGED",state:{debugMenuVisible:b}},"*")}function ae(){l=document.createElement("div"),l.id="wt-debug-menu",l.style.cssText=`
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
  `,l.appendChild(e);let t=document.createElement("div");t.style.cssText=`
    display: flex;
    border-bottom: 1px solid #2a2a30;
    padding: 8px 16px;
    gap: 4px;
  `,["Console","State","Actions","Network"].forEach((g,h)=>{let T=document.createElement("button");T.textContent=g,T.dataset.tab=g.toLowerCase(),T.style.cssText=`
      padding: 6px 12px;
      background: ${h===0?"#3b82f6":"transparent"};
      border: none;
      color: ${h===0?"#fff":"#9ca3af"};
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-family: inherit;
    `,T.onclick=()=>se(g.toLowerCase()),t.appendChild(T)}),l.appendChild(t);let o=document.createElement("div");o.id="wt-debug-content",o.style.cssText=`
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    min-height: 300px;
  `,s=document.createElement("div"),s.id="wt-debug-console",s.style.cssText=`
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    line-height: 1.4;
  `,s.innerHTML=`
    <div style="color: #6b7280;">[Debug Console Ready]</div>
    <div style="color: #6b7280;">Press Ctrl+F3 to close this menu</div>
    <div style="color: #6b7280; margin-top: 8px;">Use browserAsk to test messaging system</div>
  `,o.appendChild(s),l.appendChild(o);let c=document.createElement("div");c.style.cssText=`
    padding: 8px 16px;
    border-top: 1px solid #2a2a30;
    display: flex;
    gap: 8px;
  `,[{label:"Clear",color:"#6b7280",action:()=>re()},{label:"Test Ask",color:"#3b82f6",action:()=>le()},{label:"Export",color:"#22c55e",action:()=>ce()}].forEach(g=>{let h=document.createElement("button");h.textContent=g.label,h.style.cssText=`
      padding: 4px 12px;
      background: transparent;
      border: 1px solid ${g.color};
      color: ${g.color};
      border-radius: 4px;
      cursor: pointer;
      font-size: 10px;
      font-family: inherit;
    `,h.onclick=g.action,c.appendChild(h)}),l.appendChild(c),document.getElementById("widgets").appendChild(l)}function se(e){oe=e,l?.querySelectorAll("button[dataset-tab]")?.forEach(i=>{let o=i.dataset.tab===e;i.style.background=o?"#3b82f6":"transparent",i.style.color=o?"#fff":"#9ca3af"}),s&&(e==="console"?s.style.display="block":(s.style.display="none",s.innerHTML=`<div style="color: #6b7280;">[${e.charAt(0).toUpperCase()+e.slice(1)} Tab - Coming Soon]</div>`))}function re(){s&&(s.innerHTML='<div style="color: #6b7280;">[Console Cleared]</div>')}function le(){H("Testing ask system...","info"),window.parent.postMessage({type:"TEST_ASK_SYSTEM"},"*")}function ce(){if(H("Exporting logs...","info"),s){let e=s.innerText,t=new Blob([e],{type:"text/plain"}),i=URL.createObjectURL(t),o=document.createElement("a");o.href=i,o.download="weavetab-debug-logs.txt",o.click(),URL.revokeObjectURL(i),H("Logs exported successfully","info")}}function H(e,t="info"){if(!s)return;let i={info:"#60a5fa",warn:"#f59e0b",error:"#ef4444"},o=new Date().toLocaleTimeString(),c=document.createElement("div");c.style.cssText=`
    margin-bottom: 4px;
    color: ${i[t]};
  `,c.innerHTML=`<span style="color: #6b7280;">[${o}]</span> ${e}`,s.appendChild(c),s.scrollTop=s.scrollHeight}function N(e){b=e,l&&(l.style.display=b?"flex":"none")}var ge=!1;function P(){try{ge=window.parent.__wt_devMode===!0}catch(e){console.log("[Weavetab HUD] Could not check devMode:",e)}}q();Y();P();window.addEventListener("message",e=>{e.data.type==="WT_CONFIG_UPDATE"&&P()});window.addEventListener("message",e=>{if(e.data.type==="REHYDRATE"){let t=e.data.state||{};t.hudVisible!==void 0&&j(t.hudVisible),t.debugMenuVisible!==void 0&&N(t.debugMenuVisible),P(),window.dispatchEvent(new CustomEvent("wt-rehydrate",{detail:t}))}});window.WeaveTabHUD={};})();
